import SwiftUI
import UIKit

/// The voice model on this phone (#733).
enum ModelState { case none, waiting, installed }

enum ContributeText {
    /// What opting in means, shown before an app is turned on.
    static func disclosure(_ name: String) -> String {
        "This phone will take \(name)'s open jobs, such as narrating a chapter, generate each one with an on-device voice model "
            + "and upload the result to FreeAppStore under your account. It only ever generates exactly what \(name)'s publisher "
            + "asked for, never anything you type, and FreeAppStore checks every upload before anyone hears it. It needs a "
            + "\(KokoroModel.downloadBytes / 1_000_000) MB voice model, and it runs in the background only while this phone is "
            + "charging and online (you can change that in Contribute settings), or while FreeAppStore is open on screen after you tap Run now."
    }

    /// The labels of `Contribution.status`.
    static let labels = [
        "generating": "In progress", "uploading": "Uploading", "pending": "Being checked", "accepted": "Accepted", "rejected": "Rejected",
        "superseded": "Not needed", "skipped": "Skipped", "failed": "Failed",
    ]

    /// Why a job was skipped, when this phone stopped it; other reasons are shown as recorded.
    static let reasons = [
        "user_stop": "you tapped Stop",
        "background_expired": "FreeAppStore left the screen or iOS ended its background time; it carries on while charging",
        "unplugged": "the phone was unplugged", "opted_out": "the app was turned off", "lease_expired": "the job's time ran out",
        "stopped": "stopped", "language": "this phone can't speak the set's language in that voice",
        "network": "no connection to FreeAppStore before the job's time ran out",
        "interrupted": "FreeAppStore was closed or stopped before the job finished",
        // A condition that failed (#830).
        "off": "you turned Contribute off", "quiet_hours": "quiet hours began", "daily_max": "today's maximum was reached",
        "no_network": "the connection was lost", "mobile_data": "the phone moved to mobile data", "data_cap": "this month's mobile data was used",
        "battery_low": "the battery fell below your minimum", "low_power": "Low Power Mode came on", "thermal": "the phone was hot",
    ]

    /// The status card's headline and why (#820). `downloading`: the run is fetching the voice model. `pause`: why it
    /// would not run in the background now (#830), Off included.
    static func state(running: Bool, cooling: Bool, downloading: Bool, hasApps: Bool, model: ModelState, lastStop: String?,
                      pause: ContributePause?, charging: Bool) -> (title: String, why: String) {
        if running {
            if cooling { return ("Paused", "The phone is hot. It goes on by itself once it cools down.") }
            return ("Running", downloading ? "Downloading the voice model." : "Generating audio on this phone.")
        }
        if pause == .off { return ("Off", ContributePause.off.text) }
        if !hasApps { return ("Idle", "No apps turned on. Turn one on in settings, on an app's page in the Store, or from an app that asks for help.") }
        switch model {
        case .none: return ("Idle", "The voice model isn't on this phone. Download it in settings.")
        case .waiting: return ("Waiting", "The voice model downloads while the phone charges on Wi-Fi, or tap Run now.")
        case .installed: break
        }
        if let pause { return (pause == .noNetwork ? "Waiting" : "Paused", pause.text) }
        if let lastStop { return ("Stopped", "Stopped because \(reasons[lastStop] ?? lastStop).") }
        if charging {
            return ("Auto", "Plugged in. iOS decides when background runs start and how long they last, most often with the phone locked. "
                + "When one ends with jobs left, FreeAppStore asks iOS for the next straight away.")
        }
        return ("Auto", "Runs in the background when iOS allows, most often while the phone charges.")
    }
}

/// The Activity filter (#820), and which statuses each one shows. In progress (#835): the job being generated now.
enum ContributeFilter: String, CaseIterable, Identifiable {
    case all = "All", inProgress = "In progress", accepted = "Accepted", checking = "Checking", rejected = "Rejected", notDone = "Not done"
    var id: Self { self }

    static func of(_ status: String) -> ContributeFilter {
        switch status {
        case "generating": .inProgress
        case "accepted": .accepted
        case "uploading", "pending": .checking
        case "rejected": .rejected
        default: .notDone // skipped, failed, superseded
        }
    }

    func shows(_ status: String) -> Bool { self == .all || Self.of(status) == self }
}

extension CatalogueStore {
    /// The app's name from the store, or its id.
    func name(_ id: String) -> String { apps.first { $0.id == id }?.name ?? id }
}

extension View {
    /// Asks before opting in to contribute to `name`.
    func contributeAlert(name: String, isPresented: Binding<Bool>, confirm: @escaping () -> Void) -> some View {
        alert("Contribute to \(name)?", isPresented: isPresented) {
            Button("Contribute") { confirm() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(ContributeText.disclosure(name))
        }
    }
}

/// A per-app switch whose turning on asks first.
struct ContributeToggle: View {
    let appId: String
    let name: String
    @ObservedObject var model: CompanionModel
    @State private var ask = false

    var body: some View {
        AdaptiveToggle(title: "Contribute from this phone", isOn: Binding(
            get: { model.contributeApps.contains(appId) },
            set: { on in if on { ask = true } else { model.setContributing(appId, false) } }
        ))
        .contributeAlert(name: name, isPresented: $ask) { model.setContributing(appId, true) }
    }
}

/// A toggle whose switch goes under its label at accessibility text sizes, so the label never breaks inside a word.
struct AdaptiveToggle: View {
    let title: String
    @Binding var isOn: Bool
    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
        if size.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                Toggle(title, isOn: $isOn).labelsHidden()
            }
        } else {
            Toggle(title, isOn: $isOn)
        }
    }
}

/// The Contribute tab (#820): what the run is doing, and today's results, each opening Activity filtered. Settings sit
/// behind the gear.
struct ContributeView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var runner: ContributeRunner
    @ObservedObject var catalogue: CatalogueStore
    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    StatusMessages(model: model)
                    Text("Help apps you use by generating their audio on this phone, such as narration for Books. Apps publish the jobs; your phone does the work while it charges.")
                    if model.signedIn {
                        status
                        today
                        GenerationBacklogView(runner: runner, catalogue: catalogue)
                    } else {
                        Button("Sign in to FreeAppStore") { model.connect() }.buttonStyle(.borderedProminent).disabled(model.busy)
                        PairByCode(model: model)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("Contribute")
            .navigationDestination(isPresented: $model.showActivity) { ContributeActivityView(model: model, catalogue: catalogue) }
            .toolbar {
                if model.signedIn {
                    NavigationLink { ContributeSettingsView(model: model, runner: runner, catalogue: catalogue) } label: {
                        Label("Contribute settings", systemImage: "gearshape")
                    }
                }
            }
        }
        .onAppear { UIDevice.current.isBatteryMonitoringEnabled = true }
    }

    /// Auto, Run now or Off (#830). Run now is one run that ignores the conditions, then Auto again.
    enum Mode: String, CaseIterable, Identifiable { case auto = "Auto", runNow = "Run now", off = "Off"; var id: Self { self } }

    private var mode: Binding<Mode> {
        Binding(get: { model.prefs.mode == .off ? .off : runner.running && !runner.background ? .runNow : .auto }, set: { mode in
            var prefs = model.prefs
            switch mode {
            case .auto:
                if runner.running && !runner.background { model.stopContributing() }
                prefs.mode = .auto; model.setPrefs(prefs)
            case .runNow: model.contributeNow()
            case .off: prefs.mode = .off; model.setPrefs(prefs)
            }
        })
    }

    private var status: some View {
        let state = ContributeText.state(running: runner.running, cooling: runner.cooling, downloading: runner.downloaded != nil,
                                         hasApps: !model.contributeApps.isEmpty, model: model.modelState, lastStop: runner.lastStop,
                                         pause: runner.pause(), charging: [.charging, .full].contains(UIDevice.current.batteryState))
        return GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Picker("Mode", selection: mode) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                Text(state.title).font(.title3.bold())
                Text(state.why).foregroundStyle(runner.running && runner.cooling || state.title == "Paused" ? .orange : .secondary)
                if let app = runner.app, let job = runner.job {
                    Text("\(catalogue.name(app)) · \(job)").font(.headline)
                }
                if let sentences = runner.sentences, sentences.total > 0 {
                    ProgressView(value: Double(sentences.done), total: Double(sentences.total)) {
                        Text("Sentence \(min(sentences.done + 1, sentences.total)) of \(sentences.total)")
                    } currentValueLabel: {
                        if let speed = runner.speed { Text("\(speed.formatted(.number.precision(.fractionLength(1))))× real time") }
                    }
                }
                if let downloaded = runner.downloaded {
                    ProgressView(value: downloaded) { Text("Voice model \(Int(downloaded * 100))%") }
                }
                if !runner.lastError.isEmpty { Text(runner.lastError).foregroundStyle(.red) }
                Text("Auto runs in the background whenever your conditions in settings hold. Run now ignores them for one run, needs FreeAppStore open on screen and keeps the screen on meanwhile; leaving the app stops the job in hand without uploading. Off stops everything until you turn it on.")
                    .font(.footnote).foregroundStyle(.secondary)
                if runner.running {
                    Button("Stop") { model.stopContributing() }.buttonStyle(.bordered)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Today's jobs by Activity filter, as tappable chips.
    @ViewBuilder private var today: some View {
        Text("Today").font(.title3.bold())
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .top), count: size.isAccessibilitySize ? 1 : 2),
                  alignment: .leading, spacing: 12) {
            ForEach(ContributeFilter.allCases.filter { $0 != .all }) { filter in
                NavigationLink { ContributeActivityView(model: model, catalogue: catalogue, filter: filter) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(model.todayCounts.filter { filter.shows($0.key) }.values.reduce(0, +))").font(.title2.bold())
                        Text(filter.rawValue).font(.subheadline)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityElement(children: .combine)
                }
                .buttonStyle(.plain)
            }
        }
        NavigationLink("All activity") { ContributeActivityView(model: model, catalogue: catalogue) }
    }
}

/// A preview only: refreshing never claims or starts a job.
private struct GenerationBacklogView: View {
    let runner: ContributeRunner
    @ObservedObject var catalogue: CatalogueStore
    @State private var backlog: GenerationBacklog?
    @State private var loading = true
    @State private var error: String?
    @State private var refresh = 0
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Text("Up next · awaiting generation").font(.headline)
                Text("Up to 100 jobs available to your account, oldest first. Only enabled apps run; other devices may take these jobs, so the order can change.").font(.footnote).foregroundStyle(.secondary)
                Button("Refresh backlog") { refresh += 1 }.disabled(loading)
                if loading { ProgressView("Loading awaiting jobs…") }
                if let error { Text(error).foregroundStyle(.red) }
                if !loading, error == nil, let backlog {
                    Text(backlog.jobs.isEmpty ? "No jobs are awaiting generation for your account." : "Showing \(backlog.jobs.count)\(backlog.hasMore ? " of more than 100" : "") awaiting jobs.").font(.footnote)
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(backlog.jobs.enumerated()), id: \.element.id) { index, job in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(index + 1). \(catalogue.name(job.appId)) · \(job.key)").font(.subheadline.bold())
                                Text("\(job.model) \(job.modelVersion) · \(job.inputChars) characters").font(.caption).foregroundStyle(.secondary)
                                Text(job.inputPreview).font(.subheadline)
                                Divider()
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.task(id: refresh) {
            loading = true; error = nil
            do {
                let result = try await runner.backlog()
                guard !Task.isCancelled else { return }
                backlog = result
            } catch {
                guard !Task.isCancelled else { return }
                self.error = "Couldn't load awaiting jobs. Try Refresh."
            }
            loading = false
        }
    }
}
