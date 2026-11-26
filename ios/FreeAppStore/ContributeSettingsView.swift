import SwiftUI

/// Contribute's settings (#820), behind the tab's gear: the apps, the voice model, when background runs happen and the
/// space it all takes.
struct ContributeSettingsView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var runner: ContributeRunner
    @ObservedObject var catalogue: CatalogueStore
    @State private var deletePrompt = false
    /// Bytes on this phone: the voice model's folder, and the database holding the contribution record.
    @State private var storage: (model: Int64, record: Int64)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                StatusMessages(model: model)
                apps
                voiceModel
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        AdaptiveToggle(title: "Only while charging", isOn: Binding(get: { model.chargingOnly }, set: model.setChargingOnly))
                        Text("Background runs wait for the phone to be charging and online. Turned off, iOS may also run them on battery, at its discretion. Run now works either way.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
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
