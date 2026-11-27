import SwiftUI
import UserNotifications

/// Contribute's settings (#820), behind the tab's gear: the apps, the voice model, the conditions for background runs
/// (#830), the overnight summary (#844) and the space it all takes.
struct ContributeSettingsView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var runner: ContributeRunner
    @ObservedObject var catalogue: CatalogueStore
    @State private var deletePrompt = false
    /// Bytes on this phone: the voice model's folder, and the database holding the contribution record.
    @State private var storage: (model: Int64, record: Int64)?
    @State private var notifications = UNAuthorizationStatus.notDetermined

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                StatusMessages(model: model)
                apps
                voiceModel
                conditions
                summary
                if let storage {
                    Text("Storage").font(.title3.bold())
                    Text("Voice model: \(Self.size(storage.model))")
                    Text("Contribution record and other data on this phone: \(Self.size(storage.record))")
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Contribute settings")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.loadOpenJobs() }
        .task { await model.loadOpenJobs() }
        .task(id: model.modelState) { storage = await Self.measure(model: runner.kokoro.dir, record: model.repository.local.fileURL) }
        .alert("Delete the voice model?", isPresented: $deletePrompt) {
            Button("Delete", role: .destructive) { model.deleteModel() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Frees \(KokoroModel.installedBytes / 1_000_000) MB. Contributing stops until you download it again.")
        }
    }

    /// The apps opted in, and those with open jobs this phone could take, by name.
    @ViewBuilder private var apps: some View {
        Text("Apps").font(.title3.bold())
        let ids = model.contributeApps.union(model.openJobs.keys).sorted { catalogue.name($0).localizedStandardCompare(catalogue.name($1)) == .orderedAscending }
        if ids.isEmpty {
            Text("No apps yet. Turn on Contribute on an app's page in the Store, or from an app that asks for help.").foregroundStyle(.secondary)
        }
        ForEach(ids, id: \.self) { id in
            GroupBox {
                VStack(alignment: .leading, spacing: 4) {
                    Text(catalogue.name(id)).font(.headline)
                    Text("\(model.openJobs[id] ?? 0) open jobs · \(model.contributedToday[id] ?? 0) today").font(.footnote).foregroundStyle(.secondary)
                    ContributeToggle(appId: id, name: catalogue.name(id), model: model)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func bind<T>(_ key: WritableKeyPath<ContributePrefs, T>) -> Binding<T> {
        Binding(get: { model.prefs[keyPath: key] }, set: { var prefs = model.prefs; prefs[keyPath: key] = $0; model.setPrefs(prefs) })
    }

    private func note(_ text: String) -> some View { Text(text).font(.footnote).foregroundStyle(.secondary) }

    /// When background runs may happen (#830). Every condition is checked before each claim and between sentences.
    @ViewBuilder private var conditions: some View {
        Text("When to run").font(.title3.bold())
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Picker("Connection", selection: bind(\.cellular)) {
                    Text("Wi-Fi only").tag(false)
                    Text("Wi-Fi + mobile data").tag(true)
                }
                .pickerStyle(.segmented)
                if model.prefs.cellular {
                    Stepper("Mobile data: \(model.prefs.cellularCapMB) MB a month", value: bind(\.cellularCapMB), in: 100...20_000, step: 100)
                    note("Used this month: \(runner.cellularMB()) MB, counted on this phone (the voice model download and uploads). It starts again each month.")
                }
                Picker("Power", selection: bind(\.chargingOnly)) {
                    Text("Charging only").tag(true)
                    Text("Also on battery").tag(false)
                }
                .pickerStyle(.segmented)
                if !model.prefs.chargingOnly {
                    Stepper("Minimum battery: \(model.prefs.minBattery)%", value: bind(\.minBattery), in: 10...95, step: 5)
                }
                AdaptiveToggle(title: "Pause when the phone is hot", isOn: bind(\.thermal))
                Picker("CPU", selection: bind(\.cpu)) {
                    Text("Light").tag(ContributePrefs.Cpu.light)
                    Text("Balanced").tag(ContributePrefs.Cpu.balanced)
                    Text("Full").tag(ContributePrefs.Cpu.full)
                }
                .pickerStyle(.segmented)
                note("Light uses one core and rests a second between sentences; Balanced two cores with a short rest; Full up to four cores without rests.")
                Picker("While the phone is in use", selection: bind(\.inUse)) {
                    Text("Pause").tag(ContributePrefs.InUse.pause)
                    Text("Run slower").tag(ContributePrefs.InUse.slower)
                }
                note("iOS only runs background work while the phone is not in use, so this changes Run now: Run slower uses Light while FreeAppStore is on screen.")
                Stepper(model.prefs.dailyJobs == 0 ? "Daily maximum: no limit on jobs" : "Daily maximum: \(model.prefs.dailyJobs) jobs",
                        value: bind(\.dailyJobs), in: 0...10_000, step: 10)
                Stepper(model.prefs.dailyMinutes == 0 ? "Daily maximum: no limit on time" : "Daily maximum: \(model.prefs.dailyMinutes) minutes",
                        value: bind(\.dailyMinutes), in: 0...1_440, step: 15)
                AdaptiveToggle(title: "Quiet hours", isOn: bind(\.quiet))
                if model.prefs.quiet {
                    Picker("From", selection: bind(\.quietFrom)) { ForEach(0..<24, id: \.self) { Text(ContributePause.hour($0)).tag($0) } }
                    Picker("To", selection: bind(\.quietTo)) { ForEach(0..<24, id: \.self) { Text(ContributePause.hour($0)).tag($0) } }
                }
                note("Low Power Mode always pauses. When a condition stops holding, the job in hand is finished if it is nearly done, otherwise it stops and goes back to the app; Auto carries on by itself once every condition holds again. iOS decides when each background run starts and how long it lasts; plugging in, and a run ending with jobs left, ask it for the next one straight away. Run now ignores these conditions, apart from pausing when hot.")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The overnight summary (#844).
    private var summary: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                AdaptiveToggle(title: "Overnight summary", isOn: bind(\.summary))
                note("One quiet notification the morning after background work, such as \"Generated 42 clips, 38 accepted, 1 h 10 min CPU\". Tap it to open Activity.")
                if model.prefs.summary && notifications == .denied {
                    note("Notifications are off for FreeAppStore. Turn them on in the Settings app to see the summary.")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: model.prefs.summary) { notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus }
    }

    private var downloadMB: Int64 { KokoroModel.downloadBytes / 1_000_000 }

    private var voiceModel: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Text("Voice model").font(.title3.bold())
                Text("Kokoro \(KokoroModel.id.version)").font(.headline)
                switch model.modelState {
                case .installed:
                    Text("Installed · \(KokoroModel.installedBytes / 1_000_000) MB").foregroundStyle(.secondary)
                    Button("Delete model", role: .destructive) { deletePrompt = true }
                case .waiting:
                    if let downloaded = runner.downloaded {
                        ProgressView(value: downloaded) { Text("Downloading · \(Int(downloaded * 100))% of \(downloadMB) MB") }
                    } else {
                        Text("Downloads while charging on Wi-Fi, or tap Download now.").foregroundStyle(.secondary)
                        if !runner.running { Button("Download now (\(downloadMB) MB)") { model.downloadModel() } }
                    }
                    Button("Cancel download", role: .destructive) { model.deleteModel() }
                case .none:
                    Text("\(downloadMB) MB download, kept on this phone and never backed up.").foregroundStyle(.secondary)
                    Button("Download (\(downloadMB) MB)") { model.downloadModel() }.buttonStyle(.borderedProminent)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    static func size(_ bytes: Int64) -> String { ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file) }

    /// Sizes on disk, off the main thread: the model folder's files, and the database with its -wal and -shm files.
    static func measure(model: URL, record: URL) async -> (model: Int64, record: Int64) {
        await Task.detached {
            let files = FileManager.default
            func size(_ url: URL) -> Int64 { (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).flatMap { $0 }.map(Int64.init) ?? 0 }
            let modelBytes = (files.enumerator(at: model, includingPropertiesForKeys: [.fileSizeKey])?.allObjects as? [URL] ?? []).reduce(0) { $0 + size($1) }
            let recordBytes = ["", "-wal", "-shm"].reduce(Int64(0)) { $0 + size(URL(fileURLWithPath: record.path + $1)) }
            return (modelBytes, recordBytes)
        }.value
    }
}
