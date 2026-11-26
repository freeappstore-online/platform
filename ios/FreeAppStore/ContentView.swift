import AuthenticationServices
import CoreLocation
import SwiftUI
import UIKit

/// Screen state and actions, the iOS counterpart of MainActivity.kt.
@MainActor
final class CompanionModel: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    let repository: CompanionRepository
    let collector: LocationCollector
    private var local: LocalStore { repository.local }

    @Published private(set) var signedIn = false
    /// The device connection expired or was revoked (#638): history stays readable, Reconnect pairs again.
    @Published private(set) var expired = false
    /// Days until the connection expires, only when under 7 (#638).
    @Published private(set) var expiresInDays: Int?
    @Published private(set) var name = ""
    @Published private(set) var deviceLabel = ""
    @Published private(set) var apps: [ConnectedApp] = []
    @Published private(set) var blocked: Set<String> = []
    @Published private(set) var pausedApps: Set<String> = []
    @Published private(set) var paused = true
    @Published private(set) var queued = 0
    @Published private(set) var message = ""
    @Published private(set) var pairingCode = ""
    @Published private(set) var lastSync: Int64 = 0
    @Published private(set) var lastSyncAttempt: Int64 = 0
    @Published private(set) var lastSyncError = ""
    @Published private(set) var events: [ShareEvent] = []
    @Published private(set) var pendingByApp: [String: Int] = [:]
    @Published private(set) var lastUploadByApp: [String: Int64] = [:]
    @Published private(set) var busy = false
    @Published var consent: ConnectedApp?
    // Contribute (#733).
    let contribute: ContributeRunner
    @Published private(set) var contributeApps: Set<String> = []
    @Published private(set) var modelState = ModelState.none
    @Published private(set) var contributions: [Contribution] = []
    @Published private(set) var contributedToday: [String: Int] = [:]
    /// `freeappstore://native/contribute/<id>`: asks before opting in, never opts in by itself.
    @Published var linkedContribute: String?
    private var error = ""
    private var authSession: ASWebAuthenticationSession?
    private var refreshTask: Task<Void, Never>?

    override convenience init() {
        let local: LocalStore
        do { local = try LocalStore() } catch { fatalError("FreeAppStore could not open its storage.") }
        self.init(repository: CompanionRepository(local: local))
    }

    /// Tests pass a repository with a temporary store and a stubbed API.
    init(repository: CompanionRepository, contribute: ContributeRunner? = nil) {
        self.repository = repository
        collector = LocationCollector(repository: repository)
        self.contribute = contribute ?? ContributeRunner(repository: repository)
        super.init()
        if repository.token() != nil { try? local.seedIfEmpty() }
        refresh()
    }

    /// An expired connection's grants are gone on the server: nothing is enabled until the user re-enables it.
    func enabled(_ app: ConnectedApp) -> Bool { !expired && app.grantId != nil && !blocked.contains(app.id) }
    /// Enabled, not paused for this app, and Pause all is off.
    func sharing(_ app: ConnectedApp) -> Bool { enabled(app) && !pausedApps.contains(app.id) && !paused }
    /// The app's state chip; `running` is the collector's.
    func state(_ app: ConnectedApp, running: Bool) -> SharingState {
        if expired { return .expired }
        return SharingState.of(granted: app.grantId != nil, blocked: blocked.contains(app.id), appPaused: pausedApps.contains(app.id), pausedAll: paused, running: running)
    }

    func refresh() {
        signedIn = repository.token() != nil
        expired = local.expired
        expiresInDays = signedIn ? CompanionRepository.expiresInDays(local.deviceExpiresAt) : nil
        name = local.userName; deviceLabel = local.deviceLabel; apps = local.apps(); blocked = local.blocked(); pausedApps = local.pausedApps(); paused = local.paused
        queued = (try? local.count()) ?? 0; lastSync = local.lastSync; pairingCode = repository.pairingCode()
        lastSyncAttempt = local.lastSyncAttempt; lastSyncError = local.lastSyncError
        events = (try? local.events()) ?? []
        pendingByApp = Dictionary(uniqueKeysWithValues: apps.map { ($0.id, (try? local.pendingCount($0.id)) ?? 0) })
        lastUploadByApp = apps.reduce(into: [:]) { $0[$1.id] = try? local.lastUpload($1.id) }
        contributeApps = local.contributeApps()
        modelState = contribute.kokoro.installed ? .installed : local.modelWanted ? .waiting : .none
        contributions = (try? local.contributions()) ?? []
        let today = SharingTimeline.today().lowerBound
        contributedToday = Dictionary(uniqueKeysWithValues: contributeApps.map { ($0, (try? local.contributedSince($0, from: today)) ?? 0) })
        message = error.isEmpty ? local.message : error
    }

    func becameActive() {
        refresh(); collector.evaluate()
        refreshTask?.cancel()
        refreshTask = Task {
            await catchUp()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                refresh()
            }
        }
    }

    /// Leaving the app mid-run ends Run now shortly; the background run is asked for straight away to carry on (#819).
    func resignActive() { refreshTask?.cancel(); contribute.schedule(soon: contribute.running) }

    /// Finishes a pending connection, then syncs. A connection error is shown until the next activation; sync
    /// failures are left to `local.message`, which every later successful sync clears, background ones included.
    func catchUp() async {
        do {
            _ = try await repository.finishSignIn()
            error = ""
        } catch { self.error = error.localizedDescription }
        if repository.token() != nil {
            try? await repository.sync()
            await contribute.refreshVerdicts()
        }
        contribute.schedule() // pairing finished, or the sync found the connection expired
        refresh(); collector.evaluate()
    }

    private func act(_ action: @escaping () async throws -> Void) {
        if busy { return }
        busy = true; error = ""
        Task {
            do { try await action() }
            catch let failure as ApiFailure where failure.status == 401 {} // the expired card says it
            catch { self.error = error.localizedDescription }
            busy = false; refresh(); collector.evaluate()
        }
    }

    func connect() { act { [self] in try await pair() } }

    /// Pairs again without wiping the history (#638): after an expiry, or early from the Settings warning.
    func reconnect() {
        act { [self] in
            try await repository.renew()
            refresh(); collector.evaluate()
            try await pair()
        }
    }

    private func pair() async throws {
        let label = "\(UIDevice.current.model) (iOS \(UIDevice.current.systemVersion))"
        let url = try await repository.startSignIn(label: label)
        refresh()
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "freeappstore") { [weak self] _, _ in
            // Callback or cancel: the exchange itself decides whether the browser approved.
            Task { @MainActor in self?.completeSignIn() }
        }
        session.prefersEphemeralWebBrowserSession = true
        session.presentationContextProvider = self
        authSession = session
        guard session.start() else { throw CompanionError("Could not open the FreeAppStore sign-in page. Try again.") }
    }

    func completeSignIn() { act { [self] in _ = try await repository.finishSignIn() } }

    /// Links never grant anything: they finish a pending connection or bring a disclosure forward.
    func handle(_ url: URL) {
        guard url.scheme == "freeappstore", url.host == "native" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        if parts == ["connected"] { completeSignIn() }
        else if parts.count == 2, parts[0] == "apps", let app = apps.first(where: { $0.id == parts[1] }), !enabled(app) { consent = app }
        else if parts.count == 2, parts[0] == "contribute", Self.appId.firstMatch(in: parts[1], range: NSRange(location: 0, length: parts[1].utf16.count)) != nil {
            linkedContribute = parts[1]
        }
    }

    private static let appId = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]{0,62}$")

    // MARK: Contribute (#733)

    /// Opting in asks for the voice model too; a run downloads it (in the background only on a non-cellular network).
    func setContributing(_ appId: String, _ on: Bool) {
        do {
            try local.setContributing(appId, on)
            if on && !contribute.kokoro.installed { local.modelWanted = true }
        } catch { self.error = error.localizedDescription }
        contribute.schedule(); refresh()
    }
    func downloadModel() { local.modelWanted = true; contribute.runNow(); refresh() }
    func deleteModel() {
        local.modelWanted = false
        contribute.stop()
        let kokoro = contribute.kokoro
        Task.detached { kokoro.delete() }
        contribute.schedule(); refresh()
    }
    func contributeNow() { contribute.runNow(); refresh() }
    func stopContributing() { contribute.stop(); refresh() }

    func enable(_ app: ConnectedApp) {
        act { [self] in
            try await repository.enable(app)
            if collector.authorization == .notDetermined { collector.requestWhenInUse() }
        }
    }
    func disable(_ app: ConnectedApp) { act { [self] in try await repository.disable(app) } }
    func sync() { act { [self] in try await repository.sync() } }
    func disconnect() {
        act { [self] in
            try local.setPaused(true); collector.evaluate()
            contribute.stop()
            try await repository.disconnect()
            contribute.schedule()
        }
    }
    func setPaused(_ value: Bool) {
        do { try local.setPaused(value) } catch { self.error = error.localizedDescription }
        if !value && collector.authorization == .notDetermined { collector.requestWhenInUse() }
        refresh(); collector.evaluate()
    }

    /// Local only: the queue, and so pending uploads, are kept.
    func clearHistory() {
        do { try local.clearHistory() } catch { self.error = error.localizedDescription }
        refresh()
    }

    /// Local writes, not `act`: pausing works offline and instantly.
    func pause(_ app: ConnectedApp) {
        do { try local.pause(app.id) } catch { self.error = error.localizedDescription }
        refresh(); collector.evaluate()
    }
    func resume(_ app: ConnectedApp) {
        do { try local.resume(app.id) } catch { self.error = error.localizedDescription }
        refresh(); collector.evaluate()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
}

/// The tab shell. Sheets, deep links and the scene phase live here so they work from every tab.
struct ContentView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var collector: LocationCollector
    @ObservedObject var catalogue: CatalogueStore
    @Environment(\.scenePhase) private var phase
    @State private var tab: Tab

    enum Tab { case store, sharing, contribute, settings }

    /// Without `tab`: Sharing when any app has a grant or the connection expired, otherwise Store.
    init(model: CompanionModel, collector: LocationCollector, catalogue: CatalogueStore, tab: Tab? = nil) {
        self.model = model
        self.collector = collector
        self.catalogue = catalogue
        _tab = State(initialValue: tab ?? (model.expired || model.apps.contains(where: model.enabled) ? .sharing : .store))
    }

    var body: some View {
        TabView(selection: $tab) {
            StorefrontView(model: model, catalogue: catalogue)
                .tabItem { Label("Store", systemImage: "square.grid.2x2") }
                .tag(Tab.store)
            SharingDashboardView(model: model, collector: collector)
                .tabItem { Label("Sharing", systemImage: "location.circle") }
                .tag(Tab.sharing)
            ContributeView(model: model, runner: model.contribute, catalogue: catalogue)
                .tabItem { Label("Contribute", systemImage: "waveform") }
                .tag(Tab.contribute)
            SettingsView(model: model, collector: collector)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .onChange(of: phase, initial: true) { _, phase in
            if phase == .active {
                model.becameActive()
                Task { await catalogue.refresh() }
            } else { model.resignActive() }
        }
        .onOpenURL { model.handle($0) }
        .sheet(item: $model.consent) { app in disclosure(app) }
        .contributeAlert(name: model.linkedContribute.map(catalogue.name) ?? "", isPresented: Binding(
            get: { model.signedIn && model.linkedContribute != nil },
            set: { if !$0 { model.linkedContribute = nil } }
        )) {
            if let id = model.linkedContribute { model.setContributing(id, true) }
        }
    }

    private func disclosure(_ app: ConnectedApp) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Enable location for \(app.name)?").font(.title2.bold())
            Text(app.disclosure)
            Button("Enable for \(app.name)") { model.consent = nil; model.enable(app) }.buttonStyle(.borderedProminent).disabled(model.busy)
            Button("Cancel") { model.consent = nil }
            Spacer()
        }
        .padding(24)
        .presentationDetents([.medium, .large])
    }
}

/// Busy spinner and the last error, shown at the top of each tab.
struct StatusMessages: View {
    @ObservedObject var model: CompanionModel

    var body: some View {
        if model.busy { ProgressView().frame(maxWidth: .infinity) }
        if !model.message.isEmpty { Text(model.message).foregroundStyle(.red) }
    }
}

/// The expired connection (#638): one way back that keeps the history.
struct ExpiredCard: View {
    @ObservedObject var model: CompanionModel

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Label("Connection expired", systemImage: "link.badge.plus").font(.title3.bold())
                Text("This phone is no longer connected to FreeAppStore, so location sharing has stopped. Your sharing history stays on this phone. Reconnect, then turn sharing back on for each app.")
                    .font(.subheadline)
                Button("Reconnect") { model.reconnect() }.buttonStyle(.borderedProminent).disabled(model.busy)
                if !model.pairingCode.isEmpty { Text("Match this code in your browser: \(model.pairingCode)").font(.footnote) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
    }
}
