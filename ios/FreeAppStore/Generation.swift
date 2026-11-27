import Foundation
import os

/// Community generation (#727, #733), ported from the Android companion's Generation.kt: this phone claims an app's open
/// jobs, generates each one on the phone and uploads the result against the job's lease. The server decides what is
/// generated and verifies every upload; the phone only ever generates the exact input it claimed, never text the user
/// chooses, and never uploads twice for one job.
struct ModelId: Equatable {
    let model: String
    let version: String
}

/// A claimed job. `text` is the job's whole input; a job whose input is anything else has a blank `text` and is refused.
/// `language` is its set's BCP 47 tag (#810), or nil when the set names none.
struct GenerationJob {
    let id: String
    let setId: String
    let key: String
    let text: String
    let model: ModelId
    let params: [String: Any]
    let formats: [String]
    let maxBytes: Int64
    let language: String?
    let leaseToken: String
    let leaseExpiresAt: Int64
}

/// One job on this phone's contribution record. `status`: generating from the claim (#835), uploading, then the server's
/// pending/accepted/rejected/superseded; or skipped/failed locally.
struct Contribution: Equatable {
    let jobId: String
    let appId: String
    let key: String
    let at: Int64
    var status: String
    var reason = ""
    /// What the Activity screen shows (#820): the job's input and set, and the audio this phone made (length and file size).
    var input = ""
    var setId = ""
    var durationMs: Int64 = 0
    var bytes: Int64 = 0
    /// How this phone's last attempt at the job went (#827), once it ended.
    var record: AttemptRecord?
    /// The server's id of this phone's upload, empty until it has one, and this phone's report on it (#831).
    var submissionId = ""
    var report: SubmissionReport?
}

/// What a person on this phone said of its upload (#831): Good or Not good, with an optional note. No AI judges it.
struct SubmissionReport: Equatable {
    static let noteChars = 500
    let good: Bool
    let note: String?
    let at: Int64

    /// The server's `{ good, note, at }`, or nil when it is null or not that.
    init?(_ any: Any?) {
        guard let r = any as? [String: Any], let good = r["good"] as? Bool, let at = (r["at"] as? NSNumber)?.int64Value else { return nil }
        self.init(good: good, note: r["note"] as? String, at: at)
    }

    init(good: Bool, note: String?, at: Int64) { self.good = good; self.note = note; self.at = at }
}

/// Where the record lives: `LocalStore` on the phone, a dictionary in tests.
protocol ContributionLog: AnyObject {
    /// Whether this job was ever started on this phone. Such a job is never generated or uploaded again.
    func handled(_ jobId: String) -> Bool
    func record(_ contribution: Contribution) throws
    /// The server's record (#824, #831), each nil to keep the one recorded: `submissionId`, `durationMs` (the audio's
    /// length as verification measured it), `input`, which only fills a row recorded without its text, and `report`.
    func updateStatus(_ jobId: String, status: String, reason: String, submissionId: String?, durationMs: Int64?, input: String?,
                      report: SubmissionReport?) throws
    /// Keeps the record of the job's attempt with its row (#827).
    func saveAttempt(_ jobId: String, _ record: AttemptRecord) throws
}

extension ContributionLog {
    func updateStatus(_ jobId: String, status: String, reason: String) throws {
        try updateStatus(jobId, status: status, reason: reason, submissionId: nil, durationMs: nil, input: nil, report: nil)
    }
}

/// The `X-Attestation` hook (#732): an App Attest assertion (`DCAppAttestService`) bound to the job, or nil. The server
/// treats it as an extra signal only; until #732 lands nothing is sent.
struct Attestation {
    let token: (_ appId: String, _ job: GenerationJob) -> String?
    static let none = Attestation { _, _ in nil }
}

struct Audio {
    let samples: [Float]
    let sampleRate: Int
}

/// How a job's text is split into sentences and spoken (#812).
enum Language {
    case english, spanish, mandarin
}

/// Where narration goes as it is synthesized: `AacEncoder` on the phone, writing to a file.
protocol AudioSink: AnyObject {
    /// Appends mono samples in -1...1.
    func write(_ samples: [Float]) throws
    /// Ends the audio and completes the file.
    func finish() throws
    /// Releases the encoder; after `finish`, or instead of it when the job stops part-way.
    func close()
}

protocol Synthesizer: AnyObject {
    var model: ModelId { get }
    /// Whether this model can honour the job's `params` exactly.
    func accepts(_ params: [String: Any]) -> Bool
    /// How it speaks a job with these `params` from a set naming `language`, or nil when it can't speak that (#812).
    func language(_ params: [String: Any], tag: String?) -> Language?
    /// The audio for `text`, or nil when `keepGoing` turned false part-way.
    func synthesize(_ text: String, params: [String: Any], language: Language, keepGoing: @escaping () -> Bool) throws -> Audio?
    /// Loads the model for `language` ahead of the first sentence, so its time is measured apart (#827). Whether it
    /// loaded now; false when it was loaded already or loads lazily.
    func load(_ language: Language) throws -> Bool
}

extension Synthesizer {
    func load(_ language: Language) throws -> Bool { false }
}

/// The contributor routes, with the device credential.
final class GenerationClient: @unchecked Sendable {
    private let api: FasApi
    private let credential: () -> String?

    init(api: FasApi, credential: @escaping () -> String?) { self.api = api; self.credential = credential }

    private func token() throws -> String {
        guard let token = credential() else { throw ApiFailure(status: 401, message: "Sign in first.") }
        return token
    }

    /// nil when the app has no open job for these models (`204`).
    func claim(_ appId: String, models: [ModelId]) async throws -> GenerationJob? {
        let body = try JSONSerialization.data(withJSONObject: ["models": models.map { ["model": $0.model, "modelVersion": $0.version] }])
        let result = try await api.request("POST", "/apps/\(appId)/generation/claim", token: try token(), body: body)
        return try (result["job"] as? [String: Any]).map(Self.parseJob)
    }

    /// Returns the submission id.
    func submit(_ appId: String, job: GenerationJob, file: URL, contentType: String, meta: [String: Any], attestation: String?) async throws -> String {
        var headers = ["X-Lease-Token": job.leaseToken]
        if let attestation { headers["X-Attestation"] = attestation }
        let result = try await api.upload("PUT", "/apps/\(appId)/generation/jobs/\(job.id)/result", token: try token(), headers: headers,
                                          file: file, contentType: contentType, meta: meta)
        guard let id = result["submissionId"] as? String else { throw CompanionError("Unexpected response from FreeAppStore.") }
        return id
    }

    /// This phone's report on its own upload (#831); sending again changes it. `404`: not this account's submission.
    func report(_ appId: String, submissionId: String, good: Bool, note: String) async throws -> SubmissionReport {
        guard Self.jobIdPattern.firstMatch(in: submissionId, range: NSRange(location: 0, length: submissionId.utf16.count)) != nil else {
            throw CompanionError("Unexpected submission id.")
        }
        var body: [String: Any] = ["good": good]
        let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !note.isEmpty { body["note"] = String(note.prefix(SubmissionReport.noteChars)) }
        let result = try await api.request("PUT", "/apps/\(appId)/generation/submissions/\(submissionId)/report", token: try token(),
                                           body: try JSONSerialization.data(withJSONObject: body))
        guard let report = SubmissionReport(result["report"]) else { throw CompanionError("Unexpected response from FreeAppStore.") }
        return report
    }

    /// Extends the job's lease (#783) and returns its new expiry. `403`: the lease is gone; `409`: it is at its cap.
    func extend(_ appId: String, job: GenerationJob) async throws -> Int64 {
        let result = try await api.request("POST", "/apps/\(appId)/generation/jobs/\(job.id)/lease", token: try token(),
                                           headers: ["X-Lease-Token": job.leaseToken])
        return try Self.epochMs(result["leaseExpiresAt"])
    }

    /// Attempt records (#813, #827) of jobs this phone leased. Returns how many the server recorded.
    @discardableResult
    func events(_ appId: String, records: [(jobId: String, record: AttemptRecord)], timeout: TimeInterval? = nil) async throws -> Int {
        let body = try JSONSerialization.data(withJSONObject: ["events": try records.map { try $0.record.event($0.jobId) }])
        let result = try await api.request("POST", "/apps/\(appId)/generation/events", token: try token(), body: body, timeout: timeout)
        return (result["recorded"] as? NSNumber)?.intValue ?? 0
    }

    /// Copies the server's verdicts on this account's submissions into `log`.
    func refresh(_ appId: String, log: ContributionLog) async throws {
        let result = try await api.request("GET", "/apps/\(appId)/generation/submissions", token: try token())
        for s in result["submissions"] as? [[String: Any]] ?? [] {
            guard let jobId = s["jobId"] as? String, !jobId.isEmpty else { continue }
            try log.updateStatus(jobId, status: s["status"] as? String ?? "", reason: String((s["reason"] as? String ?? "").prefix(120)),
                                 submissionId: s["submissionId"] as? String, durationMs: (s["durationMs"] as? NSNumber)?.int64Value,
                                 input: (s["input"] as? [String: Any])?["text"] as? String, report: SubmissionReport(s["report"]))
        }
    }

    /// Discovery (#794): open jobs this phone could claim now, by app, counting only the sets of `model`.
    func open(model: ModelId) async throws -> [String: Int] {
        let result = try await api.request("GET", "/generation/open", token: try token())
        var counts: [String: Int] = [:]
        for app in result["apps"] as? [[String: Any]] ?? [] {
            // Only ids the contributor routes take, since an opt-in from this list claims through them.
            guard let id = app["appId"] as? String, FasApi.endpoint("/apps/\(id)/generation/claim") != nil else { continue }
            for set in app["sets"] as? [[String: Any]] ?? [] where set["model"] as? String == model.model && set["modelVersion"] as? String == model.version {
                counts[id, default: 0] += (set["open"] as? NSNumber)?.intValue ?? 0
            }
        }
        return counts
    }

    /// The public URL of a job's accepted audio (no credential), or of its sentence timings with `meta`.
    static func artifactURL(_ appId: String, _ jobId: String, meta: Bool = false) -> URL? {
        guard FasApi.endpoint("/apps/\(appId)/generation/claim") != nil, jobIdPattern.firstMatch(in: jobId, range: NSRange(location: 0, length: jobId.utf16.count)) != nil
        else { return nil }
        return URL(string: "\(FasApi.ORIGIN)/v1/apps/\(appId)/generation/artifacts/\(jobId)\(meta ? "/meta" : "")")
    }

    private static let jobIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,128}$")

    static func parseJob(_ j: [String: Any]) throws -> GenerationJob {
        guard let id = j["id"] as? String, jobIdPattern.firstMatch(in: id, range: NSRange(location: 0, length: id.utf16.count)) != nil else {
            throw CompanionError("Unexpected job id.")
        }
        guard let input = j["input"] as? [String: Any], let model = j["model"] as? String, let version = j["modelVersion"] as? String,
              let leaseToken = j["leaseToken"] as? String else { throw CompanionError("Unexpected job from FreeAppStore.") }
        return GenerationJob(
            id: id, setId: j["setId"] as? String ?? "", key: j["key"] as? String ?? "",
            text: input.count == 1 ? input["text"] as? String ?? "" : "",
            model: ModelId(model: model, version: version), params: j["params"] as? [String: Any] ?? [:],
            formats: j["formats"] as? [String] ?? [], maxBytes: (j["maxBytes"] as? NSNumber)?.int64Value ?? 0,
            language: j["language"] as? String, leaseToken: leaseToken, leaseExpiresAt: try epochMs(j["leaseExpiresAt"]))
    }

    /// ms epoch numbers (what the backend sends), or an ISO 8601 time.
    private static func epochMs(_ value: Any?) throws -> Int64 {
        if let number = value as? NSNumber { return number.int64Value }
        if let text = value as? String {
            let iso = ISO8601DateFormatter()
            if let date = iso.date(from: text) { return Int64(date.timeIntervalSince1970 * 1000) }
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = iso.date(from: text) { return Int64(date.timeIntervalSince1970 * 1000) }
        }
        throw CompanionError("Unexpected lease expiry from FreeAppStore.")
    }
}

enum GenerationPolicy {
    static let contentType = "audio/mp4"
    /// An upload must start at least this long before the lease runs out.
    static let leaseMarginMs: Int64 = 30_000
    /// While generating, the lease is extended once it is this close to expiry (#783).
    static let extendWithinMs: Int64 = 5 * 60_000
    /// The largest `meta` part the server takes.
    static let maxMetaBytes = 64 * 1024
    /// Silence after a sentence and after a paragraph, in seconds: Books' `SENTENCE_PAUSE` and `PARAGRAPH_PAUSE`.
    static let sentencePause = 0.4
    static let paragraphPause = 0.8
    /// Audio shorter than this gets silence at the end (#812), so a two-character phrase such as 对。 is well within the
    /// server's characters-per-second floor. Audio up to 3 s is never too long for its text.
    static let minSeconds = 1.0

    /// Network retries (#819): the first wait, doubled each time up to the longest.
    static let retryFirstMs: Int64 = 2_000
    static let retryLongestMs: Int64 = 60_000
    /// Tries of a claim or a verdict refresh before the run gives up (about a minute of waiting). An upload is tried
    /// for as long as its lease leaves time.
    static let retryAttempts = 6

    /// How long to wait before trying again after `error`, or nil when it is not a passing network failure: no
    /// connection, DNS, a timeout or a dropped connection; a 5xx or 408; a 429 only when it says when (`Retry-After`).
    static func retryDelay(_ error: Error, attempt: Int) -> Int64? {
        let backoff = min(retryFirstMs << min(attempt, 10), retryLongestMs)
        if let failure = error as? ApiFailure {
            switch failure.status {
            case 429: return failure.retryAfter.map { Int64(max($0, 0)) * 1000 }
            case 408, 500...599: return failure.retryAfter.map { Int64(max($0, 0)) * 1000 } ?? backoff
            default: return nil
            }
        }
        let transient: [URLError.Code] = [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .dnsLookupFailed,
                                          .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff, .callIsActive]
        return (error as? URLError).map(\.code).map(transient.contains) == true ? backoff : nil
    }

    /// The #813 end reason of a job recorded with this phone's local `reason`: a refusal, a stop or a lease that ran out
    /// (`leaseRevoked`: the server answered 403 when it was extended).
    static func endReason(_ local: String, leaseRevoked: Bool = false) -> String {
        switch local {
        case "model", "format", "input", "params", "language", "max_bytes": "unsupported"
        case "lease_expired": leaseRevoked ? "lease_403" : "lease_cap"
        case "too_large", "user_stop", "thermal", "background_expired", "unplugged", "network": local
        // A condition that failed (#830) is an interruption (#841), named after what it is about.
        case "battery_low", "low_power": "unplugged"
        case "no_network", "mobile_data", "data_cap": "network"
        case "opted_out", "off", "quiet_hours", "daily_max": "user_stop"
        default: "other"
        }
    }

    /// Local reasons of a job this phone stopped part-way rather than refused or failed (#841): the server gives such a
    /// job back, and this phone takes it again. Never one it uploaded.
    static let interrupted: Set<String> = ["user_stop", "opted_out", "stopped", "background_expired", "unplugged", "thermal", "network",
                                           "interrupted", "lease_expired", "left_app", "battery_low", "low_power", "no_network",
                                           "mobile_data", "data_cap", "off", "quiet_hours", "daily_max"]

    /// Whether this phone may take a job on its record again when the server offers it (#841).
    static func retryable(_ row: Contribution) -> Bool {
        ["skipped", "failed", "generating"].contains(row.status) && row.submissionId.isEmpty
            && (row.status == "generating" || interrupted.contains(row.reason))
    }

    /// The #813 end reason of an attempt that failed with `error` during `stage`.
    static func endReason(_ error: Error, stage: AttemptMeter.Stage) -> String {
        if let failure = error as? ApiFailure {
            switch failure.status {
            case 403 where stage == .upload: return "lease_403"
            case 400..<500: return "server_4xx"
            case 500..<600: return "server_5xx"
            default: break
            }
        }
        if retryDelay(error, attempt: 0) != nil { return "network" }
        switch stage {
        case .synth: return "model_error"
        case .encode: return "encode_error"
        case .start, .upload: return "other"
        }
    }

    /// Why this phone will not generate the job, or nil when it will.
    static func refusal(_ job: GenerationJob, synth: Synthesizer, handled: Bool, now: Int64) -> String? {
        if handled { return "already_handled" }
        if job.model != synth.model { return "model" }
        if !job.formats.contains(contentType) { return "format" }
        if job.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "input" }
        if !synth.accepts(job.params) { return "params" }
        if synth.language(job.params, tag: job.language) == nil { return "language" }
        if job.maxBytes <= 0 { return "max_bytes" }
        if job.leaseExpiresAt - leaseMarginMs <= now { return "lease_expired" }
        return nil
    }
}

/// The sentences Books narrates one at a time (#785), ported from the Android companion's `Sentences`, itself from Books'
/// `scripts/audio/segments.py` with the `END` and `ABBREVIATION` of its English and Spanish profiles: a sentence ends at
/// . ! ? or … (with any closing quotes or brackets) followed by space and not by a lowercase word, but not after an
/// abbreviation such as Mr. or an initial; blank lines end paragraphs. Mandarin (#812) has no spaces: a sentence ends at
/// 。！？；… or their ASCII forms (with any closing quotes or brackets) whatever follows, except a full stop before a digit
/// (3.5). Offsets are UTF-16 code units, like Books' timings.
enum Sentences {
    struct Sentence: Equatable {
        let start: Int
        let end: Int
        var endsParagraph: Bool
    }

    /// Python's `\s`, spelled out (ICU syntax) so this and Android's ICU engine agree.
    private static let s = #"\t\n\u000b\f\r\u001c-\u001f \u0085   -     　"#
    private static let paragraph = regex(#"[^\#(s)].*?(?=[\#(s)]*\n[\#(s)]*\n|[\#(s)]*$)"#, [.dotMatchesLineSeparators])
    private static let space = regex(#"[\#(s)]*"#)
    /// Python's `\b` before a word.
    private static let b = #"(?<![\p{L}\p{N}_])"#
    private static let en = (end: regex(#"[.!?…]+[”’"')\]]*(?=[\#(s)]+(?![a-z]))"#),
                             abbreviation: regex(#"\#(b)(Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Rev|Capt|Col|Gen|Lt|Mt|[A-HJ-Z])$"#))
    private static let lower = "a-záéíóúüñ"
    private static let es = (end: regex(#"[.!?…]+[”’"')\]»]*(?=[\#(s)]+(?![\#(lower)]|[—-]+[\#(s)]?[\#(lower)]))"#),
                             abbreviation: regex(#"\#(b)(Sr|Sra|Srta|Sres|Srs|Dr|Dra|Dña|Ud|Uds|Vd|Vds|Vmd|Excmo|Excma|Ilmo|Ilma|Rvdo|Sto|Sta|Fr|Pbro|[A-ZÁÉÍÓÚÑ])$"#))
    private static let zh = (end: regex(#"(?:[。！？；…!?;]|\.(?!\d))+[”’"')\]）」』】》]*"#), abbreviation: NSRegularExpression?.none)

    private static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    static func split(_ text: String, language: Language) -> [Sentence] {
        let (end, abbreviation): (NSRegularExpression, NSRegularExpression?) = switch language {
        case .english: en
        case .spanish: es
        case .mandarin: zh
        }
        let ns = text as NSString
        var out: [Sentence] = []
        for para in paragraph.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let paraEnd = NSMaxRange(para.range)
            var start = para.range.location
            // The end matcher's bounds are opaque (it sees only this paragraph); the abbreviation's are transparent.
            for m in end.matches(in: text, range: NSRange(location: start, length: paraEnd - start)) {
                if ns.substring(with: m.range) == ".", let abbreviation, abbreviation.firstMatch(
                    in: text, options: [.withTransparentBounds], range: NSRange(location: start, length: m.range.location - start)) != nil { continue }
                out.append(Sentence(start: start, end: NSMaxRange(m.range), endsParagraph: false))
                let after = NSMaxRange(m.range)
                start = space.firstMatch(in: text, options: [.anchored], range: NSRange(location: after, length: paraEnd - after)).map { NSMaxRange($0.range) } ?? after
            }
            if start < paraEnd { out.append(Sentence(start: start, end: paraEnd, endsParagraph: false)) }
            out[out.count - 1].endsParagraph = true
        }
        return out
    }
}

/// Thrown by `NetworkRetry` when the run stopped while it waited to try again.
struct RetryStopped: Error {}

/// Tries a request again after passing network failures (#819), waiting as `GenerationPolicy.retryDelay` says, in steps
/// of at most a second so a stop is never kept waiting.
struct NetworkRetry {
    var sleep: (Int64) async throws -> Void = { try await Task.sleep(for: .milliseconds($0)) }

    /// `call(attempt)` until it succeeds, fails for good, or `more(attempt, wait)` says there is no time for another try;
    /// then its last error is thrown. `RetryStopped` when `keepGoing` turned false while waiting.
    func run<T>(keepGoing: () -> Bool, more: (_ attempt: Int, _ waitMs: Int64) -> Bool, _ call: (_ attempt: Int) async throws -> T) async throws -> T {
        var attempt = 0
        while true {
            do { return try await call(attempt) } catch {
                guard let wait = GenerationPolicy.retryDelay(error, attempt: attempt), more(attempt + 1, wait) else { throw error }
                attempt += 1
                var left = wait
                while left > 0 && keepGoing() { let step = min(left, 1_000); try await sleep(step); left -= step }
                if !keepGoing() { throw RetryStopped() }
            }
        }
    }

    /// At most `GenerationPolicy.retryAttempts` tries: a claim or a verdict refresh.
    func attempts<T>(keepGoing: () -> Bool, _ call: () async throws -> T) async throws -> T {
        try await run(keepGoing: keepGoing, more: { attempt, _ in attempt < GenerationPolicy.retryAttempts }) { _ in try await call() }
    }
}

/// The claim → generate → encode → submit loop over the apps this phone contributes to.
final class Contributor {
    private let client: GenerationClient
    private let log: ContributionLog
    private let synth: Synthesizer
    private let encoder: (URL, Int) throws -> AudioSink
    private let workDir: URL
    private let attestation: Attestation
    private let now: () -> Int64
    private let stopReason: () -> String
    private let hot: () -> Bool
    private let coolDown: Duration
    private let retry: NetworkRetry
    private let sentence: (_ done: Int, _ total: Int, _ audioSeconds: Double) -> Void
    private let probes: DeviceProbes
    private let audio: AttemptAudio?
    private let condition: () -> String?
    private let rest: Duration
    private let uploaded: (Int64) -> Void
    private static let logger = Logger(subsystem: "online.freeappstore.companion", category: "contribute")
    /// Whether the last `run` left no job to claim (#836): every app left the rotation finding no open job (or turned off,
    /// or no longer claiming). False once an app left after a job it did not submit, such as one whose lease ran out, so
    /// jobs may be left.
    private(set) var drained = true
    /// The condition that ended the last `run` (#830), its local reason, or nil.
    private(set) var paused: String?

    /// `stopReason` names why `keepGoing` turned false, for the record. While `hot()` (the phone is too warm) the work
    /// waits between sentences and before claiming, checking every `coolDown` and keeping the lease alive, then goes on.
    /// Each attempt is measured with `probes` (#827); its audio is kept in `audio` when given. `pause` names a condition
    /// that failed (#830), checked before each claim and between sentences: a job in hand then stops, unless nearly done.
    /// `rest` is waited after each sentence; `uploaded` hears of each upload's bytes.
    init(client: GenerationClient, log: ContributionLog, synth: Synthesizer, encoder: @escaping (URL, Int) throws -> AudioSink, workDir: URL,
         attestation: Attestation = .none, now: @escaping () -> Int64 = CompanionRepository.now,
         stopReason: @escaping () -> String = { "stopped" }, hot: @escaping () -> Bool = { false }, coolDown: Duration = .seconds(10),
         retry: NetworkRetry = NetworkRetry(), sentence: @escaping (_ done: Int, _ total: Int, _ audioSeconds: Double) -> Void = { _, _, _ in },
         probes: DeviceProbes = DeviceProbes(), audio: AttemptAudio? = nil, pause: @escaping () -> String? = { nil }, rest: Duration = .zero,
         uploaded: @escaping (Int64) -> Void = { _ in }) {
        self.client = client; self.log = log; self.synth = synth; self.encoder = encoder; self.workDir = workDir
        self.attestation = attestation; self.now = now; self.stopReason = stopReason; self.hot = hot; self.coolDown = coolDown
        self.retry = retry; self.sentence = sentence; self.probes = probes; self.audio = audio
        self.condition = pause; self.rest = rest; self.uploaded = uploaded
    }

    /// Takes one job from each app in turn (#819), so every app moves forward, until none has a job left or `keepGoing`
    /// turns false. An app leaves the rotation when it has no open job, `optedIn` turns false for it, or a job of it is
    /// not submitted (that job keeps its lease until expiry, so a later run continues). Nothing is claimed once `mayClaim`
    /// turns false (a Run now whose app left the screen, #828); the job in hand still finishes. Returns how many were
    /// submitted. A `401` is thrown, and so is a claim that still fails after its network retries (or the daily limit's `429`).
    func run(_ apps: [String], keepGoing: @escaping () -> Bool, optedIn: @escaping (String) -> Bool = { _ in true },
             mayClaim: @escaping () -> Bool = { true }, progress: (String, GenerationJob) -> Void = { _, _ in }) async throws -> Int {
        var submitted = 0
        var rotation = apps
        drained = true
        paused = nil
        while !rotation.isEmpty && keepGoing() && mayClaim() && paused == nil {
            for app in rotation {
                if !mayClaim() { break }
                if let reason = condition() { paused = reason; drained = false; break }
                let go = { keepGoing() && optedIn(app) }
                var stays = false
                while hot() && go() { try await Task.sleep(for: coolDown) }
                if go() {
                    let job: GenerationJob?
                    do { job = try await retry.attempts(keepGoing: go) { try await self.client.claim(app, models: [self.synth.model]) } }
                    catch is RetryStopped { job = nil }
                    if let job {
                        progress(app, job)
                        stays = try await process(app, job, go, optedIn: { optedIn(app) })
                        if stays { submitted += 1 } else { drained = false }
                    }
                }
                if !stays { rotation.removeAll { $0 == app } }
                if !keepGoing() || paused != nil { break }
            }
        }
        return submitted
    }

    /// One attempt at `job`, measured (#827): when it ends its record is kept with the job's row and sent to the server,
    /// best effort.
    private func process(_ appId: String, _ job: GenerationJob, _ keepGoing: @escaping () -> Bool, optedIn: @escaping () -> Bool) async throws -> Bool {
        let meter = await AttemptMeter(probes: probes, startedAt: now())
        let file = workDir.appendingPathComponent("contribution.m4a")
        defer { try? FileManager.default.removeItem(at: file) }
        let submitted = try await attempt(appId, job, keepGoing, optedIn: optedIn, meter: meter, file: file)
        if meter.skip { return submitted }
        let record = await meter.finish()
        do { try log.saveAttempt(job.id, record) } catch { Self.logger.error("attempt record not kept: \(error.localizedDescription, privacy: .public)") }
        // Best effort and short (#828): after iOS ends a background run only seconds are left before the task must
        // complete, so a slow network can't hold it; the record stays with the job's row either way.
        do { try await client.events(appId, records: [(job.id, record)], timeout: keepGoing() ? 5 : 2) }
        catch { Self.logger.error("attempt record not sent: \(error.localizedDescription, privacy: .public)") } // best effort: never fails the job
        return submitted
    }

    private func attempt(_ appId: String, _ job: GenerationJob, _ keepGoing: @escaping () -> Bool, optedIn: @escaping () -> Bool,
                         meter: AttemptMeter, file: URL) async throws -> Bool {
        let handled = log.handled(job.id)
        func row(_ status: String, _ reason: String = "") -> Contribution {
            Contribution(jobId: job.id, appId: appId, key: job.key, at: now(), status: status, reason: reason, input: job.text, setId: job.setId)
        }
        if let reason = GenerationPolicy.refusal(job, synth: synth, handled: handled, now: now()) {
            if handled { meter.skip = true } else { meter.reason = GenerationPolicy.endReason(reason); try log.record(row("skipped", reason)) }
            return false
        }
        let stopped = { optedIn() ? self.stopReason() : "opted_out" }
        let lease = Lease(client: client, appId: appId, job: job, now: now)
        var retried = false
        // In progress from the claim (#835), so Activity shows the job while it is generated.
        var started = row("generating")
        started.record = meter.progress(model: job.model, done: 0, total: 0, leaseExpiresAt: lease.expiry)
        try log.record(started)
        do {
            guard let (narrated, durationMs) = try await narrate(job, file, lease, keepGoing, meter) else {
                let reason = keepGoing() ? paused ?? "lease_expired" : stopped()
                meter.reason = GenerationPolicy.endReason(reason, leaseRevoked: lease.revoked)
                try log.record(row("skipped", reason))
                return false
            }
            keep(job.id, file: file, segments: narrated)
            let meta: [String: Any] = ["segments": narrated]
            meter.stage = .start
            try await lease.renew()
            let bytes = ((try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? NSNumber)?.int64Value ?? 0
            meter.output(bytes: bytes, durationMs: durationMs)
            let metaBytes = try JSONSerialization.data(withJSONObject: meta).count
            let refusal: String? = if bytes > job.maxBytes || metaBytes > GenerationPolicy.maxMetaBytes {
                "too_large"
            } else if !lease.held { "lease_expired" } else { nil }
            var made = row("skipped", refusal ?? "")
            made.durationMs = durationMs
            made.bytes = bytes
            if let refusal {
                meter.reason = GenerationPolicy.endReason(refusal, leaseRevoked: lease.revoked)
                try log.record(made)
                return false
            }
            // Recorded before the upload starts, so a crash mid-upload can never lead to a second, different file.
            made.status = "uploading"
            try log.record(made)
            meter.stage = .upload
            // The same file, sent again after a network failure while the lease leaves time (#819); never generated again.
            let submissionId = try await meter.time(\.uploadMs) {
                try await retry.run(keepGoing: keepGoing, more: { _, wait in retried = true; return lease.held(after: wait) }) { attempt in
                    if attempt > 0 { try await lease.renew() }
                    return try await self.client.submit(appId, job: job, file: file, contentType: GenerationPolicy.contentType, meta: meta,
                                                        attestation: self.attestation.token(appId, job))
                }
            }
            try log.updateStatus(job.id, status: "pending", reason: "", submissionId: submissionId, durationMs: nil, input: nil, report: nil)
            uploaded(bytes)
            meter.reason = "submitted"
            return true
        } catch is RetryStopped {
            meter.reason = GenerationPolicy.endReason(stopped())
            try log.updateStatus(job.id, status: "skipped", reason: stopped())
            return false
        } catch {
            if (error as? ApiFailure)?.status == 401 { throw error }
            meter.reason = GenerationPolicy.endReason(error, stage: meter.stage)
            meter.failure = error
            let reason = GenerationPolicy.retryDelay(error, attempt: 0) != nil ? "network"
                : String((((error as? ApiFailure).map { "\($0.status) " } ?? "") + error.localizedDescription).prefix(120))
            try log.updateStatus(job.id, status: "failed", reason: reason)
            // An upload whose answer was lost may have arrived (a retry then finds the lease used): the server's record says.
            if retried { try? await client.refresh(appId, log: log) }
            return false
        }
    }

    /// Keeps a copy of the encoded audio and its segments for playback (#827), playable from here on (#835).
    private func keep(_ jobId: String, file: URL, segments: [[Any]]) {
        guard let audio else { return }
        let copy = workDir.appendingPathComponent("kept.m4a")
        try? FileManager.default.removeItem(at: copy)
        do {
            try FileManager.default.copyItem(at: file, to: copy)
            try audio.save(jobId, file: copy, segments: segments)
        } catch { Self.logger.error("audio not kept: \(error.localizedDescription, privacy: .public)") }
    }

    /// The `generating` row's record so far (#835), best effort.
    private func progress(_ job: GenerationJob, _ meter: AttemptMeter, _ lease: Lease, done: Int, total: Int) {
        try? log.saveAttempt(job.id, meter.progress(model: job.model, done: done, total: total, leaseExpiresAt: lease.expiry))
    }

    /// The job's own input, verbatim: the only text this path can generate. Narrated a sentence at a time as Books does
    /// (#785), the sentences joined by its pauses, each one encoded into `file` as soon as it is synthesized. Returns
    /// `[charStart, charEnd, startSec, endSec]` for each sentence and the audio's length in ms, or nil when stopped or the
    /// lease ran out. `sentence` hears of each one done.
    private func narrate(_ job: GenerationJob, _ file: URL, _ lease: Lease, _ keepGoing: @escaping () -> Bool,
                         _ meter: AttemptMeter) async throws -> ([[Any]], Int64)? {
        var segments: [[Any]] = []
        var sink: AudioSink?
        defer { sink?.close() }
        var rate = 24_000
        var length = 0
        var pause = 0 // written before the next sentence, so none follows the last
        let text = job.text as NSString
        guard let language = synth.language(job.params, tag: job.language) else { return nil } // refused before this
        let sentences = Sentences.split(job.text, language: language)
        meter.stage = .synth
        try meter.load { try synth.load(language) }
        sentence(0, sentences.count, 0)
        progress(job, meter, lease, done: 0, total: sentences.count)
        for (i, s) in sentences.enumerated() {
            defer {
                meter.sample()
                sentence(i + 1, sentences.count, Double(length) / Double(rate))
                progress(job, meter, lease, done: i + 1, total: sentences.count)
            }
            // A failed condition (#830) stops the job unless it is nearly done; the run then claims nothing more.
            if let reason = condition() {
                paused = reason
                if !ContributeConditions.nearlyDone(i, sentences.count) { return nil }
            }
            if i > 0 && rest > .zero { try await Task.sleep(for: rest) }
            while hot() && keepGoing() && lease.held {
                try await lease.renew()
                try await Task.sleep(for: coolDown)
            }
            try await lease.renew()
            meter.stage = .synth
            guard let audio = try await meter.time(\.synthMs, {
                try synth.synthesize(text.substring(with: NSRange(location: s.start, length: s.end - s.start)), params: job.params,
                                     language: language, keepGoing: { keepGoing() && lease.held })
            }) else { return nil }
            if audio.samples.isEmpty { continue } // nothing to say, e.g. "* * *"
            meter.stage = .encode
            try await meter.time(\.encodeMs) {
                let out: AudioSink
                if let sink { out = sink } else { out = try encoder(file, audio.sampleRate); sink = out; rate = audio.sampleRate }
                if pause > 0 { try out.write([Float](repeating: 0, count: pause)); length += pause }
                segments.append([s.start, s.end, seconds(length, rate), seconds(length + audio.samples.count, rate)])
                try out.write(audio.samples)
            }
            length += audio.samples.count
            pause = Int((s.endsParagraph ? GenerationPolicy.paragraphPause : GenerationPolicy.sentencePause) * Double(rate))
        }
        meter.stage = .encode
        try await meter.time(\.encodeMs) {
            if sink == nil { sink = try encoder(file, rate) }
            let short = Int(GenerationPolicy.minSeconds * Double(rate)) - length
            if short > 0 { try sink?.write([Float](repeating: 0, count: short)); length += short }
            try sink?.finish()
        }
        return (segments, Int64(length) * 1000 / Int64(rate))
    }

    private func seconds(_ samples: Int, _ rate: Int) -> Double { (Double(samples) * 1000 / Double(rate)).rounded() / 1000 }
}

/// The job's lease while this phone works on it (#783): extended between sentences once within
/// `GenerationPolicy.extendWithinMs` of expiry. `403` means it is gone, so the job stops; `409` means it is at its cap,
/// so the work goes on only while it lasts. Any other failure is tried again after the next sentence.
private final class Lease: @unchecked Sendable {
    private let client: GenerationClient
    private let appId: String
    private let job: GenerationJob
    private let now: () -> Int64
    private let lock = NSLock()
    private var expiresAt: Int64
    private var extendable = true

    init(client: GenerationClient, appId: String, job: GenerationJob, now: @escaping () -> Int64) {
        self.client = client; self.appId = appId; self.job = job; self.now = now; expiresAt = job.leaseExpiresAt
    }

    /// Whether there is still time to finish and upload.
    var held: Bool { held(after: 0) }

    /// When it runs out, ms epoch; 0 once revoked.
    var expiry: Int64 { lock.withLock { expiresAt } }

    /// The server refused to extend it (`403`).
    var revoked: Bool { lock.withLock { expiresAt == 0 } }

    /// Whether there will still be time to upload `ms` from now.
    func held(after ms: Int64) -> Bool { lock.withLock { now() + ms < expiresAt - GenerationPolicy.leaseMarginMs } }

    func renew() async throws {
        let due = lock.withLock { extendable && now() >= expiresAt - GenerationPolicy.extendWithinMs }
        guard due else { return }
        do {
            let next = try await client.extend(appId, job: job)
            lock.withLock { expiresAt = next }
        } catch let failure as ApiFailure {
            switch failure.status {
            case 401: throw failure
            case 403: lock.withLock { expiresAt = 0 }
            case 409: lock.withLock { extendable = false }
            default: break // tried again at the next renew, between sentences
            }
        } catch {
            // No answer (a network failure): tried again at the next renew, between sentences; the upload retries too.
        }
    }
}
