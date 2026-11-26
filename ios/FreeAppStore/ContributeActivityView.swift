import AVFoundation
import SwiftUI

/// Every job this phone tried (#820), newest first and grouped by day, filtered by status and app. Pull to refresh reads
/// the server's verdicts on this phone's submissions.
struct ContributeActivityView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var catalogue: CatalogueStore
    @State private var filter: ContributeFilter
    @State private var app: String?
    @State private var rows: [Contribution] = []

    init(model: CompanionModel, catalogue: CatalogueStore, filter: ContributeFilter = .all) {
        self.model = model
        self.catalogue = catalogue
        _filter = State(initialValue: filter)
    }

    @Environment(\.dynamicTypeSize) private var size

    @ViewBuilder private var filters: some View {
        ForEach(ContributeFilter.allCases) { option in
            if option == filter {
                Button(option.rawValue) { filter = option }.buttonStyle(.borderedProminent)
            } else {
                Button(option.rawValue) { filter = option }.buttonStyle(.bordered)
            }
        }
    }

    private var shown: [Contribution] { rows.filter { filter.shows($0.status) && (app == nil || $0.appId == app) } }

    private var days: [(day: Date, rows: [Contribution])] {
        var groups: [(day: Date, rows: [Contribution])] = []
        for row in shown {
            let day = Calendar.current.startOfDay(for: Date(timeIntervalSince1970: Double(row.at) / 1000))
            if groups.last?.day == day { groups[groups.count - 1].rows.append(row) } else { groups.append((day, [row])) }
        }
        return groups
    }

    var body: some View {
        List {
            Section {
                // In a column at accessibility text sizes, so no filter is cut off.
                if size.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) { filters }
                } else {
                    ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: 8) { filters } }
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }
            if shown.isEmpty { Text("Nothing on this phone for this filter.").foregroundStyle(.secondary) }
            ForEach(days, id: \.day) { group in
                Section(group.day.formatted(date: .complete, time: .omitted)) {
                    ForEach(group.rows, id: \.jobId) { row in
                        NavigationLink { ContributionDetailView(contribution: row, appName: catalogue.name(row.appId)) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(catalogue.name(row.appId)) · \(row.key)").font(.subheadline.weight(.semibold))
                                Text((ContributeText.labels[row.status] ?? row.status) + " · "
                                     + Date(timeIntervalSince1970: Double(row.at) / 1000).formatted(date: .omitted, time: .shortened))
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
        }
        .navigationTitle(app.map { "\(catalogue.name($0)) activity" } ?? "Activity")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Menu {
                Picker("App", selection: $app) {
                    Text("All apps").tag(String?.none)
                    ForEach(Set(rows.map(\.appId)).sorted { catalogue.name($0).localizedStandardCompare(catalogue.name($1)) == .orderedAscending }, id: \.self) {
                        Text(catalogue.name($0)).tag(String?.some($0))
                    }
                }
            } label: { Label("App", systemImage: "line.3.horizontal.decrease.circle") }
        }
        .refreshable { await model.refreshVerdicts(); rows = model.allContributions() }
        .onAppear { rows = model.allContributions() }
        .onChange(of: model.contributions) { rows = model.allContributions() }
    }
}

/// One job (#820): what it was, what this phone made, why it was not done or what the server said, and its audio once
/// accepted.
struct ContributionDetailView: View {
    let contribution: Contribution
    let appName: String
    @StateObject private var player = ArtifactPlayer()

    private var device: Bool { ["skipped", "failed"].contains(contribution.status) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(appName).font(.title2.bold())
                field("Job", contribution.key)
                field("When", Date(timeIntervalSince1970: Double(contribution.at) / 1000).formatted(date: .abbreviated, time: .shortened))
                if contribution.durationMs > 0 {
                    field("Audio", Duration.milliseconds(contribution.durationMs).formatted(.time(pattern: .minuteSecond))
                          + " · " + ContributeSettingsView.size(contribution.bytes))
                }
                field(device ? "Status on this phone" : "Server verdict", ContributeText.labels[contribution.status] ?? contribution.status)
                if !contribution.reason.isEmpty {
                    field(device ? "Why" : "Reason", ContributeText.reasons[contribution.reason] ?? contribution.reason)
                }
                if let wer = contribution.wer { field("Error rate", wer.formatted(.percent.precision(.fractionLength(0...1)))) }
                if contribution.status == "accepted" {
                    Button(player.playing ? "Pause" : "Play", systemImage: player.playing ? "pause.fill" : "play.fill") {
                        player.toggle(appId: contribution.appId, jobId: contribution.jobId)
                    }
                    .buttonStyle(.borderedProminent)
                    if !player.error.isEmpty { Text(player.error).foregroundStyle(.red) }
                }
                if !contribution.input.isEmpty {
                    Text("Text").font(.headline)
                    Text(player.highlighted(contribution.input)).textSelection(.enabled)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(contribution.key)
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { player.stop() }
    }

    private func field(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.footnote).foregroundStyle(.secondary)
            Text(value)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Plays an accepted job's public audio and follows its sentence timings (the meta `segments`) when it has them.
@MainActor
final class ArtifactPlayer: ObservableObject {
    @Published private(set) var playing = false
    @Published private(set) var error = ""
    /// The sentence being spoken, in UTF-16 offsets of the job's text.
    @Published private(set) var sentence: NSRange?
    private var player: AVPlayer?
    private var observers: [Any] = []
    private var segments: [(range: NSRange, from: Double, to: Double)] = []

    func toggle(appId: String, jobId: String) {
        if let player {
            if playing { player.pause() } else { player.play() }
            playing.toggle()
            return
        }
        guard let url = GenerationClient.artifactURL(appId, jobId), let meta = GenerationClient.artifactURL(appId, jobId, meta: true) else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        let player = AVPlayer(url: url)
        observers.append(player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) { [weak self] time in
            MainActor.assumeIsolated { self?.tick(time.seconds) }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: player.currentItem,
                                                                queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.playing = false
                self?.sentence = nil
                self?.player?.seek(to: .zero)
            }
        })
        self.player = player
        player.play()
        playing = true
        Task { segments = await Self.segments(meta) }
    }

    func stop() {
        player?.pause()
        if let first = observers.first { player?.removeTimeObserver(first) }
        observers.dropFirst().forEach(NotificationCenter.default.removeObserver)
        observers = []
        player = nil
        playing = false
        sentence = nil
    }

    private func tick(_ seconds: Double) {
        if player?.currentItem?.status == .failed { error = "Could not play this audio."; stop(); return }
        let now = segments.first { seconds >= $0.from && seconds < $0.to }?.range
        if now != sentence { sentence = now }
    }

    /// The text with the sentence being spoken marked.
    func highlighted(_ text: String) -> AttributedString {
        var out = AttributedString(text)
        if let sentence, let range = Range(sentence, in: text), let marked = Range(range, in: out) {
            out[marked].backgroundColor = Color.accentColor.opacity(0.25)
        }
        return out
    }

    /// `[charStart, charEnd, startSec, endSec]` rows of the public meta, or none when it has none or cannot be read.
    private static func segments(_ url: URL) async -> [(range: NSRange, from: Double, to: Double)] {
        let session = URLSession(configuration: .ephemeral, delegate: RefuseRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        guard let (data, response) = try? await session.data(from: url), (response as? HTTPURLResponse)?.statusCode == 200,
              let meta = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let rows = meta["segments"] as? [[NSNumber]] else { return [] }
        return rows.compactMap { row in
            guard row.count == 4, row[1].intValue >= row[0].intValue else { return nil }
            return (NSRange(location: row[0].intValue, length: row[1].intValue - row[0].intValue), row[2].doubleValue, row[3].doubleValue)
        }
    }
}
