import BackgroundTasks
import Foundation
import OSLog
import UIKit
import UserNotifications

/// Contribute (#733), the iOS counterpart of the Android ContributeWorker: downloads the voice model when asked, then
/// works through the opted-in apps' open jobs, one app at a time in turn. Runs as a BGProcessingTask, which iOS starts
/// only while the phone is on external power with a network connection, and on Run now while the app is open. iOS ending
/// either (the task's expiration, or the app leaving the foreground) stops the job in hand without uploading it; a Run
/// now cut short that way asks for the background run at once, and claims nothing more once the app has left the screen
/// (#828). The server refuses a claim once the day's contribution limit is reached; the run then ends. Each run logs how
/// it ended. iOS alone decides when a background run starts and how long it lasts (#836): this asks for the next one
/// straight away when a run ends with jobs left and when the phone is plugged in while the app runs, otherwise in 15
/// minutes. The mode and conditions (#830) are this phone's: Off cancels every request until turned on again; in Auto a
/// background run checks the conditions before each claim and between sentences, and stops the job in hand (unless nearly
/// done) when one fails. Run now ignores them, apart from pausing while hot.
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
    /// The run in hand is the background task, not Run now.
    @Published private(set) var background = false
    let kokoro: KokoroModel
    /// The phone's power and network, for the conditions.
    let watch: DeviceWatch
    private let repository: CompanionRepository
    private let client: GenerationClient
    private var stopFlag: StopFlag?
    private var local: LocalStore { repository.local }

    var running: Bool { stopFlag != nil }

    /// Copy diagnostics (#813): the capability report, how the last run ended, the settings and the latest jobs' records.
    func diagnostics() -> String {
        let prefs = local.contributePrefs
        let rows = (try? local.contributions(limit: Diagnostics.jobs)) ?? []
        return Diagnostics.text(Diagnostics.report(capabilities: Diagnostics.capabilities(kokoro: kokoro, cpu: prefs.cpu, now: watch.now(hot: DeviceWatch.hot)),
                                                   lastStop: lastStop, lastError: lastError, prefs: prefs, contributions: rows, now: Date()))
    }

    init(repository: CompanionRepository, kokoro: KokoroModel = KokoroModel(), api: FasApi = FasApi(resourceTimeout: 600)) {
        self.repository = repository
        self.kokoro = kokoro
        watch = DeviceWatch()
        client = GenerationClient(api: api, credential: { [repository] in repository.token() })
    }

    /// Before the end of launch, as BGTaskScheduler requires. Plugging the phone in while the app runs asks for a
    /// background run straight away (#836); iOS still decides when it starts, most often once the phone is locked.
    func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.taskId, using: .main) { [weak self] task in
            MainActor.assumeIsolated { self?.handle(task as! BGProcessingTask) }
        }
        NotificationCenter.default.addObserver(forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, Self.pluggedIn, !self.running else { return }
                self.schedule(soon: true)
            }
        }
    }

    /// The phone is on external power: charging, or full while plugged in.
    static var pluggedIn: Bool { [.charging, .full].contains(UIDevice.current.batteryState) }

    /// Whether a background run that ended with `end` asks for the next one straight away rather than in 15 minutes
    /// (#836): iOS ended it, or it ended with a job not done and jobs may be left. Never after nothing to claim, a
    /// failure (the daily limit among them) or Stop, so the phone does not spin.
    nonisolated static func again(end: String, drained: Bool) -> Bool {
        switch end {
        case "background_expired": true
        case "no_work": !drained
        default: false
        }
    }

    /// Asks iOS for a background run while paired with something to do (an app opted in, or the model asked for) and not
    /// Off (#830). `soon` (a Run now cut short by leaving the app, #819) asks for it as soon as iOS allows rather than in 15
    /// minutes; it still needs a network connection, and external power unless the conditions allow battery.
    func schedule(soon: Bool = false) {
        let todo = !local.contributeApps().isEmpty || (local.modelWanted && !kokoro.installed)
        let prefs = local.contributePrefs
        guard repository.token() != nil, todo, prefs.mode != .off else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskId)
            return
        }
        let request = BGProcessingTaskRequest(identifier: Self.taskId)
        request.requiresExternalPower = prefs.chargingOnly
        request.requiresNetworkConnectivity = true
        request.earliestBeginDate = soon ? nil : Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(request) } catch {
            // Not fatal (the simulator always refuses; too many pending requests): the next schedule() asks again
            Self.logger.error("Background run not requested: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Saves the mode and conditions (#830). Off stops the job in hand and cancels the background request; nothing starts
    /// again until it is turned on.
    func apply(_ prefs: ContributePrefs) {
        local.contributePrefs = prefs
        if prefs.mode == .off { stopFlag?.stop("off") }
        if !prefs.summary { UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [Self.summaryId]) }
        schedule()
    }

    /// Mobile data used this month, MB (#830).
    func cellularMB() -> Int64 { local.cellularBytes(month: ContributeConditions.month(Date())) / 1_000_000 }

    /// Why Contribute would not run in the background now (#830), or nil when every condition holds.
    func pause() -> ContributePause? {
        let prefs = local.contributePrefs
        var now = watch.now(hot: DeviceWatch.hot)
        let rows = (try? local.contributions(limit: 100_000, since: SharingTimeline.today().lowerBound)) ?? []
        (now.jobsToday, now.minutesToday) = ContributeConditions.usage(rows)
        now.cellularBytes = local.cellularBytes(month: ContributeConditions.month(now.date))
        return ContributeConditions.pause(prefs, now)
    }

    private func handle(_ task: BGProcessingTask) {
        guard local.contributePrefs.mode != .off else { // a request left from before Off
            task.setTaskCompleted(success: true)
            return
        }
        schedule() // the next one
        let flag = StopFlag()
        task.expirationHandler = { flag.stop("background_expired") }
        Task {
            // A Run now that just lost the foreground ends at its next sentence; this run then takes over.
            while running && !flag.stopped { try? await Task.sleep(for: .seconds(1)) }
            if await run(flag, background: true) { schedule(soon: true) } // jobs left (#836): as soon as iOS allows
            await summarize()
            task.setTaskCompleted(success: !flag.stopped)
        }
    }

    /// Runs now, while the app is open, with the screen kept awake: auto-lock would send the app to the background,
    /// where iOS ends the extra time after about 30 seconds. When that cuts the run short, the background run is asked
    /// for straight away (#819), so the work goes on once the phone is charging.
    func runNow() {
        guard !running else { return }
        var prefs = local.contributePrefs
        if prefs.mode == .off { prefs.mode = .auto; apply(prefs) } // Run now turns Off back to Auto
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
            _ = await run(flag, background: false, mayClaim: { !left.stopped })
            NotificationCenter.default.removeObserver(observer)
            if flag.reason == "background_expired" { schedule(soon: true) }
            UIApplication.shared.isIdleTimerDisabled = idle
            if id.value != .invalid { UIApplication.shared.endBackgroundTask(id.value) }
        }
    }

    /// Ends the current run after the job in hand stops, without uploading it.
    func stop() { stopFlag?.stop("user_stop") }

    /// Discovery (#820): open jobs this phone could run now, by app.
    func backlog() async throws -> GenerationBacklog { try await client.backlog() }

    func openJobs() async throws -> [String: Int] { try await client.open(model: KokoroModel.id) }

    /// The server's verdicts on this phone's contributions, for every app with a job on this phone's record, opted in or
    /// not (#820). A refresh only.
    func refreshVerdicts() async {
        for app in local.contributeApps().union((try? local.contributionApps()) ?? []).sorted() { try? await refresh(app, keepGoing: { true }) }
    }

    /// Sends this phone's report on one of its uploads (#831) and keeps it with the row.
    func report(_ contribution: Contribution, good: Bool, note: String) async throws -> SubmissionReport {
        let report = try await client.report(contribution.appId, submissionId: contribution.submissionId, good: good, note: note)
        try local.saveReport(contribution.jobId, report)
        return report
    }

    /// One app's verdicts, tried again after passing network failures (#819).
    private func refresh(_ app: String, keepGoing: () -> Bool) async throws {
        let (client, local) = (client, local)
        try await NetworkRetry().attempts(keepGoing: keepGoing) { try await client.refresh(app, log: local) }
    }

    /// Whether the next background run should start as soon as iOS allows (`again`).
    private func run(_ flag: StopFlag, background: Bool, mayClaim: @escaping () -> Bool = { true }) async -> Bool {
        guard stopFlag == nil, repository.token() != nil else { return false }
        stopFlag = flag
        self.background = background
        lastError = ""
        lastStop = nil
        // No job is in progress outside a run (#835): one left `generating` is closed as interrupted, now and at the end.
        try? local.closeInterrupted()
        defer { try? local.closeInterrupted() }
        let began = Date()
        var submitted = 0
        var failed: String?
        var drained = true
        var paused: String? // the condition that ended the run (#830)
        func end() -> String { flag.reason ?? failed ?? paused ?? (mayClaim() ? "no_work" : "left_app") }
        defer {
            let reason = end()
            Self.logger.notice("Run ended: \(reason, privacy: .public) · \(submitted) submitted (\(background ? "background task" : "run now", privacy: .public), \(Int(Date().timeIntervalSince(began))) s)")
        }
        defer { stopFlag = nil; self.background = false; status = nil; app = nil; cooling = false; job = nil; sentences = nil; speed = nil; downloaded = nil; lastStop = flag.reason ?? paused }
        let keepGoing: () -> Bool = { !flag.stopped }
        let prefs = local.contributePrefs
        let capabilities = Diagnostics.text(Diagnostics.capabilities(kokoro: kokoro, cpu: prefs.cpu, now: watch.now(hot: DeviceWatch.hot)))
        Self.logger.notice("Capabilities: \(capabilities, privacy: .public)")
        // The conditions (#830), in the background only: Run now ignores them. Heat is left to `hot`, which waits.
        let store = self.local
        let watch = self.watch
        let usage = Box((jobs: 0, minutes: 0, at: Date.distantPast))
        let pause: () -> String? = background ? {
            var now = watch.now(hot: false)
            if Date().timeIntervalSince(usage.value.at) > 30 { // today's usage, read at most every 30 s
                let rows = (try? store.contributions(limit: 100_000, since: SharingTimeline.today().lowerBound)) ?? []
                let (jobs, minutes) = ContributeConditions.usage(rows)
                usage.value = (jobs, minutes, Date())
            }
            (now.jobsToday, now.minutesToday) = (usage.value.jobs, usage.value.minutes)
            now.cellularBytes = store.cellularBytes(month: ContributeConditions.month(now.date))
            return ContributeConditions.pause(prefs, now)?.reason
        } : { nil }
        if let reason = pause() { // nothing to do until it holds; the next request is already in
            paused = reason
            return false
        }
        // Mobile data counted on this phone (#830): the model download and uploads.
        let cellular: (Int64) -> Void = { bytes in
            if watch.path.type == "cellular" { store.addCellular(bytes, month: ContributeConditions.month(Date())) }
        }
        // While a Run now is on screen, "run slower" uses the Light setting.
        let effort = ContributePrefs.effort(!background && prefs.inUse == .slower ? .light : prefs.cpu)
        // Best effort: while the phone is hot (thermal state serious or critical) the work waits, and goes on once it is
        // back to fair or nominal; unless the thermal condition is turned off.
        let hot: () -> Bool = { [weak self] in
            let hot = prefs.thermal && DeviceWatch.hot
            Task { @MainActor in if self?.cooling != hot { self?.cooling = hot } }
            return hot
        }
        do {
            if local.modelWanted && !kokoro.installed {
                status = "Downloading the voice model"
                let counted = Box(Int64(0))
                _ = try await kokoro.install(cellular: !background || prefs.cellular, progress: { bytes in
                    cellular(bytes - counted.value)
                    counted.value = bytes
                    Task { @MainActor in
                        self.status = "Downloading the voice model · \(bytes * 100 / KokoroModel.downloadBytes)%"
                        self.downloaded = min(Double(bytes) / Double(KokoroModel.downloadBytes), 1)
                    }
                }, keepGoing: { keepGoing() && pause() == nil })
                downloaded = nil
            }
            let apps = local.contributeApps().sorted()
            guard kokoro.installed, !apps.isEmpty else { return false }
            status = "Looking for jobs"
            let synth = KokoroSynthesizer(files: kokoro, threads: effort.threads)
            defer { synth.close() }
            for app in apps {
                if !keepGoing() { break }
                do { try await refresh(app, keepGoing: keepGoing) } catch let failure as ApiFailure where failure.status == 401 { throw failure } catch {
                    // The run goes on; Activity refreshes the verdicts again.
                    Self.logger.error("Verdicts for \(app, privacy: .public) not refreshed: \(error.localizedDescription, privacy: .public)")
                }
            }
            let started = Box(Date())
            let (path, appState) = (NetworkPath(), AppBackground()) // what each attempt's record says of the phone (#827)
            let contributor = Contributor(client: client, log: store, synth: synth, encoder: { try AacEncoder(url: $0, sampleRate: $1) },
                                          workDir: FileManager.default.temporaryDirectory, stopReason: { flag.reason ?? "stopped" }, hot: hot,
                                          sentence: { done, total, audio in
                let elapsed = Date().timeIntervalSince(started.value)
                Task { @MainActor in
                    self.sentences = (done, total)
                    self.speed = done > 0 && elapsed > 0 ? audio / elapsed : nil
                }
            }, probes: .phone(path: path, background: { background || appState.now }), audio: AttemptAudio(dir: AttemptAudio.defaultDirectory),
               pause: pause, rest: effort.rest, uploaded: cellular)
            submitted = try await contributor.run(apps, keepGoing: keepGoing, optedIn: { store.contributeApps().contains($0) }, mayClaim: mayClaim) { app, job in
                started.value = Date()
                Task { @MainActor in self.app = app; self.job = job.key; self.sentences = nil; self.speed = nil; self.status = "Generating \(job.key)" }
            }
            drained = contributor.drained
            paused = contributor.paused
        } catch let failure as ApiFailure where failure.status == 401 {
            failed = "401"
            try? await repository.sync() // the connection expired: the sync marks it, and the expired card says so
        } catch {
            lastError = error.localizedDescription
            failed = ((error as? ApiFailure).map { "\($0.status) " } ?? "") + lastError
        }
        return Self.again(end: end(), drained: drained)
    }
}

// MARK: The overnight summary (#844)

extension ContributeRunner {
    nonisolated static let summaryId = "contribute-summary"

    /// After background work: one quiet notification, due the next morning at 8, saying what was done since the last one
    /// was shown. Each background run brings it up to date; nothing is shown for a night with nothing generated.
    func summarize() async {
        let center = UNUserNotificationCenter.current()
        guard local.contributePrefs.summary, await center.notificationSettings().authorizationStatus == .authorized else { return }
        let now = CompanionRepository.now()
        if local.summaryAt > 0 && local.summaryAt <= now { local.summaryFrom = local.summaryAt } // that one was shown
        if local.summaryFrom == 0 { local.summaryFrom = now - 24 * 3_600_000 }
        guard let rows = try? local.contributions(limit: 100_000, since: local.summaryFrom), let text = ContributeSummary.text(rows) else { return }
        let at = ContributeSummary.morning(after: Date())
        let content = UNMutableNotificationContent()
        content.title = "Contribute"
        content.body = text
        content.interruptionLevel = .passive
        let trigger = UNCalendarNotificationTrigger(dateMatching: Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: at), repeats: false)
        try? await center.add(UNNotificationRequest(identifier: Self.summaryId, content: content, trigger: trigger))
        local.summaryAt = Int64(at.timeIntervalSince1970 * 1000)
    }

    /// Asks for notification permission once, when the summary is on and the user has just done something it is about:
    /// turned it on, or opted in to an app.
    func askForSummaryPermission() {
        guard local.contributePrefs.summary else { return }
        Task {
            let center = UNUserNotificationCenter.current()
            if await center.notificationSettings().authorizationStatus == .notDetermined { _ = try? await center.requestAuthorization(options: [.alert]) }
        }
    }
}

/// Set from an expiration handler, Stop or Off, read between sentences on the generating thread. The first reason is kept
/// for the record: `user_stop`, `background_expired` or `off`.
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
