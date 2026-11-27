import AVFoundation
import SQLite3
import CryptoKit
import XCTest
@testable import FreeAppStore

/// #733: the contribute loop against a stubbed API, the job policy, Kokoro params, the model install and the encoder.
/// A port of the Android companion's ContributeTest.kt.
final class ContributeTests: XCTestCase {
    private let now: Int64 = 1_000_000_000_000
    private var dir: URL!
    private var log: FakeLog!
    private var synth: FakeSynth!
    private var sinks: [FakeSink] = []
    private var api: FasApi!
    private var server: FakeServer!

    final class FakeLog: ContributionLog {
        var rows: [String: Contribution] = [:]
        func handled(_ jobId: String) -> Bool { rows[jobId] != nil }
        func record(_ contribution: Contribution) { rows[contribution.jobId] = contribution }
        func updateStatus(_ jobId: String, status: String, reason: String, submissionId: String?, durationMs: Int64?, input: String?,
                          report: SubmissionReport?) {
            rows[jobId]?.status = status; rows[jobId]?.reason = reason
            if let submissionId { rows[jobId]?.submissionId = submissionId }
            if let report { rows[jobId]?.report = report }
            if let durationMs { rows[jobId]?.durationMs = durationMs }
            if let input, rows[jobId]?.input == "" { rows[jobId]?.input = input }
        }
        func saveAttempt(_ jobId: String, _ record: AttemptRecord) { rows[jobId]?.record = record }
    }

    final class FakeSynth: Synthesizer {
        let model = KokoroModel.id
        var spoken: [String] = []
        var languages: [Language] = []
        /// Replaces the default: one sample per character, nil once `keepGoing` is false.
        var say: ((String, () -> Bool) throws -> Audio?)?
        /// What `load` does and answers (#827); nil answers false, as a lazily loading model.
        var loads: (() -> Bool)?
        func load(_ language: Language) -> Bool { loads?() ?? false }
        func accepts(_ params: [String: Any]) -> Bool { KokoroModel.params(params) != nil }
        func language(_ params: [String: Any], tag: String?) -> Language? { KokoroModel.language(params, tag: tag) }
        func synthesize(_ text: String, params: [String: Any], language: Language, keepGoing: @escaping () -> Bool) throws -> Audio? {
            spoken.append(text); languages.append(language)
            if let say { return try say(text, keepGoing) }
            return keepGoing() ? Audio(samples: [Float](repeating: 0, count: text.utf16.count), sampleRate: 24_000) : nil
        }
    }

    /// Writes a byte per sample, so a file's size is its length in samples.
    final class FakeSink: AudioSink {
        let rate: Int
        private let out: FileHandle
        var writes: [Int] = []
        var finished = false
        var closed = false
        var onWrite: () -> Void = {}
        init(_ file: URL, _ rate: Int) throws {
            self.rate = rate
            FileManager.default.createFile(atPath: file.path, contents: nil)
            out = try FileHandle(forWritingTo: file)
        }
        func write(_ samples: [Float]) throws { onWrite(); writes.append(samples.count); try out.write(contentsOf: Data(repeating: 7, count: samples.count)) }
        func finish() { finished = true }
        func close() { closed = true; try? out.close() }
    }

    struct Upload { let path: String; let headers: [String: String]; let file: Data; let contentType: String; let meta: [String: Any]? }

    /// The contributor routes of `api.freeappstore.online`: `jobs` for app `books`, `appJobs` for any other.
    final class FakeServer {
        var jobs: [[String: Any]] = []
        var appJobs: [String: [[String: Any]]] = [:]
        /// The app of every claim, in order, failed ones included.
        var claimed: [String] = []
        var claims: [[String: Any]] = []
        var uploads: [Upload] = []
        var uploadFailure: (Int, String)?
        /// Answers for the next claims or uploads, before any job or `uploadFailure` (#819).
        var claimFailures: [StubProtocol.Stub] = []
        var uploadFailures: [StubProtocol.Stub] = []
        /// Every upload attempt, failed ones included.
        var attempts: [Upload] = []
        var submissions: [[String: Any]] = []
        var refreshes = 0
        /// Attempt records posted (#827), and whether that route fails.
        var events: [[String: Any]] = []
        var eventsFail = false
        /// Each events request's own timeout (#828).
        var eventTimeouts: [TimeInterval] = []
        /// Lease extensions asked for (path, `X-Lease-Token`), and what the next one answers: an expiry or a failure.
        var extensions: [(String, String?)] = []
        var extend: () -> Result<Int64, ApiFailure> = { .failure(ApiFailure(status: 500, message: "no extension expected")) }

        func handle(_ request: URLRequest) -> StubProtocol.Stub {
            guard request.value(forHTTPHeaderField: "Authorization") == "Bearer ndev_test" else { return .init(status: 400, json: ["error": "token"]) }
            let path = request.url!.path
            switch (request.httpMethod!, path) {
            case ("POST", _) where path.hasSuffix("/generation/claim"):
                let app = path.split(separator: "/")[2]
                claimed.append(String(app))
                if !claimFailures.isEmpty { return claimFailures.removeFirst() }
                claims.append((try? JSONSerialization.jsonObject(with: Self.body(request))) as? [String: Any] ?? [:])
                if app != "books" {
                    guard let next = appJobs[String(app)]?.first else { return .init(status: 204) }
                    appJobs[String(app)]!.removeFirst()
                    return .init(json: ["job": next])
                }
                return jobs.isEmpty ? .init(status: 204) : .init(json: ["job": jobs.removeFirst()])
            case ("POST", _) where path.hasSuffix("/generation/events"):
                eventTimeouts.append(request.timeoutInterval)
                if eventsFail { return .init(status: 500, json: ["error": "down"]) }
                let posted = ((try? JSONSerialization.jsonObject(with: Self.body(request))) as? [String: Any])?["events"] as? [[String: Any]] ?? []
                events += posted
                return .init(json: ["recorded": posted.count])
            case ("GET", "/v1/apps/books/generation/submissions"):
                refreshes += 1
                return .init(json: ["submissions": submissions])
            case ("POST", _) where path.hasSuffix("/lease"):
                extensions.append((path, request.value(forHTTPHeaderField: "X-Lease-Token")))
                switch extend() {
                case .success(let at): return .init(json: ["leaseExpiresAt": at])
                case .failure(let failure): return .init(status: failure.status, json: ["error": failure.message])
                }
            case ("PUT", _) where path.hasSuffix("/result"):
                let upload = Self.parse(request)
                attempts.append(upload)
                if !uploadFailures.isEmpty { return uploadFailures.removeFirst() }
                if let (status, message) = uploadFailure { return .init(status: status, json: ["error": message]) }
                uploads.append(upload)
                return .init(status: 202, json: ["submissionId": "sub-\(uploads.count)", "status": "pending"])
            default:
                return .init(status: 404, json: ["error": "unexpected \(request.httpMethod!) \(path)"])
            }
        }

        static func body(_ request: URLRequest) -> Data {
            guard let stream = request.httpBodyStream else { return request.httpBody ?? Data() }
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 65_536)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
            return data
        }

        /// The `file` and `meta` parts of a multipart body.
        static func parse(_ request: URLRequest) -> Upload {
            let type = request.value(forHTTPHeaderField: "Content-Type")!
            let boundary = Data("--\(type.components(separatedBy: "boundary=")[1])".utf8)
            let body = body(request)
            var file = Data(), contentType = "", meta: [String: Any]?
            var start = body.range(of: boundary)!.upperBound
            while let next = body.range(of: boundary, in: start..<body.endIndex) {
                let part = body[start..<next.lowerBound]
                let split = part.range(of: Data("\r\n\r\n".utf8))!
                let head = String(decoding: part[part.startIndex..<split.lowerBound], as: UTF8.self)
                let content = part[split.upperBound..<part.endIndex].dropLast(2) // the part's closing CRLF
                if head.contains("name=\"file\"") {
                    file = Data(content)
                    contentType = head.components(separatedBy: "Content-Type: ")[1].trimmingCharacters(in: .whitespacesAndNewlines)
                } else if head.contains("name=\"meta\"") {
                    meta = try? JSONSerialization.jsonObject(with: Data(content)) as? [String: Any]
                }
                start = next.upperBound
            }
            var headers: [String: String] = [:]
            for name in ["X-Lease-Token", "X-Attestation"] { headers[name] = request.value(forHTTPHeaderField: name) }
            return Upload(path: request.url!.path, headers: headers, file: file, contentType: contentType, meta: meta)
        }
    }

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        log = FakeLog(); synth = FakeSynth(); sinks = []
        server = FakeServer()
        StubProtocol.handler = { [server] in server!.handle($0) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        api = FasApi(configuration: configuration)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private var client: GenerationClient { GenerationClient(api: api, credential: { "ndev_test" }) }

    private func contributor(synth: Synthesizer? = nil, attestation: Attestation = .none, clock: (() -> Int64)? = nil,
                             stopReason: @escaping () -> String = { "stopped" }, hot: @escaping () -> Bool = { false },
                             sentence: @escaping (Int, Int, Double) -> Void = { _, _, _ in }, probes: DeviceProbes = DeviceProbes(),
                             audio: AttemptAudio? = nil) -> Contributor {
        let now = now
        return Contributor(client: client, log: log, synth: synth ?? self.synth, encoder: { [unowned self] file, rate in
            let sink = try FakeSink(file, rate); sink.onWrite = { [unowned self] in mono += 50 }; sinks.append(sink); return sink
        }, workDir: dir, attestation: attestation, now: clock ?? { now }, stopReason: stopReason, hot: hot, coolDown: .milliseconds(1),
           retry: NetworkRetry(sleep: { [unowned self] ms in waited += ms; t += ms; onWait() }), sentence: sentence, probes: probes, audio: audio)
    }

    /// The fake monotonic clock of `probes` (#827): each encoder write takes 50 ms.
    private var mono: Int64 = 0

    /// Network retry waits (#819): their total in ms, and a hook run after each step. They advance `t` instead of sleeping.
    private var waited: Int64 = 0
    private var onWait: () -> Void = {}

    private func job(_ id: String, text: String = "It was a bright cold day in April.", model: String = "kokoro", version: String = "v1.0",
                     params: [String: Any] = ["voice": "af_heart"], formats: [String] = ["audio/mp4"], maxBytes: Int64 = 1_000_000,
                     expires: Any? = nil, input: [String: Any]? = nil, language: String? = nil) -> [String: Any] {
        ["id": id, "setId": "set1", "key": "book/\(id)", "input": input ?? ["text": text], "model": model, "modelVersion": version,
         "params": params, "formats": formats, "maxBytes": maxBytes, "language": language ?? NSNull(), "leaseToken": "lease-\(id)",
         "leaseExpiresAt": expires ?? now + 15 * 60_000]
    }

    private func segments(_ upload: Upload) -> [[Double]] {
        (upload.meta?["segments"] as? [[NSNumber]] ?? []).map { $0.map(\.doubleValue) }
    }

    func testGeneratesExactlyTheClaimedInputAndSubmitsWithTheLease() async throws {
        server.jobs = [job("j1", text: "First chapter."), job("j2", text: "Second chapter.")]
        let submitted = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 2)
        XCTAssertEqual(synth.spoken, ["First chapter.", "Second chapter."])
        XCTAssertEqual(server.claims.count, 3) // the third claim found nothing (204)
        let models = server.claims[0]["models"] as? [[String: String]]
        XCTAssertEqual(models, [["model": "kokoro", "modelVersion": "v1.0"]])
        let upload = server.uploads[0]
        XCTAssertEqual(upload.path, "/v1/apps/books/generation/jobs/j1/result")
        XCTAssertEqual(upload.headers["X-Lease-Token"], "lease-j1")
        XCTAssertNil(upload.headers["X-Attestation"], "no attestation until #732")
        XCTAssertEqual(upload.contentType, "audio/mp4")
        XCTAssertEqual(upload.file.count, 24_000, "padded with silence to minSeconds")
        XCTAssertEqual(segments(upload), [[0, 14, 0, 0.001]])
        XCTAssertEqual(log.rows["j1"]?.status, "pending")
        XCTAssertEqual(log.rows["j1"]?.submissionId, "sub-1", "kept for the report (#831)")
        XCTAssertEqual(log.rows["j1"]?.key, "book/j1")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("contribution.m4a").path), "the temp file is removed")
    }

    func testAttestationHookAddsTheHeader() async throws {
        server.jobs = [job("j1")]
        _ = try await contributor(attestation: Attestation { app, j in "token-\(app)-\(j.id)" }).run(["books"], keepGoing: { true })
        XCTAssertEqual(server.uploads.first?.headers["X-Attestation"], "token-books-j1")
    }

    func testRefusesJobsItCannotHonourExactly() async throws {
        let cases: [String: [String: Any]] = [
            "model": job("a", model: "piper"), "version": job("b", version: "v0.19"), "format": job("c", formats: ["audio/ogg"]),
            "params": job("d", params: ["voice": "af_heart", "pitch": 2]), "voice": job("e", params: ["voice": "nobody"]),
            "input": job("f", input: ["text": "x", "extra": "y"]), "blank": job("g", text: " "),
            "lease": job("h", expires: now + 1_000), "max": job("i", maxBytes: 0),
        ]
        for (name, j) in cases {
            server.jobs = [j]
            let submitted = try await contributor().run(["books"], keepGoing: { true })
            XCTAssertEqual(submitted, 0, name)
            XCTAssertEqual(log.rows[j["id"] as! String]?.status, "skipped", name)
        }
        XCTAssertTrue(synth.spoken.isEmpty)
        XCTAssertTrue(server.uploads.isEmpty)
        XCTAssertEqual(log.rows["a"]?.reason, "model")
        XCTAssertEqual(log.rows["e"]?.reason, "params")
        XCTAssertEqual(log.rows["f"]?.reason, "input")
        // #827: each refusal's attempt record.
        XCTAssertEqual(log.rows["a"]?.record?.reason, "unsupported")
        XCTAssertEqual(log.rows["h"]?.record?.reason, "lease_cap")
        XCTAssertEqual(Set(server.events.map { $0["reason"] as? String }), ["unsupported", "lease_cap"])
    }

    func testNeverUploadsTwiceForOneJob() async throws {
        log.record(Contribution(jobId: "j1", appId: "books", key: "book/j1", at: now, status: "uploading"))
        server.jobs = [job("j1")]
        let submitted = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 0)
        XCTAssertTrue(server.uploads.isEmpty)
        XCTAssertTrue(synth.spoken.isEmpty)
        XCTAssertEqual(log.rows["j1"]?.status, "uploading") // untouched
    }

    func testTooLargeIsNotSubmitted() async throws {
        server.jobs = [job("j1", text: "A long sentence here.", maxBytes: 5)]
        let submitted = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 0)
        XCTAssertTrue(server.uploads.isEmpty)
        XCTAssertEqual(log.rows["j1"]?.reason, "too_large")
    }

    func testLeaseRunningOutDuringGenerationStops() async throws {
        var t = now
        server.jobs = [job("j1")]
        // The clock passes the lease margin before generation ends.
        synth.say = { _, keepGoing in t += 15 * 60_000; return keepGoing() ? Audio(samples: [0], sampleRate: 24_000) : nil }
        _ = try await contributor(clock: { t }).run(["books"], keepGoing: { true })
        XCTAssertTrue(server.uploads.isEmpty)
        XCTAssertEqual(log.rows["j1"]?.reason, "lease_expired")
    }

    func testStoppingEndsTheRunWithoutUploading() async throws {
        server.jobs = [job("j1")]
        var go = true
        synth.say = { _, keepGoing in go = false; return keepGoing() ? Audio(samples: [0], sampleRate: 24_000) : nil }
        _ = try await contributor(stopReason: { "user_stop" }).run(["books"], keepGoing: { go })
        XCTAssertTrue(server.uploads.isEmpty)
        XCTAssertEqual(log.rows["j1"]?.reason, "user_stop", "the runner's reason is recorded")
        XCTAssertEqual(server.events.first?["reason"] as? String, "user_stop")
        XCTAssertEqual(server.eventTimeouts, [2], "#828: a stopped run sends its record with a short timeout")
    }

    /// A hot phone pauses the work and keeps the lease alive; it goes on once cool, rather than stopping.
    func testAHotPhonePausesAndResumesKeepingTheLease() async throws {
        t = now
        server.jobs = [job("j1", text: "One. Two.")]
        server.extend = { [unowned self] in .success(t + 15 * 60_000) }
        var checks = 0
        // Hot for the first five checks before the second sentence, four minutes each: the lease would lapse unextended.
        let hot = { [unowned self] () -> Bool in
            guard synth.spoken.count == 1, checks < 5 else { return false }
            checks += 1; t += 4 * 60_000; return true
        }
        let submitted = try await contributor(clock: { [unowned self] in t }, hot: hot).run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 1)
        XCTAssertEqual(synth.spoken, ["One.", "Two."])
        XCTAssertGreaterThan(server.extensions.count, 0, "the lease is extended while paused")
        XCTAssertEqual(log.rows["j1"]?.status, "pending")
    }

    func testUploadFailureIsRecordedAndEndsTheRun() async throws {
        server.jobs = [job("j1"), job("j2")]
        server.uploadFailure = (409, "Lease expired.")
        let submitted = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 0)
        XCTAssertEqual(log.rows["j1"]?.status, "failed")
        XCTAssertEqual(log.rows["j1"]?.reason, "409 Lease expired.")
        XCTAssertNil(log.rows["j2"])
        XCTAssertEqual(server.events.first?["reason"] as? String, "server_4xx")
        XCTAssertEqual(server.events.first?["error"] as? String, "ApiFailure: Lease expired.")
    }

    func testExpiredConnectionIsThrown() async throws {
        server.jobs = [job("j1")]
        server.uploadFailure = (401, "expired")
        do {
            _ = try await contributor().run(["books"], keepGoing: { true })
            XCTFail("a 401 must be thrown")
        } catch let failure as ApiFailure { XCTAssertEqual(failure.status, 401) }
    }

    // MARK: Attempt records (#827)

    func testEndReasons() {
        for local in ["model", "format", "input", "params", "language", "max_bytes"] { XCTAssertEqual(GenerationPolicy.endReason(local), "unsupported", local) }
        for local in ["too_large", "user_stop", "thermal", "background_expired", "unplugged", "network"] { XCTAssertEqual(GenerationPolicy.endReason(local), local) }
        XCTAssertEqual(GenerationPolicy.endReason("lease_expired"), "lease_cap")
        XCTAssertEqual(GenerationPolicy.endReason("lease_expired", leaseRevoked: true), "lease_403")
        XCTAssertEqual(GenerationPolicy.endReason("opted_out"), "user_stop")
        XCTAssertEqual(GenerationPolicy.endReason("stopped"), "other")
        func reason(_ error: Error, _ stage: AttemptMeter.Stage) -> String { GenerationPolicy.endReason(error, stage: stage) }
        XCTAssertEqual(reason(ApiFailure(status: 403, message: ""), .upload), "lease_403")
        XCTAssertEqual(reason(ApiFailure(status: 403, message: ""), .start), "server_4xx")
        XCTAssertEqual(reason(ApiFailure(status: 409, message: ""), .upload), "server_4xx")
        XCTAssertEqual(reason(ApiFailure(status: 429, message: "", retryAfter: 5), .upload), "server_4xx")
        XCTAssertEqual(reason(ApiFailure(status: 503, message: ""), .upload), "server_5xx")
        XCTAssertEqual(reason(URLError(.timedOut), .upload), "network")
        XCTAssertEqual(reason(CompanionError("no"), .synth), "model_error")
        XCTAssertEqual(reason(CompanionError("no"), .encode), "encode_error")
        XCTAssertEqual(reason(CompanionError("no"), .start), "other")
    }

    /// A processed job's record: stage times on the fake clock, the probes at start and end, kept with the row and posted,
    /// and the audio with its segments kept for playback.
    func testAProcessedJobYieldsARecordWithStageTimesAndPostsIt() async throws {
        server.jobs = [job("j1", text: "One. Two.")]
        StubProtocol.handler = { [server, unowned self] request in
            if request.url!.path.hasSuffix("/result") { mono += 200 }
            return server!.handle(request)
        }
        synth.loads = { [unowned self] in mono += 300; return true }
        synth.say = { [unowned self] _, _ in mono += 1_000; return Audio(samples: [Float](repeating: 0, count: 24_000), sampleRate: 24_000) }
        var cpu: Int64 = 100, memory = 0, thermal = ["nominal", "fair"], power: [(Int?, Bool?)] = [(80, true), (79, true)], samples = 0
        let probes = DeviceProbes(clock: { [unowned self] in mono }, cpuMs: { defer { cpu += 300 }; return cpu },
                                  memoryMb: { memory += 10; return memory }, thermal: { thermal.removeFirst() }, power: { power.removeFirst() },
                                  background: { samples += 1; return samples == 2 }, network: { "wifi" })
        let kept = AttemptAudio(dir: dir.appendingPathComponent("kept"))
        let submitted = try await contributor(probes: probes, audio: kept).run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 1)
        let record = try XCTUnwrap(log.rows["j1"]?.record)
        XCTAssertEqual(record.reason, "submitted")
        XCTAssertEqual(record.runner, "ios")
        XCTAssertEqual(record.startedAt, now)
        XCTAssertEqual(record.loadMs, 300)
        XCTAssertEqual(record.synthMs, 2_000)
        XCTAssertEqual(record.encodeMs, 150, "a sentence, a pause and a sentence")
        XCTAssertEqual(record.uploadMs, 200)
        XCTAssertEqual(record.wallMs, 2_650)
        XCTAssertEqual(record.cpuMs, 1_500, "300 a reading: the start, four progress records (#835) and the end")
        XCTAssertEqual(record.model, "kokoro v1.0")
        XCTAssertEqual([record.sentencesDone, record.sentencesTotal], [2, 2])
        XCTAssertEqual(record.durationMs, 2_400)
        XCTAssertEqual(record.rtf ?? 0, 2_000.0 / 2_400, accuracy: 0.0001)
        XCTAssertEqual(record.bytes, Int64(server.uploads[0].file.count))
        XCTAssertEqual(record.peakMemMb, 40, "start, two sentences, end")
        XCTAssertEqual(record.background, true)
        XCTAssertEqual([record.thermalStart, record.thermalEnd], ["nominal", "fair"])
        XCTAssertEqual(record.batteryStart, 80)
        XCTAssertEqual(record.batteryEnd, 79)
        XCTAssertEqual(record.chargingEnd, true)
        XCTAssertEqual(record.network, "wifi")
        XCTAssertNil(record.error)
        XCTAssertNotNil(record.appVersion)
        XCTAssertTrue(record.os?.hasPrefix("iOS ") == true)
        XCTAssertFalse(record.device?.isEmpty ?? true)
        let event = try XCTUnwrap(server.events.first)
        XCTAssertEqual(server.events.count, 1)
        XCTAssertEqual(event["jobId"] as? String, "j1")
        XCTAssertEqual(event["reason"] as? String, "submitted")
        XCTAssertEqual(event["synthMs"] as? Int, 2_000)
        XCTAssertNil(event["error"], "unmeasured fields are left out")
        let allowed: Set = ["jobId", "runner", "reason", "error", "appVersion", "os", "device", "network", "thermalStart", "thermalEnd", "background",
                            "chargingStart", "chargingEnd", "batteryStart", "batteryEnd", "startedAt", "wallMs", "loadMs", "synthMs", "encodeMs",
                            "uploadMs", "cpuMs", "peakMemMb", "rtf", "bytes", "durationMs"]
        XCTAssertTrue(Set(event.keys).isSubset(of: allowed), "the server refuses any other field")
        let own = try XCTUnwrap(kept.load("j1"))
        XCTAssertEqual(try Data(contentsOf: own.audio), server.uploads[0].file)
        XCTAssertEqual(own.segments.map(\.range), [NSRange(location: 0, length: 4), NSRange(location: 5, length: 4)])
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("contribution.m4a").path))
    }

    /// #835: the job is on the record as `generating` from the claim, its record updated at each sentence, then it ends as
    /// before; its audio is playable from the moment it is encoded, before the upload.
    func testAJobIsInProgressFromTheClaimAndUpdatedAtEachSentence() async throws {
        server.jobs = [job("j1", text: "One. Two. Three.")]
        let kept = AttemptAudio(dir: dir.appendingPathComponent("kept"))
        var seen: [(String?, Int?, Int?)] = []
        synth.say = { [unowned self] text, _ in
            let row = log.rows["j1"]
            seen.append((row?.status, row?.record?.sentencesDone, row?.record?.sentencesTotal))
            XCTAssertEqual(row?.record?.model, "kokoro v1.0")
            XCTAssertEqual(row?.record?.leaseExpiresAt, now + 15 * 60_000)
            XCTAssertEqual(row?.input, "One. Two. Three.")
            return Audio(samples: [Float](repeating: 0, count: text.utf16.count), sampleRate: 24_000)
        }
        StubProtocol.handler = { [server] request in
            if request.url!.path.hasSuffix("/result") { XCTAssertNotNil(kept.load("j1"), "playable once encoded") }
            return server!.handle(request)
        }
        _ = try await contributor(audio: kept).run(["books"], keepGoing: { true })
        XCTAssertEqual(seen.map(\.0), ["generating", "generating", "generating"])
        XCTAssertEqual(seen.map(\.1), [0, 1, 2])
        XCTAssertEqual(seen.map(\.2), [3, 3, 3])
        XCTAssertEqual(log.rows["j1"]?.status, "pending")
        XCTAssertEqual(log.rows["j1"]?.record?.reason, "submitted")
        XCTAssertNil(server.events.first?["model"], "device-only fields are never sent")
    }

    func testASynthesisErrorIsModelErrorAndAFailedPostNeverFailsTheJob() async throws {
        server.jobs = [job("j1"), job("j2")]
        server.eventsFail = true
        synth.say = { text, _ in
            if self.synth.spoken.count == 1 { throw CompanionError("The voice model could not narrate this text.") }
            return Audio(samples: [Float](repeating: 0, count: text.utf16.count), sampleRate: 24_000)
        }
        let submitted = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 0)
        XCTAssertEqual(log.rows["j1"]?.status, "failed")
        XCTAssertEqual(log.rows["j1"]?.record?.reason, "model_error")
        XCTAssertEqual(log.rows["j1"]?.record?.error, "CompanionError: The voice model could not narrate this text.")
        XCTAssertTrue(server.events.isEmpty)

        server.eventsFail = false
        server.jobs = [job("j3")]
        synth.say = nil
        let again = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(again, 1, "the post fails or not, the job is done")
        XCTAssertEqual(server.events.map { $0["reason"] as? String }, ["submitted"])
    }

    func testKeepsTheLatestAttemptsAudio() throws {
        let kept = AttemptAudio(dir: dir.appendingPathComponent("kept"), keep: 2)
        for id in ["a", "b", "c"] {
            let file = dir.appendingPathComponent("\(id).tmp")
            try Data(id.utf8).write(to: file)
            try kept.save(id, file: file, segments: [[0, 1, 0.0, 0.5]])
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "moved, not copied")
        }
        XCTAssertNil(kept.load("a"), "the oldest beyond two goes")
        XCTAssertEqual(kept.load("c")?.segments.map(\.to), [0.5])
        XCTAssertEqual(try kept.load("b").map { try Data(contentsOf: $0.audio) }, Data("b".utf8))
    }

    // MARK: Network retries (#819)

    func testRetryDelayOnlyForPassingNetworkFailures() {
        func delay(_ error: Error, _ attempt: Int = 0) -> Int64? { GenerationPolicy.retryDelay(error, attempt: attempt) }
        for code: URLError.Code in [.cannotFindHost, .dnsLookupFailed, .timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost] {
            XCTAssertEqual(delay(URLError(code)), 2_000, "\(code)")
        }
        XCTAssertEqual(delay(URLError(.timedOut), 1), 4_000)
        XCTAssertEqual(delay(URLError(.timedOut), 9), 60_000, "capped")
        XCTAssertEqual(delay(ApiFailure(status: 503, message: "")), 2_000)
        XCTAssertEqual(delay(ApiFailure(status: 502, message: "", retryAfter: 30)), 30_000)
        XCTAssertEqual(delay(ApiFailure(status: 429, message: "", retryAfter: 5)), 5_000)
        XCTAssertNil(delay(ApiFailure(status: 429, message: "daily contribution limit reached")), "a 429 without Retry-After is final")
        for status in [400, 401, 403, 409, 413, 415] { XCTAssertNil(delay(ApiFailure(status: status, message: "")), "\(status)") }
        XCTAssertNil(delay(URLError(.badServerResponse)))
        XCTAssertNil(delay(CompanionError("no")))
    }

    /// DNS, a 503 and a 429 with Retry-After: the same file goes up again once they pass, generated once.
    func testPassingNetworkFailuresRetryTheSameFile() async throws {
        server.jobs = [job("j1", text: "First chapter.")]
        server.uploadFailures = [.init(offline: true), .init(status: 503, json: ["error": "busy"]),
                                 .init(status: 429, json: ["error": "slow down"], headers: ["Retry-After": "7"])]
        let submitted = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 1)
        XCTAssertEqual(synth.spoken, ["First chapter."], "generated once")
        XCTAssertEqual(sinks.count, 1)
        XCTAssertEqual(server.attempts.count, 4)
        XCTAssertEqual(Set(server.attempts.map(\.file)).count, 1, "never a different file")
        XCTAssertTrue(server.attempts.allSatisfy { $0.headers["X-Lease-Token"] == "lease-j1" })
        XCTAssertEqual(waited, 2_000 + 4_000 + 7_000)
        XCTAssertEqual(log.rows["j1"]?.status, "pending")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("contribution.m4a").path))
    }

    /// Offline until the lease is about to run out: given up with reason `network`, never past the lease, never generated again.
    func testNetworkDownUntilTheLeaseRunsOutGivesUpWithReasonNetwork() async throws {
        t = now
        server.jobs = [job("j1")]
        server.uploadFailures = Array(repeating: .init(offline: true), count: 100)
        let submitted = try await contributor(clock: { [unowned self] in t }).run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 0)
        XCTAssertEqual(synth.spoken.count, 1)
        XCTAssertGreaterThan(server.attempts.count, 5)
        XCTAssertLessThan(t, now + 15 * 60_000 - GenerationPolicy.leaseMarginMs, "no try after the lease's margin")
        XCTAssertEqual(log.rows["j1"]?.status, "failed")
        XCTAssertEqual(log.rows["j1"]?.reason, "network")
        XCTAssertEqual(log.rows["j1"]?.record?.reason, "network")
        XCTAssertEqual(server.refreshes, 1, "an answer may have been lost: the server's record is asked for")
    }

    /// A lost answer: the first upload arrived, so the retry finds the lease used; the server's verdict is copied.
    func testARetryThatFindsTheLeaseUsedTakesTheServersRecord() async throws {
        server.jobs = [job("j1")]
        server.uploadFailures = [.init(offline: true), .init(status: 403, json: ["error": "no valid lease for this job"])]
        server.submissions = [["jobId": "j1", "status": "pending"]]
        _ = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(server.attempts.count, 2)
        XCTAssertEqual(log.rows["j1"]?.status, "pending")
    }

    func testStoppingWhileWaitingToRetryEndsWithTheStopReason() async throws {
        server.jobs = [job("j1"), job("j2")]
        server.uploadFailures = Array(repeating: .init(offline: true), count: 100)
        var go = true
        onWait = { go = false }
        let submitted = try await contributor(stopReason: { "user_stop" }).run(["books"], keepGoing: { go })
        XCTAssertEqual(submitted, 0)
        XCTAssertEqual(server.attempts.count, 1)
        XCTAssertEqual(waited, 1_000, "stopped within a second's step")
        XCTAssertEqual(log.rows["j1"]?.status, "skipped")
        XCTAssertEqual(log.rows["j1"]?.reason, "user_stop")
        XCTAssertNil(log.rows["j2"])
    }

    func testClaimsAreRetriedThenTheRunFails() async throws {
        server.jobs = [job("j1")]
        server.claimFailures = [.init(offline: true), .init(status: 500, json: ["error": "oops"])]
        let submitted = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 1)
        XCTAssertEqual(waited, 2_000 + 4_000)

        server.jobs = [job("j2")]
        server.claimFailures = Array(repeating: .init(offline: true), count: 100)
        do {
            _ = try await contributor().run(["books"], keepGoing: { true })
            XCTFail("a claim still failing after its retries ends the run")
        } catch let error as URLError { XCTAssertEqual(error.code, .notConnectedToInternet) }
        XCTAssertEqual(server.claimed.count, 4 + GenerationPolicy.retryAttempts, "two failures, j1, none left; then every try")
        XCTAssertNil(log.rows["j2"])
    }

    // MARK: Round robin (#819)

    func testTakesOneJobFromEachAppInTurn() async throws {
        server.jobs = [job("b1"), job("b2"), job("b3")]
        server.appJobs = ["dialogue": [job("d1"), job("d2")], "notes": []]
        var progress: [String] = []
        let submitted = try await contributor().run(["books", "dialogue", "notes"], keepGoing: { true }) { app, job in progress.append("\(app)/\(job.id)") }
        XCTAssertEqual(submitted, 5)
        XCTAssertEqual(progress, ["books/b1", "dialogue/d1", "books/b2", "dialogue/d2", "books/b3"])
        XCTAssertEqual(server.claimed, ["books", "dialogue", "notes", "books", "dialogue", "books", "dialogue", "books"],
                       "an app with nothing left leaves the rotation")
    }

    /// #828: once a Run now's app leaves the screen, the job in hand finishes and nothing more is claimed.
    func testNothingIsClaimedOnceClaimsStop() async throws {
        server.jobs = [job("b1"), job("b2")]
        var claims = true
        synth.say = { _, keepGoing in
            claims = false // the app left the screen while the first job was generated
            return keepGoing() ? Audio(samples: [0], sampleRate: 24_000) : nil
        }
        let submitted = try await contributor().run(["books"], keepGoing: { true }, mayClaim: { claims })
        XCTAssertEqual(submitted, 1)
        XCTAssertEqual(server.claimed, ["books"])
    }

    func testAnAppTurnedOffLeavesTheRotation() async throws {
        server.jobs = [job("b1"), job("b2")]
        server.appJobs = ["dialogue": [job("d1"), job("d2")]]
        var on: Set = ["books", "dialogue"]
        synth.say = { text, keepGoing in
            on.remove("dialogue") // turned off while the first job is generated
            return keepGoing() ? Audio(samples: [0], sampleRate: 24_000) : nil
        }
        let submitted = try await contributor().run(["dialogue", "books"], keepGoing: { true }, optedIn: { on.contains($0) })
        XCTAssertEqual(submitted, 2)
        XCTAssertEqual(log.rows["d1"]?.reason, "opted_out")
        XCTAssertEqual(server.claimed, ["dialogue", "books", "books", "books"])
        XCTAssertNil(log.rows["d2"])
    }

    func testSplitsSentencesLikeBooks() {
        // Expected: Books' scripts/audio/segments.py (`sentences`, then `utf16`) on the same texts, as in the Android test.
        func s(_ start: Int, _ end: Int, _ paragraph: Bool) -> Sentences.Sentence { .init(start: start, end: end, endsParagraph: paragraph) }
        let en = "Mr. Brown met L. Frank Baum.  “Oh dear!” said the Rabbit. It was I.\n\nA new paragraph… Then more?! Yes 😀 indeed. (Quite.)\n \n* * *\n\nEnd"
        XCTAssertEqual(Sentences.split(en, language: .english), [s(0, 28, false), s(30, 57, false), s(58, 67, true), s(69, 85, false), s(86, 97, false),
                                                             s(98, 112, false), s(113, 121, true), s(124, 129, true), s(131, 134, true)])
        let es = "—¿Quién es? —dijo el Sr. Pérez. Nadie respondió.\n\nD. Juan llegó. —Hola —dijo. ¡Ya!"
        XCTAssertEqual(Sentences.split(es, language: .spanish), [s(0, 31, false), s(32, 48, true), s(50, 64, false), s(65, 77, false), s(78, 82, true)])
        XCTAssertTrue(Sentences.split(" \n\n ", language: .english).isEmpty)
    }

    /// #812: Dialogue's lines (web/src/dialogue/phrases.json and scenarios); offsets are UTF-16 code units.
    func testSplitsMandarinSentences() {
        func s(_ start: Int, _ end: Int, _ paragraph: Bool = false) -> Sentences.Sentence { .init(start: start, end: end, endsParagraph: paragraph) }
        func split(_ text: String) -> [Sentences.Sentence] { Sentences.split(text, language: .mandarin) }
        XCTAssertEqual(split("对。"), [s(0, 2, true)])
        XCTAssertEqual(split("八号线。八，八。"), [s(0, 4), s(4, 8, true)])
        XCTAssertEqual(split("三点以后……四点半可以吗？"), [s(0, 6), s(6, 13, true)])
        XCTAssertEqual(split("不好意思，明天上午已经约满了。下午两点可以吗？"), [s(0, 15), s(15, 23, true)])
        XCTAssertEqual(split("二号口，出去左转。谢谢！"), [s(0, 9), s(9, 12, true)])
        XCTAssertEqual(split("可以约的时间有三个：明天两点、明天四点半、后天十点。"), [s(0, 26, true)], "no comma or colon ends one")
        XCTAssertEqual(split("好的；谢谢。"), [s(0, 3), s(3, 6, true)])
        XCTAssertEqual(split("他说：“好。”好的!谢谢?3.5元。"), [s(0, 7), s(7, 10), s(10, 13), s(13, 18, true)],
                       "closing quotes stay; ASCII marks; a decimal point")
        XCTAssertEqual(split("你好！ 谢谢。\n\n再见。"), [s(0, 3), s(4, 7, true), s(9, 12, true)], "spaces and paragraphs")
        XCTAssertEqual(split("𠀀好。你好！"), [s(0, 4), s(4, 7, true)], "a character outside the BMP is two code units")
    }

    func testKokoroLanguageFromTheSetOrTheVoice() throws {
        func lang(_ voice: String, _ tag: String?) -> Language? { KokoroModel.language(["voice": voice], tag: tag) }
        XCTAssertEqual(lang("zf_xiaobei", "zh"), .mandarin)
        XCTAssertEqual(lang("zm_yunxi", "zh-Hans"), .mandarin)
        XCTAssertEqual(lang("zm_yunxi", "ZH-cn"), .mandarin)
        XCTAssertEqual(lang("zf_xiaobei", nil), .mandarin, "no language: by voice")
        XCTAssertEqual(lang("ef_dora", nil), .spanish)
        XCTAssertEqual(lang("em_alex", "es-MX"), .spanish)
        XCTAssertEqual(lang("af_heart", nil), .english)
        XCTAssertEqual(lang("bm_george", "en-GB"), .english)
        XCTAssertEqual(lang("ff_siwis", nil), .english, "unchanged for sets naming no language")
        for (voice, tag) in [("af_heart", "zh"), ("zf_xiaobei", "en"), ("zf_xiaobei", "yue"), ("jf_alpha", "ja"), ("ff_siwis", "fr"),
                             ("ff_siwis", "en"), ("ef_dora", "en"), ("af_heart", "es")] {
            XCTAssertNil(lang(voice, tag), "\(voice) \(tag)")
        }
        XCTAssertNil(KokoroModel.language([:], tag: nil))
        XCTAssertEqual(try GenerationClient.parseJob(job("j1", language: "zh-Hans")).language, "zh-Hans")
        XCTAssertNil(try GenerationClient.parseJob(job("j1")).language)
        var absent = job("j1")
        absent["language"] = nil
        XCTAssertNil(try GenerationClient.parseJob(absent).language, "absent, as before #810")
    }

    func testMandarinSetsAreSpokenAMandarinSentenceAtATime() async throws {
        server.jobs = [job("j1", text: "一号线，三站。明白了，谢谢！", params: ["voice": "zm_yunxi"], language: "zh"),
                       job("j2", text: "请问，洗手间在哪里？", params: ["voice": "zf_xiaobei"])] // no language: the voice says
        let submitted = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 2)
        XCTAssertEqual(synth.spoken, ["一号线，三站。", "明白了，谢谢！", "请问，洗手间在哪里？"])
        XCTAssertEqual(synth.languages, [.mandarin, .mandarin, .mandarin])
        XCTAssertEqual(segments(server.uploads[0]).map { [$0[0], $0[1]] }, [[0, 7], [7, 14]])
    }

    func testSkipsSetsInALanguageItCannotSpeak() async throws {
        let cases = [job("a", text: "你好！", language: "zh"), job("b", text: "こんにちは。", params: ["voice": "jf_alpha"], language: "ja"),
                     job("c", text: "你好！", params: ["voice": "zf_xiaobei"], language: "yue"),
                     job("d", text: "Hello.", params: ["voice": "zf_xiaobei"], language: "en")]
        for j in cases {
            server.jobs = [j]
            let submitted = try await contributor().run(["books"], keepGoing: { true })
            XCTAssertEqual(submitted, 0)
            XCTAssertEqual(log.rows[j["id"] as! String]?.reason, "language", j["id"] as! String)
        }
        XCTAssertTrue(synth.spoken.isEmpty)
        XCTAssertTrue(server.uploads.isEmpty)
    }

    func testATwoCharacterPhrasePassesTheServerDurationChecks() async throws {
        server.jobs = [job("j1", text: "对。", params: ["voice": "zf_xiaobei"], language: "zh")]
        synth.say = { _, _ in Audio(samples: [Float](repeating: 0, count: 6_000), sampleRate: 24_000) } // Kokoro says 对。 in about a quarter of a second
        let submitted = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 1)
        let upload = try XCTUnwrap(server.uploads.first)
        let seconds = Double(upload.file.count) / 24_000
        XCTAssertEqual(seconds, 1, "the speech, then silence to a second")
        XCTAssertEqual(sinks.first?.writes, [6_000, 18_000])
        // generation-verify.ts: at most 9 characters a second for zh, and audio up to 3 s is never too long.
        XCTAssertTrue(Double("对。".utf16.count) / seconds <= 9 && seconds <= 3)
        XCTAssertEqual(segments(upload), [[0, 2, 0, 0.25]])
    }

    func testNarratesASentenceAtATimeAndSendsBooksTimings() async throws {
        server.jobs = [job("j1", text: "One two. Three!\n\n* * *\n\nFour.")]
        synth.say = { text, _ in Audio(samples: [Float](repeating: 0, count: text == "* * *" ? 0 : text.count * 2_400), sampleRate: 24_000) } // 0.1 s a character
        var progress: [[Double]] = []
        _ = try await contributor(sentence: { progress.append([Double($0), Double($1), $2]) }).run(["books"], keepGoing: { true })
        // #820: the status card's sentence n of N, with the audio made so far.
        XCTAssertEqual(progress.map { [$0[0], $0[1]] }, [[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]])
        XCTAssertEqual(progress.last?[2] ?? 0, 3.1, accuracy: 0.001)
        XCTAssertEqual(synth.spoken, ["One two.", "Three!", "* * *", "Four."])
        // 0.8 s, 0.4 s pause, 0.6 s, 0.8 s paragraph pause, "* * *" left out, 0.5 s; no pause at the end.
        let upload = try XCTUnwrap(server.uploads.first)
        XCTAssertEqual(segments(upload), [[0, 8, 0.0, 0.8], [9, 15, 1.2, 1.8], [24, 29, 2.6, 3.1]])
        XCTAssertEqual(Double(upload.file.count), 3.1 * 24_000, accuracy: 0.5)
        // Each sentence and pause goes to the encoder as it comes, never the chapter joined in memory.
        let sink = try XCTUnwrap(sinks.first)
        XCTAssertEqual(sinks.count, 1)
        XCTAssertEqual(sink.rate, 24_000)
        XCTAssertEqual(sink.writes, [19_200, 9_600, 14_400, 19_200, 12_000])
        XCTAssertTrue(sink.finished && sink.closed)
        // #820: what Activity shows about the job.
        let row = try XCTUnwrap(log.rows["j1"])
        XCTAssertEqual(row.input, "One two. Three!\n\n* * *\n\nFour.")
        XCTAssertEqual(row.setId, "set1")
        XCTAssertEqual(row.durationMs, 3_100)
        XCTAssertEqual(row.bytes, Int64(upload.file.count))
    }

    func testMetaOverTheServerLimitIsNotSubmitted() async throws {
        server.jobs = [job("j1", text: String(repeating: "Go. ", count: 4_000).trimmingCharacters(in: .whitespaces), maxBytes: Int64.max)]
        synth.say = { _, _ in Audio(samples: [0], sampleRate: 10) } // 10 Hz keeps the audio small; 4,000 segments are about 100 KB of JSON
        let submitted = try await contributor().run(["books"], keepGoing: { true })
        XCTAssertEqual(submitted, 0)
        XCTAssertTrue(server.uploads.isEmpty)
        XCTAssertEqual(log.rows["j1"]?.reason, "too_large")
    }

    private var t: Int64 = 0
    /// A job of `sentences` sentences, each taking `minutes` of the 15-minute lease to say.
    private func timedRun(sentences: Int, minutes: Int64) async throws -> Int {
        t = now
        server.jobs = [job("j1", text: (1...sentences).map { "Sentence \($0)." }.joined(separator: " "))]
        synth.say = { [unowned self] _, keepGoing in t += minutes * 60_000; return keepGoing() ? Audio(samples: [0], sampleRate: 24_000) : nil }
        return try await contributor(clock: { [unowned self] in t }).run(["books"], keepGoing: { true })
    }

    func testExtendsTheLeaseWithinFiveMinutesOfExpiry() async throws {
        server.extend = { [unowned self] in .success(t + 15 * 60_000) }
        // 6 min a sentence: the lease is extended before the third (3 min left) and lasts to the upload.
        let submitted = try await timedRun(sentences: 3, minutes: 6)
        XCTAssertEqual(submitted, 1)
        XCTAssertEqual(server.extensions.map(\.0), ["/v1/apps/books/generation/jobs/j1/lease"])
        XCTAssertEqual(server.extensions.map(\.1), ["lease-j1"])
        XCTAssertEqual(log.rows["j1"]?.status, "pending")
    }

    func testALeaseTheServerRefusesStopsWithoutUploading() async throws {
        server.extend = { .failure(ApiFailure(status: 403, message: "Lease expired.")) }
        let submitted = try await timedRun(sentences: 6, minutes: 2)
        XCTAssertEqual(submitted, 0)
        XCTAssertEqual(server.extensions.count, 1)
        XCTAssertTrue(server.uploads.isEmpty)
        XCTAssertEqual(log.rows["j1"]?.reason, "lease_expired")
        XCTAssertEqual(log.rows["j1"]?.record?.reason, "lease_403")
        let sink = try XCTUnwrap(sinks.first) // stopped part-way: the encoder is closed unfinished and its file removed
        XCTAssertTrue(sink.closed && !sink.finished)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("contribution.m4a").path))
    }

    func testALeaseAtItsCapIsUsedWhileItLasts() async throws {
        server.extend = { .failure(ApiFailure(status: 409, message: "Lease cap reached.")) }
        let submitted = try await timedRun(sentences: 6, minutes: 2) // done at 12 of 15 minutes
        XCTAssertEqual(submitted, 1)
        XCTAssertEqual(server.extensions.count, 1, "no retry after 409")
    }

    func testOtherExtensionFailuresAreRetriedAndDoNotStop() async throws {
        server.extend = { .failure(ApiFailure(status: 500, message: "Try again.")) }
        let submitted = try await timedRun(sentences: 6, minutes: 2)
        XCTAssertEqual(submitted, 1)
        XCTAssertEqual(server.extensions.count, 2, "before the last sentence and before the upload")
    }

    func testAnExpiredConnectionWhileExtendingIsThrown() async throws {
        server.extend = { .failure(ApiFailure(status: 401, message: "expired")) }
        do {
            _ = try await timedRun(sentences: 6, minutes: 2)
            XCTFail("a 401 must be thrown")
        } catch let failure as ApiFailure { XCTAssertEqual(failure.status, 401) }
    }

    func testRefreshCopiesVerdicts() async throws {
        log.record(Contribution(jobId: "j1", appId: "books", key: "book/j1", at: now, status: "pending"))
        log.record(Contribution(jobId: "j2", appId: "books", key: "book/j2", at: now, status: "pending"))
        server.submissions = [
            ["submissionId": "s1", "jobId": "j1", "status": "rejected", "reason": "audio is too long for the text"],
            ["jobId": "other", "status": "accepted"],
            ["id": "s2", "jobId": "j2", "status": "accepted", "reason": NSNull(), "createdAt": now],
        ]
        let sent = SubmissionReport(good: false, note: "Clipped", at: now)
        log.rows["j1"]?.report = sent
        try await client.refresh("books", log: log)
        XCTAssertEqual(log.rows["j1"]?.status, "rejected")
        XCTAssertEqual(log.rows["j1"]?.reason, "audio is too long for the text")
        XCTAssertEqual(log.rows["j1"]?.submissionId, "s1")
        XCTAssertEqual(log.rows["j1"]?.report, sent, "kept when the server gives none")
        XCTAssertNil(log.rows["other"], "only this phone's jobs")
        XCTAssertEqual(log.rows["j2"], Contribution(jobId: "j2", appId: "books", key: "book/j2", at: now, status: "accepted", reason: ""))
        server.submissions = [["submissionId": "s1", "jobId": "j1", "status": "accepted", "reason": NSNull(), "durationMs": 2_500,
                               "input": ["text": "Hello."], "report": ["good": true, "note": NSNull(), "at": now + 5]]]
        try await client.refresh("books", log: log)
        XCTAssertEqual(log.rows["j1"]?.report, SubmissionReport(good: true, note: nil, at: now + 5), "the server's report (#831)")
        XCTAssertEqual(log.rows["j1"]?.durationMs, 2_500)
        XCTAssertEqual(log.rows["j1"]?.input, "Hello.", "the text of a row recorded without it")
    }

    /// #831: Good / Not good with an optional note, on this account's own upload, with the device credential.
    func testReportSendsGoodAndNote() async throws {
        var bodies: [[String: Any]] = []
        StubProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.url?.path, "/v1/apps/books/generation/submissions/sub-1/report")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ndev_test")
            let body = (try? JSONSerialization.jsonObject(with: FakeServer.body(request))) as? [String: Any] ?? [:]
            bodies.append(body)
            return .init(json: ["report": ["good": body["good"] as? Bool ?? false, "note": body["note"] ?? NSNull(), "at": 42]])
        }
        let report = try await client.report("books", submissionId: "sub-1", good: false, note: "  Skips a word. ")
        XCTAssertEqual(report, SubmissionReport(good: false, note: "Skips a word.", at: 42))
        XCTAssertEqual(bodies.last?["note"] as? String, "Skips a word.")
        let good = try await client.report("books", submissionId: "sub-1", good: true, note: " ")
        XCTAssertEqual(good, SubmissionReport(good: true, note: nil, at: 42))
        XCTAssertNil(bodies.last?["note"], "no note when it is blank")
        _ = try await client.report("books", submissionId: "sub-1", good: true, note: String(repeating: "a", count: 600))
        XCTAssertEqual((bodies.last?["note"] as? String)?.count, 500)
        do {
            _ = try await client.report("books", submissionId: "../x", good: true, note: "")
            XCTFail("an odd submission id is refused")
        } catch is CompanionError {}
        StubProtocol.handler = { _ in .init(status: 404, json: ["error": "submission not found"]) }
        do {
            _ = try await client.report("books", submissionId: "sub-2", good: true, note: "")
            XCTFail("a 404 must be thrown")
        } catch let failure as ApiFailure { XCTAssertEqual(failure.status, 404) }
    }

    /// #820: Settings' open-job counts, only for sets this phone runs and app ids the contributor routes take.
    func testDiscoveryCountsOpenJobsThisPhoneCanRun() async throws {
        let set: (String, String, Int) -> [String: Any] = { model, version, open in ["setId": "s", "model": model, "modelVersion": version, "open": open] }
        StubProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/generation/open")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ndev_test")
            return .init(json: ["apps": [
                ["appId": "books", "sets": [set("kokoro", "v1.0", 3), set("kokoro", "v1.0", 2), set("piper", "v1", 9)]],
                ["appId": "dialogue", "sets": [set("kokoro", "v1.1", 4)]],
                ["appId": "Bad/..", "sets": [set("kokoro", "v1.0", 1)]],
            ]])
        }
        let counts = try await client.open(model: KokoroModel.id)
        XCTAssertEqual(counts, ["books": 5])
    }

    func testArtifactUrlsArePublicAndOnlyForValidIds() {
        XCTAssertEqual(GenerationClient.artifactURL("books", "j_1")?.absoluteString, "https://api.freeappstore.online/v1/apps/books/generation/artifacts/j_1")
        XCTAssertEqual(GenerationClient.artifactURL("books", "j_1", meta: true)?.absoluteString,
                       "https://api.freeappstore.online/v1/apps/books/generation/artifacts/j_1/meta")
        XCTAssertNil(GenerationClient.artifactURL("Books", "j1"))
        XCTAssertNil(GenerationClient.artifactURL("books", "../j1"))
    }

    func testActivityFiltersAndStatusCard() {
        XCTAssertEqual(["generating", "accepted", "uploading", "pending", "rejected", "skipped", "failed", "superseded"].map(ContributeFilter.of),
                       [.inProgress, .accepted, .checking, .checking, .rejected, .notDone, .notDone, .notDone])
        XCTAssertFalse(ContributeFilter.checking.shows("generating"), "#835: In progress is apart from Checking")
        // #835: a job in progress shows the time so far and its lease, not how it ended.
        let running = AttemptRecord(device: "iPhone15,3", startedAt: 10_000, wallMs: 2_000, cpuMs: 1_500, model: "kokoro v1.0", sentencesDone: 3,
                                    sentencesTotal: 12, leaseExpiresAt: 900_000)
        let live = Dictionary(uniqueKeysWithValues: ContributionDetailView.facts(running, now: 15_000).map { ($0.label, $0.value) })
        XCTAssertNil(live["Ended"])
        XCTAssertEqual(live["Elapsed"], 5.0.formatted(.number.precision(.fractionLength(1))) + " s")
        XCTAssertEqual(live["Model"], "kokoro v1.0")
        XCTAssertNotNil(live["Lease expires"])
        XCTAssertTrue(live["Ran on"]?.contains("iPhone15,3") == true)
        let done = Dictionary(uniqueKeysWithValues: ContributionDetailView.facts(running).map { ($0.label, $0.value) })
        XCTAssertEqual(done["Ended"], "other")
        XCTAssertNil(done["Lease expires"])
        XCTAssertEqual(ContributionDetailView.progress(done: 3, total: 12), "Sentence 4 of 12 · 25%")
        XCTAssertTrue(ContributeFilter.all.shows("failed"))
        XCTAssertFalse(ContributeFilter.accepted.shows("pending"))
        func state(running: Bool = false, cooling: Bool = false, hasApps: Bool = true, model: ModelState = .installed, lastStop: String? = nil,
                   charging: Bool = true) -> (title: String, why: String) {
            ContributeText.state(running: running, cooling: cooling, downloading: false, hasApps: hasApps, model: model, lastStop: lastStop,
                                 charging: charging, chargingOnly: true)
        }
        XCTAssertEqual(state(running: true).title, "Running")
        XCTAssertEqual(state(running: true, cooling: true).title, "Paused")
        XCTAssertEqual(state(hasApps: false).title, "Idle")
        XCTAssertEqual(state(model: .waiting).title, "Waiting")
        XCTAssertEqual(state(lastStop: "unplugged").why, "Stopped because the phone was unplugged.")
        XCTAssertTrue(state(charging: false).why.hasPrefix("Waiting for the phone to charge"))
        XCTAssertTrue(state(charging: true).why.contains("iOS decides when background runs start"), "#836: says what iOS controls")
    }

    /// #836: a background run asks iOS for the next one straight away only when it ended with jobs left; after nothing to
    /// claim, a failure or Stop it waits the normal 15 minutes, so the phone does not spin.
    func testTheNextBackgroundRunIsAskedForAtOnceOnlyWithJobsLeft() async throws {
        XCTAssertTrue(ContributeRunner.again(end: "background_expired", drained: true))
        XCTAssertTrue(ContributeRunner.again(end: "no_work", drained: false))
        XCTAssertFalse(ContributeRunner.again(end: "no_work", drained: true))
        for end in ["user_stop", "unplugged", "left_app", "401", "429 daily limit reached"] {
            XCTAssertFalse(ContributeRunner.again(end: end, drained: false), end)
        }
        let contributor = contributor()
        server.jobs = [job("j1")]
        _ = try await contributor.run(["books"], keepGoing: { true })
        XCTAssertTrue(contributor.drained, "every job submitted, then none open")
        server.jobs = [job("j2", expires: now + 10_000)]
        _ = try await contributor.run(["books"], keepGoing: { true })
        XCTAssertEqual(log.rows["j2"]?.reason, "lease_expired")
        XCTAssertFalse(contributor.drained, "a job not done: jobs may be left")
    }

    func testParsesIsoLeaseExpiryAndRejectsOddJobIds() throws {
        let parsed = try GenerationClient.parseJob(job("j1", expires: "2026-11-26T12:00:00Z"))
        XCTAssertEqual(parsed.leaseExpiresAt, Int64(ISO8601DateFormatter().date(from: "2026-11-26T12:00:00Z")!.timeIntervalSince1970 * 1000))
        XCTAssertThrowsError(try GenerationClient.parseJob(job("../native/device")))
    }

    func testApiOnlyLetsTheCredentialReachNativeAndGenerationRoutes() {
        XCTAssertEqual(FasApi.endpoint("/apps/books/generation/claim")?.absoluteString, "https://api.freeappstore.online/v1/apps/books/generation/claim")
        XCTAssertEqual(FasApi.endpoint("/generation/open")?.absoluteString, "https://api.freeappstore.online/v1/generation/open")
        for path in ["/auth/me", "/generation/openx", "/generation/open/x", "/generation/sets", "/apps/books/photos", "/apps/../native/x/generation/claim", "/apps/Books/generation/claim",
                     "/apps/books/generation/../../auth/me"] {
            XCTAssertNil(FasApi.endpoint(path), path)
        }
    }

    func testKokoroParams() {
        XCTAssertEqual(KokoroModel.params(["voice": "af_heart"]).map { [Float($0.sid), $0.speed] }, [3, 1])
        XCTAssertEqual(KokoroModel.params(["voice": "em_santa", "speed": 1.25]).map { [Float($0.sid), $0.speed] }, [53, 1.25])
        XCTAssertNil(KokoroModel.params([:]))
        XCTAssertNil(KokoroModel.params(["voice": "af_heart", "speed": 3]))
        XCTAssertNil(KokoroModel.params(["voice": "af_heart", "speed": "fast"]))
        XCTAssertNil(KokoroModel.params(["voice": "af_heart", "speed": true]))
        XCTAssertNil(KokoroModel.params(["voice": 3]))
        XCTAssertEqual(KokoroModel.voices.count, 54)
    }

    // MARK: Model install

    /// A ustar `.tar.bz2` of `entries`, written in the test so the extractor is checked against a real libbz2 stream.
    private func archive(_ entries: [(String, String)]) throws -> URL {
        var tar = Data()
        for (name, body) in entries {
            var header = [UInt8](repeating: 0, count: 512)
            func put(_ s: String, _ offset: Int) { for (i, byte) in s.utf8.enumerated() { header[offset + i] = byte } }
            put(name, 0); put("0000644", 100); put("0000000", 108); put("0000000", 116)
            put(String(format: "%011o", body.utf8.count), 124); put(String(format: "%011o", 0), 136)
            put("        ", 148); header[156] = UInt8(ascii: "0"); put("ustar", 257); put("00", 263)
            put(String(format: "%06o", header.reduce(0) { $0 + Int($1) }) + "\0 ", 148)
            tar.append(contentsOf: header)
            tar.append(Data(body.utf8))
            tar.append(Data(count: (512 - body.utf8.count % 512) % 512))
        }
        tar.append(Data(count: 1024))
        var compressed = [CChar](repeating: 0, count: tar.count + 4096)
        var length = UInt32(compressed.count)
        var source = tar.map { CChar(bitPattern: $0) }
        XCTAssertEqual(BZ2_bzBuffToBuffCompress(&compressed, &length, &source, UInt32(source.count), 9, 0, 0), BZ_OK)
        let url = dir.appendingPathComponent("model.tar.bz2")
        try Data(compressed.prefix(Int(length)).map { UInt8(bitPattern: $0) }).write(to: url)
        return url
    }

    func testModelInstallsOnlyWhenTheChecksumMatches() async throws {
        let source = try archive([("kokoro-multi-lang-v1_0/model.onnx", "weights"), ("kokoro-multi-lang-v1_0/tokens.txt", "a 1")])
        let model = KokoroModel(dir: dir.appendingPathComponent("kokoro"))
        do {
            _ = try await model.install(source: source, sha256: String(repeating: "0", count: 64))
            XCTFail("a wrong checksum must refuse the model")
        } catch {}
        XCTAssertFalse(model.installed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("kokoro").path))
        let installed = try await model.install(source: source, sha256: try KokoroModel.sha256(of: source))
        XCTAssertTrue(installed)
        XCTAssertTrue(model.installed)
        XCTAssertEqual(try String(contentsOf: model.root.appendingPathComponent("model.onnx"), encoding: .utf8), "weights")
        XCTAssertEqual(try dir.appendingPathComponent("kokoro").resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        model.delete()
        XCTAssertFalse(model.installed)
    }

    func testModelInstallRefusesPathsOutsideItsFolder() async throws {
        let source = try archive([("../escape.txt", "x")])
        let model = KokoroModel(dir: dir.appendingPathComponent("kokoro"))
        do {
            _ = try await model.install(source: source, sha256: try KokoroModel.sha256(of: source))
            XCTFail("a path outside the folder must refuse the model")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("escape.txt").path))
        XCTAssertFalse(model.installed)
    }

    func testModelInstallCanBeStopped() async throws {
        let source = try archive([("kokoro-multi-lang-v1_0/model.onnx", "weights")])
        let model = KokoroModel(dir: dir.appendingPathComponent("kokoro"))
        let installed = try await model.install(source: source, sha256: try KokoroModel.sha256(of: source), keepGoing: { false })
        XCTAssertFalse(installed)
        XCTAssertFalse(model.installed)
    }

    func testPinnedModel() {
        XCTAssertTrue(KokoroModel.url.absoluteString.hasPrefix("https://github.com/k2-fsa/sherpa-onnx/releases/download/"))
        XCTAssertNotNil(KokoroModel.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression))
    }

    // MARK: Encoder and the real model

    /// AAC-LC mono in an MP4, at the sample rate it was given, as the server's MP4 check expects.
    func testEncoderWritesAacInMp4() throws {
        let url = dir.appendingPathComponent("tone.m4a")
        let encoder = try AacEncoder(url: url, sampleRate: 24_000)
        for _ in 0..<4 { try encoder.write((0..<6_000).map { Float(sin(Double($0) * 2 * .pi * 440 / 24_000) * 0.5) }) }
        try encoder.finish()
        encoder.close()
        let file = try AVAudioFile(forReading: url)
        XCTAssertEqual(file.fileFormat.streamDescription.pointee.mFormatID, kAudioFormatMPEG4AAC)
        XCTAssertEqual(file.fileFormat.sampleRate, 24_000)
        XCTAssertEqual(file.fileFormat.channelCount, 1)
        XCTAssertEqual(Double(file.length), 24_000, accuracy: 2_048) // one second, give or take the codec's priming
        let data = try Data(contentsOf: url)
        XCTAssertEqual(String(decoding: data[4..<8], as: UTF8.self), "ftyp")
        var audioFile: AudioFileID?
        XCTAssertEqual(AudioFileOpenURL(url as CFURL, .readPermission, 0, &audioFile), noErr)
        var audioBytes: UInt64 = 0
        var size = UInt32(8)
        XCTAssertEqual(AudioFileGetProperty(audioFile!, kAudioFilePropertyAudioDataByteCount, &size, &audioBytes), noErr)
        AudioFileClose(audioFile!)
        // At most 32 kbps (#798), 4 KB a second. The file itself carries a padding atom besides.
        XCTAssertGreaterThan(audioBytes, 0)
        XCTAssertLessThanOrEqual(audioBytes, 4_300)
    }

    /// The real Kokoro model through sherpa-onnx, when TEST_RUNNER_FAS_KOKORO_ARCHIVE names a local copy of the pinned
    /// `kokoro-multi-lang-v1_0.tar.bz2`: install, narrate a sentence, encode it.
    func testRealKokoroNarratesAndEncodes() async throws {
        guard let path = ProcessInfo.processInfo.environment["FAS_KOKORO_ARCHIVE"] else { throw XCTSkip("FAS_KOKORO_ARCHIVE not set") }
        let model = KokoroModel(dir: FileManager.default.temporaryDirectory.appendingPathComponent("kokoro-test"))
        let installed = try await model.install(source: URL(fileURLWithPath: path))
        XCTAssertTrue(installed)
        let synth = KokoroSynthesizer(files: model)
        defer { synth.close(); model.delete() }
        let text = "It was a bright cold day in April, and the clocks were striking thirteen."
        let audio = try XCTUnwrap(try synth.synthesize(text, params: ["voice": "af_heart"], language: .english, keepGoing: { true }))
        XCTAssertEqual(audio.sampleRate, 24_000)
        let seconds = Double(audio.samples.count) / 24_000
        XCTAssertGreaterThan(Double(text.count) / seconds, 8) // the server's default characters-per-second band
        XCTAssertLessThan(Double(text.count) / seconds, 30)
        XCTAssertNil(try synth.synthesize(text, params: ["voice": "af_heart"], language: .english, keepGoing: { false }), "stopping returns nothing")
        // #812: Mandarin with Dialogue's voices, on the Mandarin engine; a two-character phrase is real speech too.
        for (zh, voice) in [("请问，洗手间在哪里？", "zf_xiaobei"), ("这个多少钱？", "zm_yunxi"), ("对。", "zf_xiaobei")] {
            let spoken = try XCTUnwrap(try synth.synthesize(zh, params: ["voice": voice], language: .mandarin, keepGoing: { true }))
            let seconds = Double(spoken.samples.count) / Double(spoken.sampleRate)
            XCTAssertGreaterThan(seconds, 0.15, zh)
            XCTAssertLessThan(Double(zh.count) / seconds, 9, zh) // the server's zh characters-per-second ceiling
        }
        XCTAssertNotNil(try synth.synthesize("Back to English.", params: ["voice": "af_heart"], language: .english, keepGoing: { true }))
        let url = dir.appendingPathComponent("kokoro.m4a")
        let encoder = try AacEncoder(url: url, sampleRate: audio.sampleRate)
        try encoder.write(audio.samples)
        try encoder.finish()
        XCTAssertEqual(Double(try AVAudioFile(forReading: url).length), Double(audio.samples.count), accuracy: 2_048)
    }
}

/// The contribution record in the real store (#733).
final class ContributionStoreTests: XCTestCase {
    func testDisconnectDeletesTheKeptAudio() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let kept = AttemptAudio(dir: directory.appendingPathComponent("kept"))
        let local = try LocalStore(directory: directory, attemptAudio: kept)
        defer { local.close() }
        let file = directory.appendingPathComponent("j1.tmp")
        try Data("a".utf8).write(to: file)
        try kept.save("j1", file: file, segments: [[0, 1, 0.0, 0.5]])
        try local.clearForReconnect()
        XCTAssertNotNil(kept.load("j1"), "the same account keeps its history")
        try local.clear()
        XCTAssertNil(kept.load("j1"), "Disconnect, or another account: the audio goes with the record")
    }

    func testRecordsJobsAndCountsToday() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let local = try LocalStore(directory: directory)
        defer { local.close() }
        XCTAssertFalse(local.handled("j1"))
        try local.record(Contribution(jobId: "j1", appId: "books", key: "book/1", at: 100, status: "uploading"))
        try local.record(Contribution(jobId: "j2", appId: "books", key: "book/2", at: 200, status: "skipped", reason: "params"))
        try local.updateStatus("j1", status: "accepted", reason: "")
        XCTAssertTrue(local.handled("j1"))
        XCTAssertEqual(try local.contributions().map(\.jobId), ["j2", "j1"])
        XCTAssertEqual(try local.contributions().last?.status, "accepted")
        XCTAssertEqual(try local.contributedSince("books", from: 50), 1, "skipped and failed jobs do not count")
        try local.setContributing("books", true)
        local.modelWanted = true
        XCTAssertEqual(local.contributeApps(), ["books"])
        // #820: Activity's fields, today's counts by status and the apps on the record.
        try local.record(Contribution(jobId: "j3", appId: "dialogue", key: "d/1", at: 300, status: "pending", input: "Hola.", setId: "s1",
                                      durationMs: 1_200, bytes: 4_096))
        try local.updateStatus("j3", status: "rejected", reason: "params", submissionId: "s3", durationMs: nil, input: "Other text.", report: nil)
        try local.updateStatus("j3", status: "rejected", reason: "params")
        try local.updateStatus("j1", status: "accepted", reason: "", submissionId: nil, durationMs: 900, input: "Server text.", report: nil)
        XCTAssertEqual(try local.contributions().last.map { [$0.input, String($0.durationMs)] }, ["Server text.", "900"])
        XCTAssertEqual(try local.contributions().first, Contribution(jobId: "j3", appId: "dialogue", key: "d/1", at: 300, status: "rejected", reason: "params",
                                                                      input: "Hola.", setId: "s1", durationMs: 1_200, bytes: 4_096, submissionId: "s3"))
        // #831: this phone's report, kept with the row; a refresh without one leaves it, one with it replaces it.
        let report = SubmissionReport(good: false, note: "Clipped at the end.", at: 400)
        try local.saveReport("j3", report)
        try local.updateStatus("j3", status: "rejected", reason: "params")
        XCTAssertEqual(try local.contributions().first?.report, report)
        try local.updateStatus("j3", status: "rejected", reason: "params", submissionId: "s3", durationMs: nil, input: nil,
                               report: SubmissionReport(good: true, note: nil, at: 500))
        XCTAssertEqual(try local.contributions().first?.report, SubmissionReport(good: true, note: nil, at: 500))
        XCTAssertEqual(try local.contributionCounts(since: 150), ["skipped": 1, "rejected": 1])
        XCTAssertEqual(try local.contributionApps(), ["books", "dialogue"])
        // #827: the attempt's record, kept with the row; a verdict leaves it as it is.
        var attempt = AttemptRecord(reason: "submitted", error: nil, network: "wifi", background: true, wallMs: 1_234, rtf: 0.5)
        attempt.peakMemMb = 300
        try local.saveAttempt("j3", attempt)
        try local.updateStatus("j3", status: "accepted", reason: "")
        XCTAssertEqual(try local.contributions().first?.record, attempt)
        XCTAssertEqual(try local.contributions(limit: 1, jobId: "j1").map(\.jobId), ["j1"])
        // #835: a job left in progress (a crash or a kill) is closed as not done, interrupted; others are left as they are.
        try local.record(Contribution(jobId: "j4", appId: "books", key: "book/4", at: 400, status: "generating"))
        XCTAssertEqual(try local.contributionCounts(since: 350), ["generating": 1])
        XCTAssertEqual(try local.contributedSince("books", from: 350), 0, "not done yet")
        try local.closeInterrupted()
        XCTAssertEqual(try local.contributions(limit: 1, jobId: "j4").first.map { [$0.status, $0.reason] }, ["skipped", "interrupted"])
        XCTAssertEqual(try local.contributions(limit: 1, jobId: "j3").first?.status, "accepted")
        XCTAssertTrue(local.chargingOnly)
        local.chargingOnly = false
        XCTAssertFalse(local.chargingOnly)
        try local.clear() // Disconnect
        XCTAssertFalse(local.handled("j1"))
        XCTAssertEqual(local.contributeApps(), [])
        XCTAssertFalse(local.modelWanted)
    }

    /// #820: a record kept since #733 gains Activity's columns and keeps its rows.
    func testMigratesAnOlderRecord() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(directory.appendingPathComponent(LocalStore.fileName).path, &db), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(db, """
            CREATE TABLE generation_jobs(job_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, job_key TEXT NOT NULL,
              at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '');
            INSERT INTO generation_jobs VALUES ('j1', 'books', 'book/1', 100, 'accepted', '');
            """, nil, nil, nil), SQLITE_OK)
        sqlite3_close(db)
        let local = try LocalStore(directory: directory)
        XCTAssertEqual(try local.contributions(), [Contribution(jobId: "j1", appId: "books", key: "book/1", at: 100, status: "accepted")])
        try local.record(Contribution(jobId: "j2", appId: "books", key: "book/2", at: 200, status: "pending", input: "Text", durationMs: 5))
        XCTAssertEqual(try local.contributions().first?.input, "Text")
        XCTAssertNil(try local.contributions().first?.record)
        try local.saveAttempt("j1", AttemptRecord(reason: "submitted"))
        XCTAssertEqual(try local.contributions().last?.record?.reason, "submitted")
        local.close()
        let reopened = try LocalStore(directory: directory) // the migration runs once
        XCTAssertEqual(try reopened.contributions().count, 2)
        reopened.close()
    }

    /// `freeappstore://native/contribute/<id>` asks; it never opts in by itself, and only takes an app id.
    @MainActor
    func testContributeLinkAsksAndNeverOptsIn() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let local = try LocalStore(directory: directory)
        let model = CompanionModel(repository: CompanionRepository(local: local, secure: SecureStore(service: "online.freeappstore.companion.contributetests")))
        model.handle(URL(string: "freeappstore://native/contribute/books")!)
        XCTAssertEqual(model.linkedContribute, "books")
        XCTAssertTrue(local.contributeApps().isEmpty)
        model.linkedContribute = nil
        model.handle(URL(string: "freeappstore://native/contribute/Books%2F..")!)
        XCTAssertNil(model.linkedContribute)
    }
}
