import BackgroundTasks
import Foundation
import OSLog
import UIKit

/// Contribute (#733), the iOS counterpart of the Android ContributeWorker: downloads the voice model when asked, then
/// works through the opted-in apps' open jobs, one app at a time in turn. Runs as a BGProcessingTask, which iOS starts
/// only while the phone is on external power with a network connection, and on Run now while the app is open. iOS ending
/// either (the task's expiration, or the app leaving the foreground) stops the job in hand without uploading it; a Run
/// now cut short that way asks for the background run at once, and claims nothing more once the app has left the screen
/// (#828). The server refuses a claim once the day's contribution limit is reached; the run then ends. Each run logs how
/// it ended.
@MainActor
final class ContributeRunner: ObservableObject {
    static let taskId = "online.freeappstore.companion.contribute"
    private static let logger = Logger(subsystem: "online.freeappstore.companion", category: "Contribute")

    /// What the run is doing, nil while idle.
    @Published private(set) var status: String?
    /// The app whose job is in hand, while generating.
    @Published private(set) var app: String?
    /// The last run's failure, until the next run starts. In memory only.
    @Published private(set) var lastError = ""
    /// The run is waiting for the phone to cool down.
    @Published private(set) var cooling = false
    /// The job in hand (#820): its key, sentences done of all, and audio seconds made per second of work.
    @Published private(set) var job: String?
    @Published private(set) var sentences: (done: Int, total: Int)?
    @Published private(set) var speed: Double?
    /// The voice model download, 0...1, while downloading.
    @Published private(set) var downloaded: Double?
    /// Why the last run stopped before it ran out of work (a `StopFlag` reason), until the next run starts. In memory only.
    @Published private(set) var lastStop: String?
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

    /// Asks iOS for a background run while paired with something to do: an app opted in, or the model asked for. `soon`
    /// (a Run now cut short by leaving the app, #819) asks for it as soon as iOS allows rather than in 15 minutes; it
    /// still needs external power and a network connection.
    func schedule(soon: Bool = false) {
        let todo = !local.contributeApps().isEmpty || (local.modelWanted && !kokoro.installed)
        guard repository.token() != nil, todo else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskId)
            return
        }
        let request = BGProcessingTaskRequest(identifier: Self.taskId)
        request.requiresExternalPower = local.chargingOnly
        request.requiresNetworkConnectivity = true
        request.earliestBeginDate = soon ? nil : Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handle(_ task: BGProcessingTask) {
        schedule() // the next one
        let flag = StopFlag()
        task.expirationHandler = { flag.stop("background_expired") }
        Task {
            // A Run now that just lost the foreground ends at its next sentence; this run then takes over.
            while running && !flag.stopped { try? await Task.sleep(for: .seconds(1)) }
            await run(flag, background: true)
            task.setTaskCompleted(success: !flag.stopped)
        }
    }

    /// Runs now, while the app is open, with the screen kept awake: auto-lock would send the app to the background,
    /// where iOS ends the extra time after about 30 seconds. When that cuts the run short, the background run is asked
    /// for straight away (#819), so the work goes on once the phone is charging.
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
        // Out of the foreground only seconds are left: the job in hand may finish, but none is claimed after it.
        let left = StopFlag()
        let observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            left.stop("left_app")
        }
        Task {
            await run(flag, background: false, mayClaim: { !left.stopped })
            NotificationCenter.default.removeObserver(observer)
            if flag.reason == "background_expired" { schedule(soon: true) }
            UIApplication.shared.isIdleTimerDisabled = idle
            if id.value != .invalid { UIApplication.shared.endBackgroundTask(id.value) }
        }
    }

    /// Ends the current run after the job in hand stops, without uploading it.
    func stop() { stopFlag?.stop("user_stop") }

    /// The server's verdicts on this phone's contributions. A refresh only.
    /// Discovery (#820): open jobs this phone could run now, by app.
    func openJobs() async throws -> [String: Int] { try await client.open(model: KokoroModel.id) }

    /// Every app with a job on this phone's record, opted in or not (#820).
    func refreshVerdicts() async {
        for app in local.contributeApps().union((try? local.contributionApps()) ?? []).sorted() { try? await refresh(app, keepGoing: { true }) }
    }

    /// One app's verdicts, tried again after passing network failures (#819).
    private func refresh(_ app: String, keepGoing: () -> Bool) async throws {
        let (client, local) = (client, local)
        try await NetworkRetry().attempts(keepGoing: keepGoing) { try await client.refresh(app, log: local) }
    }

    private func run(_ flag: StopFlag, background: Bool, mayClaim: @escaping () -> Bool = { true }) async {
        guard stopFlag == nil, repository.token() != nil else { return }
        stopFlag = flag
        lastError = ""
        lastStop = nil
        let began = Date()
        var submitted = 0
        var failed: String?
        defer {
            let end = flag.reason ?? failed ?? (mayClaim() ? "no_work" : "left_app")
            Self.logger.notice("Run ended: \(end, privacy: .public) · \(submitted) submitted (\(background ? "background task" : "run now", privacy: .public), \(Int(Date().timeIntervalSince(began))) s)")
        }
        defer { stopFlag = nil; status = nil; app = nil; cooling = false; job = nil; sentences = nil; speed = nil; downloaded = nil; lastStop = flag.reason }
        // A background run asked for external power: unplugging stops it (iOS would end it soon anyway).
        UIDevice.current.isBatteryMonitoringEnabled = true
        let unplugged = background && local.chargingOnly ? NotificationCenter.default.addObserver(
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
                    Task { @MainActor in
                        self.status = "Downloading the voice model · \(bytes * 100 / KokoroModel.downloadBytes)%"
                        self.downloaded = min(Double(bytes) / Double(KokoroModel.downloadBytes), 1)
                    }
                }, keepGoing: keepGoing)
                downloaded = nil
            }
            let apps = local.contributeApps().sorted()
            guard kokoro.installed, !apps.isEmpty else { return }
            status = "Looking for jobs"
            let synth = KokoroSynthesizer(files: kokoro)
            defer { synth.close() }
            let local = self.local
            for app in apps {
                if !keepGoing() { break }
                do { try await refresh(app, keepGoing: keepGoing) } catch let failure as ApiFailure where failure.status == 401 { throw failure } catch {}
            }
            let started = Box(Date())
            let (path, appState) = (NetworkPath(), AppBackground()) // what each attempt's record says of the phone (#827)
            let contributor = Contributor(client: client, log: local, synth: synth, encoder: { try AacEncoder(url: $0, sampleRate: $1) },
                                          workDir: FileManager.default.temporaryDirectory, stopReason: { flag.reason ?? "stopped" }, hot: hot,
                                          sentence: { done, total, audio in
                let elapsed = Date().timeIntervalSince(started.value)
                Task { @MainActor in
                    self.sentences = (done, total)
                    self.speed = done > 0 && elapsed > 0 ? audio / elapsed : nil
                }
            }, probes: .phone(path: path, background: { background || appState.now }), audio: AttemptAudio(dir: AttemptAudio.defaultDirectory))
            submitted = try await contributor.run(apps, keepGoing: keepGoing, optedIn: { local.contributeApps().contains($0) }, mayClaim: mayClaim) { app, job in
                started.value = Date()
                Task { @MainActor in self.app = app; self.job = job.key; self.sentences = nil; self.speed = nil; self.status = "Generating \(job.key)" }
            }
        } catch let failure as ApiFailure where failure.status == 401 {
            failed = "401"
            try? await repository.sync() // the connection expired: the sync marks it, and the expired card says so
        } catch {
            lastError = error.localizedDescription
            failed = ((error as? ApiFailure).map { "\($0.status) " } ?? "") + lastError
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
