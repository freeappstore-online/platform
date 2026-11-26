import Foundation

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

/// One job on this phone's contribution record. `status`: uploading, then the server's pending/accepted/rejected/superseded;
/// or skipped/failed locally.
struct Contribution: Equatable {
    let jobId: String
    let appId: String
    let key: String
    let at: Int64
    var status: String
    var reason = ""
}

/// Where the record lives: `LocalStore` on the phone, a dictionary in tests.
protocol ContributionLog: AnyObject {
    /// Whether this job was ever started on this phone. Such a job is never generated or uploaded again.
    func handled(_ jobId: String) -> Bool
    func record(_ contribution: Contribution) throws
    func updateStatus(_ jobId: String, status: String, reason: String) throws
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

    /// Extends the job's lease (#783) and returns its new expiry. `403`: the lease is gone; `409`: it is at its cap.
    func extend(_ appId: String, job: GenerationJob) async throws -> Int64 {
        let result = try await api.request("POST", "/apps/\(appId)/generation/jobs/\(job.id)/lease", token: try token(),
                                           headers: ["X-Lease-Token": job.leaseToken])
        return try Self.epochMs(result["leaseExpiresAt"])
    }

    /// Copies the server's verdicts on this account's submissions into `log`.
    func refresh(_ appId: String, log: ContributionLog) async throws {
        let result = try await api.request("GET", "/apps/\(appId)/generation/submissions", token: try token())
        for s in result["submissions"] as? [[String: Any]] ?? [] {
            guard let jobId = s["jobId"] as? String, !jobId.isEmpty else { continue }
            try log.updateStatus(jobId, status: s["status"] as? String ?? "", reason: String((s["reason"] as? String ?? "").prefix(120)))
        }
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
    /// server's characters-per-second floor and Whisper hears it whole. Audio up to 3 s is never too long for its text.
    static let minSeconds = 1.0

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

/// The claim → generate → encode → submit loop for one app.
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

    /// `stopReason` names why `keepGoing` turned false, for the record. While `hot()` (the phone is too warm) the work
    /// waits between sentences and before claiming, checking every `coolDown` and keeping the lease alive, then goes on.
    init(client: GenerationClient, log: ContributionLog, synth: Synthesizer, encoder: @escaping (URL, Int) throws -> AudioSink, workDir: URL,
         attestation: Attestation = .none, now: @escaping () -> Int64 = CompanionRepository.now,
         stopReason: @escaping () -> String = { "stopped" }, hot: @escaping () -> Bool = { false }, coolDown: Duration = .seconds(10)) {
        self.client = client; self.log = log; self.synth = synth; self.encoder = encoder; self.workDir = workDir
        self.attestation = attestation; self.now = now; self.stopReason = stopReason; self.hot = hot; self.coolDown = coolDown
    }

    /// Works through `appId`'s open jobs until none is left, `keepGoing` turns false, or a job is not submitted (it keeps
    /// its lease until expiry, so the next run continues). Returns how many were submitted. A `401` is thrown.
    func run(_ appId: String, keepGoing: @escaping () -> Bool, progress: (GenerationJob) -> Void = { _ in }) async throws -> Int {
        var submitted = 0
        while keepGoing() {
            while hot() && keepGoing() { try await Task.sleep(for: coolDown) }
            if !keepGoing() { break }
            guard let job = try await client.claim(appId, models: [synth.model]) else { break }
            progress(job)
            guard try await process(appId, job, keepGoing) else { break }
            submitted += 1
        }
        return submitted
    }

    private func process(_ appId: String, _ job: GenerationJob, _ keepGoing: @escaping () -> Bool) async throws -> Bool {
        let handled = log.handled(job.id)
        if let reason = GenerationPolicy.refusal(job, synth: synth, handled: handled, now: now()) {
            if !handled { try log.record(Contribution(jobId: job.id, appId: appId, key: job.key, at: now(), status: "skipped", reason: reason)) }
            return false
        }
        let file = workDir.appendingPathComponent("contribution.m4a")
        defer { try? FileManager.default.removeItem(at: file) }
        let lease = Lease(client: client, appId: appId, job: job, now: now)
        do {
            guard let segments = try await narrate(job, file, lease, keepGoing) else {
                try log.record(Contribution(jobId: job.id, appId: appId, key: job.key, at: now(), status: "skipped", reason: keepGoing() ? "lease_expired" : stopReason()))
                return false
            }
            let meta: [String: Any] = ["segments": segments]
            try await lease.renew()
            let bytes = ((try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? NSNumber)?.int64Value ?? 0
            let metaBytes = try JSONSerialization.data(withJSONObject: meta).count
            let refusal: String? = if bytes > job.maxBytes || metaBytes > GenerationPolicy.maxMetaBytes {
                "too_large"
            } else if !lease.held { "lease_expired" } else { nil }
            if let refusal { try log.record(Contribution(jobId: job.id, appId: appId, key: job.key, at: now(), status: "skipped", reason: refusal)); return false }
            // Recorded before the upload starts, so a crash mid-upload can never lead to a second, different file.
            try log.record(Contribution(jobId: job.id, appId: appId, key: job.key, at: now(), status: "uploading"))
            _ = try await client.submit(appId, job: job, file: file, contentType: GenerationPolicy.contentType, meta: meta,
                                        attestation: attestation.token(appId, job))
            try log.updateStatus(job.id, status: "pending", reason: "")
            return true
        } catch {
            if (error as? ApiFailure)?.status == 401 { throw error }
            let reason = String((((error as? ApiFailure).map { "\($0.status) " } ?? "") + error.localizedDescription).prefix(120))
            if log.handled(job.id) { try log.updateStatus(job.id, status: "failed", reason: reason) }
            else { try log.record(Contribution(jobId: job.id, appId: appId, key: job.key, at: now(), status: "failed", reason: reason)) }
            return false
        }
    }

    /// The job's own input, verbatim: the only text this path can generate. Narrated a sentence at a time as Books does
    /// (#785), the sentences joined by its pauses, each one encoded into `file` as soon as it is synthesized. Returns
    /// `[charStart, charEnd, startSec, endSec]` for each sentence, or nil when stopped or the lease ran out.
    private func narrate(_ job: GenerationJob, _ file: URL, _ lease: Lease, _ keepGoing: @escaping () -> Bool) async throws -> [[Any]]? {
        var segments: [[Any]] = []
        var sink: AudioSink?
        defer { sink?.close() }
        var rate = 24_000
        var length = 0
        var pause = 0 // written before the next sentence, so none follows the last
        let text = job.text as NSString
        guard let language = synth.language(job.params, tag: job.language) else { return nil } // refused before this
        for s in Sentences.split(job.text, language: language) {
            while hot() && keepGoing() && lease.held {
                try await lease.renew()
                try await Task.sleep(for: coolDown)
            }
            try await lease.renew()
            guard let audio = try synth.synthesize(text.substring(with: NSRange(location: s.start, length: s.end - s.start)), params: job.params,
                                                   language: language, keepGoing: { keepGoing() && lease.held }) else { return nil }
            if audio.samples.isEmpty { continue } // nothing to say, e.g. "* * *"
            let out: AudioSink
            if let sink { out = sink } else { out = try encoder(file, audio.sampleRate); sink = out; rate = audio.sampleRate }
            if pause > 0 { try out.write([Float](repeating: 0, count: pause)); length += pause }
            segments.append([s.start, s.end, seconds(length, rate), seconds(length + audio.samples.count, rate)])
            try out.write(audio.samples)
            length += audio.samples.count
            pause = Int((s.endsParagraph ? GenerationPolicy.paragraphPause : GenerationPolicy.sentencePause) * Double(rate))
        }
        if sink == nil { sink = try encoder(file, rate) }
        let short = Int(GenerationPolicy.minSeconds * Double(rate)) - length
        if short > 0 { try sink?.write([Float](repeating: 0, count: short)) }
        try sink?.finish()
        return segments
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
    var held: Bool { lock.withLock { now() < expiresAt - GenerationPolicy.leaseMarginMs } }

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
            default: break
            }
        } catch {}
    }
}
