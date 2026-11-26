import SwiftUI

/// The voice model on this phone (#733).
enum ModelState { case none, waiting, installed }

enum ContributeText {
    /// What opting in means, shown before an app is turned on.
    static func disclosure(_ name: String) -> String {
        "This phone will take \(name)'s open jobs, such as narrating a chapter, generate each one with an on-device voice model "
            + "and upload the result to FreeAppStore under your account. It only ever generates exactly what \(name)'s publisher "
            + "asked for, never anything you type, and FreeAppStore checks every upload before anyone hears it. It needs a "
            + "\(KokoroModel.downloadBytes / 1_000_000) MB voice model, and it runs in the background only while this phone is "
            + "charging and online, or while FreeAppStore is open on screen after you tap Run now."
    }

    /// The labels of `Contribution.status`.
    static let labels = [
        "uploading": "Uploading", "pending": "Being checked", "accepted": "Accepted", "rejected": "Rejected",
        "superseded": "Not needed", "skipped": "Skipped", "failed": "Failed",
    ]

    /// Why a job was skipped, when this phone stopped it; other reasons are shown as recorded.
    static let reasons = [
        "user_stop": "you tapped Stop",
        "background_expired": "FreeAppStore left the screen or iOS ended its background time; it carries on while charging",
        "unplugged": "the phone was unplugged", "opted_out": "the app was turned off", "lease_expired": "the job's time ran out",
        "stopped": "stopped", "language": "this phone can't speak the set's language in that voice",
        "network": "no connection to FreeAppStore before the job's time ran out",
    ]
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

/// The Contribute tab: voice model, the current run, the apps opted in and recent results.
struct ContributeView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var runner: ContributeRunner
    @ObservedObject var catalogue: CatalogueStore
    @State private var deletePrompt = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    StatusMessages(model: model)
                    Text("Help apps you use by generating their audio on this phone, such as narration for Books. Apps publish the jobs; your phone does the work while it charges.")
                    if model.signedIn {
                        voiceModel
                        running
                        apps
                        recent
                    } else {
                        Button("Sign in to FreeAppStore") { model.connect() }.buttonStyle(.borderedProminent).disabled(model.busy)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("Contribute")
        }
        .alert("Delete the voice model?", isPresented: $deletePrompt) {
            Button("Delete", role: .destructive) { model.deleteModel() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Frees \(KokoroModel.installedBytes / 1_000_000) MB. Contributing stops until you download it again.")
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
                    Text(runner.running ? "Downloading" : "Downloads while charging on Wi-Fi, or tap Download now.").foregroundStyle(.secondary)
                    if !runner.running { Button("Download now (\(downloadMB) MB)") { model.downloadModel() } }
                    Button("Cancel download", role: .destructive) { model.deleteModel() }
                case .none:
                    Text("\(downloadMB) MB download, kept on this phone and never backed up.").foregroundStyle(.secondary)
                    Button("Download (\(downloadMB) MB)") { model.downloadModel() }.buttonStyle(.borderedProminent)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var running: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Text((runner.app.map { "\(catalogue.name($0)) · " } ?? "") + (runner.status ?? "Not running")).font(.headline)
                if runner.running && runner.cooling {
                    Text("Paused while the phone cools down. It goes on by itself.").foregroundStyle(.orange)
                }
                if !runner.lastError.isEmpty { Text(runner.lastError).foregroundStyle(.red) }
                Text("Run now needs FreeAppStore open on screen; it keeps the screen on meanwhile. Leaving the app stops the job in hand without uploading.")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("Background runs happen only while this phone is charging and online, when iOS allows. If you leave during Run now, it carries on in the background once the phone is charging.")
                    .font(.footnote).foregroundStyle(.secondary)
                if runner.running {
                    Button("Stop") { model.stopContributing() }.buttonStyle(.bordered)
                } else {
                    Button("Run now") { model.contributeNow() }.buttonStyle(.borderedProminent)
                        .disabled(model.contributeApps.isEmpty || model.modelState != .installed)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private var apps: some View {
        Text("Apps").font(.title3.bold())
        if model.contributeApps.isEmpty {
            Text("No apps yet. Turn on Contribute on an app's page in the Store, or from an app that asks for help.").foregroundStyle(.secondary)
        }
        ForEach(model.contributeApps.sorted { catalogue.name($0).localizedStandardCompare(catalogue.name($1)) == .orderedAscending }, id: \.self) { id in
            GroupBox {
                VStack(alignment: .leading, spacing: 4) {
                    Text(catalogue.name(id)).font(.headline)
                    Text("\(model.contributedToday[id] ?? 0) today").font(.footnote).foregroundStyle(.secondary)
                    ContributeToggle(appId: id, name: catalogue.name(id), model: model)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder private var recent: some View {
        if !model.contributions.isEmpty {
            Text("Recent").font(.title3.bold())
            ForEach(model.contributions, id: \.jobId) { c in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(catalogue.name(c.appId)) · \(c.key)").font(.subheadline.weight(.semibold))
                    Text(ContributeText.labels[c.status] ?? c.status).font(.subheadline)
                    Text(Date(timeIntervalSince1970: Double(c.at) / 1000).formatted(.relative(presentation: .named)) + (c.reason.isEmpty ? "" : " · \(ContributeText.reasons[c.reason] ?? c.reason)"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
