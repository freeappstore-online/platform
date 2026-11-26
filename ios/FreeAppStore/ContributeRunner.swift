import BackgroundTasks
import Foundation
import UIKit

/// Contribute (#733), the iOS counterpart of the Android ContributeWorker: downloads the voice model when asked, then
/// works through each opted-in app's open jobs. Runs as a BGProcessingTask, which iOS starts only while the phone is on
/// external power with a network connection, and on Run now while the app is open. iOS ending either (the task's
/// expiration, or the app leaving the foreground) stops the job in hand without uploading it.
@MainActor
final class ContributeRunner: ObservableObject {
    static let taskId = "online.freeappstore.companion.contribute"

    /// What the run is doing, nil while idle.
    @Published private(set) var status: String?
    /// The last run's failure, until the next run starts. In memory only.
    @Published private(set) var lastError = ""
    /// The run is waiting for the phone to cool down.
    @Published private(set) var cooling = false
    let kokoro: KokoroModel
    private let repository: CompanionRepository
    private let client: GenerationClient
    private var stopFlag: StopFlag?
    private var local: LocalStore { repository.local }

    var running: Bool { stopFlag != nil }

    init(repository: CompanionRepository, kokoro: KokoroModel = KokoroModel(), api: FasApi = FasApi(resourceTimeout: 600)) {
        self.repository = repository
        self.kokoro = kokoro
        client = GenerationClient(api: api, credential: { [repository] in repository.token() })
    }

    /// Before the end of launch, as BGTaskScheduler requires.
    func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.taskId, using: .main) { [weak self] task in
            MainActor.assumeIsolated { self?.handle(task as! BGProcessingTask) }
        }
    }

    /// Asks iOS for a background run while paired with something to do: an app opted in, or the model asked for.
    func schedule() {
        let todo = !local.contributeApps().isEmpty || (local.modelWanted && !kokoro.installed)
        guard repository.token() != nil, todo else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskId)
            return
        }
        let request = BGProcessingTaskRequest(identifier: Self.taskId)
        request.requiresExternalPower = true
        request.requiresNetworkConnectivity = true
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handle(_ task: BGProcessingTask) {
        schedule() // the next one
        let flag = StopFlag()
        task.expirationHandler = { flag.stop("background_expired") }
        Task {
            await run(flag, background: true)
            task.setTaskCompleted(success: !flag.stopped)
        }
    }

    /// Runs now, while the app is open, with the screen kept awake: auto-lock would send the app to the background,
    /// where iOS ends the extra time after about 30 seconds.
    func runNow() {
        guard !running else { return }
        let flag = StopFlag()
        let id = Box(UIBackgroundTaskIdentifier.invalid)
        id.value = UIApplication.shared.beginBackgroundTask(withName: "Contribute") {
            flag.stop("background_expired")
            UIApplication.shared.endBackgroundTask(id.value)
            id.value = .invalid
        }
        let idle = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
        Task {
            await run(flag, background: false)
            UIApplication.shared.isIdleTimerDisabled = idle
            if id.value != .invalid { UIApplication.shared.endBackgroundTask(id.value) }
        }
    }

    /// Ends the current run after the job in hand stops, without uploading it.
    func stop() { stopFlag?.stop("user_stop") }

    /// The server's verdicts on this phone's contributions. A refresh only.
    func refreshVerdicts() async {
        for app in local.contributeApps() { try? await client.refresh(app, log: local) }
    }

    private func run(_ flag: StopFlag, background: Bool) async {
        guard stopFlag == nil, repository.token() != nil else { return }
        stopFlag = flag
        lastError = ""
        defer { stopFlag = nil; status = nil; cooling = false }
        // A background run needs external power: unplugging stops it (iOS would end it soon anyway).
        UIDevice.current.isBatteryMonitoringEnabled = true
        let unplugged = background ? NotificationCenter.default.addObserver(
            forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main) { _ in
            if UIDevice.current.batteryState == .unplugged { flag.stop("unplugged") }
        } : nil
        defer { unplugged.map(NotificationCenter.default.removeObserver) }
        let keepGoing: () -> Bool = { !flag.stopped }
        // Best effort: while the phone is hot (thermal state serious or critical) the work waits, and goes on once it is
        // back to fair or nominal.
        let hot: () -> Bool = { [weak self] in
            let hot = ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue
            Task { @MainActor in if self?.cooling != hot { self?.cooling = hot } }
            return hot
        }
        do {
            if local.modelWanted && !kokoro.installed {
                status = "Downloading the voice model"
                _ = try await kokoro.install(cellular: !background, progress: { bytes in
                    Task { @MainActor in self.status = "Downloading the voice model · \(bytes * 100 / KokoroModel.downloadBytes)%" }
                }, keepGoing: keepGoing)
            }
            let apps = local.contributeApps().sorted()
            guard kokoro.installed, !apps.isEmpty else { return }
            status = "Looking for jobs"
            let synth = KokoroSynthesizer(files: kokoro)
            defer { synth.close() }
            let local = self.local
            for app in apps {
                if !keepGoing() { break }
                do { try await client.refresh(app, log: local) } catch let failure as ApiFailure where failure.status == 401 { throw failure } catch {}
                let contributor = Contributor(client: client, log: local, synth: synth, encoder: { try AacEncoder(url: $0, sampleRate: $1) },
                                              workDir: FileManager.default.temporaryDirectory,
                                              stopReason: { flag.reason ?? (local.contributeApps().contains(app) ? "stopped" : "opted_out") }, hot: hot)
                _ = try await contributor.run(app, keepGoing: { keepGoing() && local.contributeApps().contains(app) }) { job in
                    Task { @MainActor in self.status = "Generating \(job.key)" }
                }
            }
        } catch let failure as ApiFailure where failure.status == 401 {
            try? await repository.sync() // the connection expired: the sync marks it, and the expired card says so
        } catch {
            lastError = error.localizedDescription
        }
    }
}

/// Set from an expiration handler, Stop or unplugging, read between sentences on the generating thread. The first reason
/// is kept for the record: `user_stop`, `background_expired` or `unplugged`.
final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    var reason: String? { lock.withLock { value } }
    var stopped: Bool { reason != nil }
    func stop(_ reason: String) { lock.withLock { if value == nil { value = reason } } }
}

private final class Box<T> {
    var value: T
    init(_ value: T) { self.value = value }
}
