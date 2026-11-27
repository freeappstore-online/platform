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
                        NavigationLink {
                            ContributionDetailView(contribution: row, appName: catalogue.name(row.appId), reload: model.contribution) {
                                try await model.report(row, good: $0, note: $1)
                            }
                        } label: {
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

/// One job (#820): what it was, what this phone made, why it was not done or what the server said, how this phone's
/// attempt went (#827), its audio: this phone's own while kept, else the accepted audio, and for an upload this phone's
/// Good / Not good report on it (#831). While it is generated (#835) it follows the job live: sentences done, elapsed
/// and CPU time, the lease's expiry, and the audio once encoded.
struct ContributionDetailView: View {
    @State private var contribution: Contribution
    let appName: String
    let kept: AttemptAudio
    /// The job's row as it is now, read every second while it is in progress.
    let reload: (String) -> Contribution?
    /// Sends the report and answers the one the server kept.
    let send: (_ good: Bool, _ note: String) async throws -> SubmissionReport
    @StateObject private var player = ArtifactPlayer()
    @State private var report: SubmissionReport?
    @State private var good: Bool?
    @State private var note = ""
    @State private var sending = false
    @State private var sendError = ""

    init(contribution: Contribution, appName: String, kept: AttemptAudio = AttemptAudio(dir: AttemptAudio.defaultDirectory),
         reload: @escaping (String) -> Contribution? = { _ in nil }, send: @escaping (_ good: Bool, _ note: String) async throws -> SubmissionReport) {
        _contribution = State(initialValue: contribution)
        self.appName = appName; self.kept = kept; self.reload = reload; self.send = send
    }

    private var generating: Bool { contribution.status == "generating" }
    private var device: Bool { ["generating", "skipped", "failed"].contains(contribution.status) }
    private var playable: Bool { kept.load(contribution.jobId) != nil || ["accepted", "superseded"].contains(contribution.status) }

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
                // `superseded`: another contributor's audio was accepted first; it plays from the same URL (#824) once this
                // phone no longer keeps its own.
                if playable {
                    if contribution.status == "superseded" { Text("Another contributor's audio was accepted for this job.").font(.footnote).foregroundStyle(.secondary) }
                    Button(player.playing ? "Pause" : "Play", systemImage: player.playing ? "pause.fill" : "play.fill") {
                        player.toggle(appId: contribution.appId, jobId: contribution.jobId, kept: kept)
                    }
                    .buttonStyle(.borderedProminent)
                    if !player.error.isEmpty { Text(player.error).foregroundStyle(.red) }
                }
                if !contribution.input.isEmpty {
                    Text("Text").font(.headline)
                    Text(player.highlighted(contribution.input)).textSelection(.enabled)
                }
                if !contribution.submissionId.isEmpty { reportControls }
                if let record = contribution.record {
                    Text("On this phone").font(.headline)
                    if generating {
                        if let done = record.sentencesDone, let total = record.sentencesTotal, total > 0 {
                            ProgressView(value: Double(done), total: Double(total)) { Text(Self.progress(done: done, total: total)) }
                        }
                        // Elapsed time ticks between the record's updates, at each sentence.
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            VStack(alignment: .leading, spacing: 12) {
                                ForEach(Self.facts(record, now: Int64(context.date.timeIntervalSince1970 * 1000)), id: \.label) { field($0.label, $0.value) }
                            }
                        }
                    } else {
                        ForEach(Self.facts(record), id: \.label) { field($0.label, $0.value) }
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(contribution.key)
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { player.stop() }
        .task {
            while ["generating", "uploading"].contains(contribution.status), !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                if let now = reload(contribution.jobId) { contribution = now }
            }
        }
        .onAppear {
            guard report == nil, let saved = contribution.report else { return }
            report = saved; good = saved.good; note = saved.note ?? ""
        }
    }

    /// Whether this upload sounds right, judged by a person listening (#831): no AI checks it.
    @ViewBuilder private var reportControls: some View {
        Text("Your report").font(.headline)
        if let report {
            field("Reported " + Date(timeIntervalSince1970: Double(report.at) / 1000).formatted(date: .abbreviated, time: .shortened),
                  (report.good ? "Good" : "Not good") + (report.note.map { " · \($0)" } ?? ""))
        } else {
            Text("Listen, then say whether it is good.").font(.footnote).foregroundStyle(.secondary)
        }
        Picker("Quality", selection: $good) {
            Text("Good").tag(Bool?.some(true))
            Text("Not good").tag(Bool?.some(false))
        }
        .pickerStyle(.segmented)
        TextField("Note (optional)", text: $note, axis: .vertical)
            .textFieldStyle(.roundedBorder)
            .lineLimit(1...4)
            .onChange(of: note) { if note.count > SubmissionReport.noteChars { note = String(note.prefix(SubmissionReport.noteChars)) } }
        Button(sending ? "Sending…" : report == nil ? "Send" : "Change report") {
            guard let good else { return }
            sending = true
            sendError = ""
            Task {
                do { report = try await send(good, note) } catch { sendError = error.localizedDescription }
                sending = false
            }
        }
        .buttonStyle(.bordered)
        .disabled(good == nil || sending)
        if !sendError.isEmpty { Text(sendError).foregroundStyle(.red) }
    }

    /// "Sentence 3 of 12 · 17%": the one being spoken (#835).
    static func progress(done: Int, total: Int) -> String {
        "Sentence \(min(done + 1, total)) of \(total) · \(done * 100 / max(total, 1))%"
    }

    /// The attempt's record (#827), as label and value, leaving out what it did not measure. `now` while it is in progress
    /// (#835): the time so far instead of how it ended, and the lease's expiry.
    static func facts(_ r: AttemptRecord, now: Int64? = nil) -> [(label: String, value: String)] {
        func s(_ ms: Int64?) -> String? { ms.map { (Double($0) / 1000).formatted(.number.precision(.fractionLength(1))) + " s" } }
        func power(_ level: Int?, _ charging: Bool?) -> String? {
            let parts = [level.map { "\($0)%" }, charging.map { $0 ? "charging" : "on battery" }].compactMap { $0 }
            return parts.isEmpty ? nil : parts.joined(separator: " ")
        }
        func span(_ start: String?, _ end: String?) -> String? {
            guard start != nil || end != nil else { return nil }
            return start == end ? start : "\(start ?? "?") → \(end ?? "?")"
        }
        let stages = [("load", r.loadMs), ("speech", r.synthMs), ("encode", r.encodeMs), ("upload", r.uploadMs)]
            .compactMap { name, ms in s(ms).map { "\(name) \($0)" } }.joined(separator: " · ")
        let elapsed = now.flatMap { now in r.startedAt.map { now - $0 } } ?? r.wallMs
        let rows: [(String, String?)] = [
            ("Ended", now == nil ? r.reason : nil), ("Error", r.error),
            ("Model", r.model),
            ("Ran on", [r.runner, r.appVersion, r.os, r.device].compactMap { $0 }.joined(separator: " · ")),
            ("Conditions", [r.network, r.background.map { $0 ? "in the background" : "in the foreground" }].compactMap { $0 }.joined(separator: " · ")),
            (now == nil ? "Time" : "Elapsed", s(elapsed).map { stages.isEmpty ? $0 : "\($0) (\(stages))" }),
            ("CPU time", s(r.cpuMs)),
            ("Lease expires", now == nil ? nil : r.leaseExpiresAt.map { Date(timeIntervalSince1970: Double($0) / 1000).formatted(date: .omitted, time: .standard) }),
            ("Real-time factor", r.rtf.map { $0.formatted(.number.precision(.fractionLength(2))) }),
            ("Peak memory", r.peakMemMb.map { "\($0) MB" }),
            ("Battery", span(power(r.batteryStart, r.chargingStart), power(r.batteryEnd, r.chargingEnd))),
            ("Thermal state", span(r.thermalStart, r.thermalEnd)),
        ]
        return rows.compactMap { label, value in value.flatMap { $0.isEmpty ? nil : (label, $0) } }
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

    /// Plays this phone's own audio of the job while `kept` has it (#827), else the job's accepted audio.
    func toggle(appId: String, jobId: String, kept: AttemptAudio? = nil) {
        if let player {
            if playing { player.pause() } else { player.play() }
            playing.toggle()
            return
        }
        let own = kept?.load(jobId)
        guard let url = own?.audio ?? GenerationClient.artifactURL(appId, jobId), let meta = GenerationClient.artifactURL(appId, jobId, meta: true) else { return }
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
        if let own { segments = own.segments } else { Task { segments = await Self.segments(meta) } }
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
              let meta = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [] }
        return AttemptAudio.segments(meta["segments"])
    }
}
