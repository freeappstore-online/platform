import CryptoKit
import Foundation
import SherpaOnnxC

/// Kokoro v1.0 (82M, multi-language) as packaged for sherpa-onnx (#733), the same model as the Android companion: the
/// weights Books' CI narration uses (`kokoro-v1.0.onnx`). Downloaded only when asked, from the pinned sherpa-onnx release
/// asset, checked against its pinned SHA-256 before anything is unpacked, and kept in backup-excluded storage under `dir`.
final class KokoroModel: @unchecked Sendable {
    static let id = ModelId(model: "kokoro", version: "v1.0")
    static let url = URL(string: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2")!
    static let sha256 = "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4"
    static let downloadBytes: Int64 = 349_886_476
    static let installedBytes: Int64 = 401_239_297
    private static let rootName = "kokoro-multi-lang-v1_0"
    /// Speaker ids of this model's `voices.bin`, from the sherpa-onnx model docs.
    static let voices = [
        "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah",
        "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
        "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora", "em_alex",
        "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune", "jf_nezumi",
        "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa", "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian",
        "zm_yunxi", "zm_yunxia", "zm_yunyang", "em_santa",
    ]

    /// A job's `params` as (speaker id, speed): `{ voice }` (a name above) and optionally `{ speed }` (0.5-2, default 1).
    /// Anything else, or a missing voice, returns nil and the job is refused: never a guess.
    static func params(_ params: [String: Any]) -> (sid: Int32, speed: Float)? {
        guard params.keys.allSatisfy({ $0 == "voice" || $0 == "speed" }),
              let voice = params["voice"] as? String, let sid = voices.firstIndex(of: voice) else { return nil }
        var speed: Float = 1
        if let value = params["speed"] {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            speed = number.floatValue
        }
        return (0.5...2).contains(speed) ? (Int32(sid), speed) : nil
    }

    /// Whether the job's voice is a Spanish one (`ef_…`, `em_…`), so its text is split into sentences the Spanish way.
    static func spanish(_ params: [String: Any]) -> Bool { (params["voice"] as? String)?.hasPrefix("e") == true }

    static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("kokoro", isDirectory: true)
    }

    let dir: URL
    var root: URL { dir.appendingPathComponent(Self.rootName, isDirectory: true) }
    private var marker: URL { dir.appendingPathComponent("installed") }
    var installed: Bool { FileManager.default.fileExists(atPath: marker.path) }

    init(dir: URL = KokoroModel.defaultDirectory) { self.dir = dir }

    /// Downloads, verifies and unpacks. `progress` gets bytes downloaded. Returns false when `keepGoing` stopped it.
    /// `cellular`: whether the download may use an expensive or constrained network (a tap on Download, not background work).
    func install(source: URL = KokoroModel.url, sha256: String = KokoroModel.sha256, cellular: Bool = true,
                 progress: @escaping (Int64) -> Void = { _ in }, keepGoing: @escaping () -> Bool = { true }) async throws -> Bool {
        if installed { return true }
        let files = FileManager.default
        try? files.removeItem(at: dir)
        try files.createDirectory(at: dir, withIntermediateDirectories: true)
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        var folder = dir
        try folder.setResourceValues(excluded)
        let archive = dir.appendingPathComponent("download.part")
        defer {
            try? files.removeItem(at: archive)
            if !installed { try? files.removeItem(at: dir) }
        }
        guard try await download(source, to: archive, cellular: cellular, progress: progress, keepGoing: keepGoing), keepGoing() else { return false }
        guard try Self.sha256(of: archive) == sha256 else {
            throw CompanionError("The voice model download did not match its checksum. Nothing was installed.")
        }
        try TarBz2.extract(archive, into: dir)
        guard files.createFile(atPath: marker.path, contents: nil) else { throw CompanionError("Could not save the voice model.") }
        return true
    }

    func delete() { try? FileManager.default.removeItem(at: dir) }

    private func download(_ source: URL, to archive: URL, cellular: Bool, progress: @escaping (Int64) -> Void,
                          keepGoing: @escaping () -> Bool) async throws -> Bool {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.allowsExpensiveNetworkAccess = cellular
        configuration.allowsConstrainedNetworkAccess = cellular
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 6 * 3600
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        return try await withCheckedThrowingContinuation { continuation in
            let task = session.downloadTask(with: source) { temporary, response, error in
                if let error {
                    if (error as? URLError)?.code == .cancelled { continuation.resume(returning: false) } else { continuation.resume(throwing: error) }
                    return
                }
                if let status = (response as? HTTPURLResponse)?.statusCode, status != 200 {
                    continuation.resume(throwing: CompanionError("Could not download the voice model (\(status)).")); return
                }
                do {
                    guard let temporary else { throw CompanionError("Could not download the voice model.") }
                    try FileManager.default.moveItem(at: temporary, to: archive)
                    continuation.resume(returning: true)
                } catch { continuation.resume(throwing: error) }
            }
            task.resume()
            Task.detached {
                var last: Int64 = 0
                while task.state == .running {
                    if !keepGoing() { task.cancel(); break }
                    let received = task.countOfBytesReceived
                    if received - last >= 4 * 1024 * 1024 { last = received; progress(received) }
                    try? await Task.sleep(for: .milliseconds(250))
                }
            }
        }
    }

    static func sha256(of file: URL) throws -> String {
        let input = try FileHandle(forReadingFrom: file)
        defer { try? input.close() }
        var hash = SHA256()
        while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty { hash.update(data: chunk) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// Unpacks a `.tar.bz2` as it streams (libbz2 from the SDK): regular files and directories only, every path inside the
/// target folder. Anything else (links, devices, paths that leave the folder) refuses the whole archive.
enum TarBz2 {
    static func extract(_ archive: URL, into dir: URL) throws {
        let reader = try Bz2Reader(archive)
        defer { reader.close() }
        let base = dir.standardizedFileURL.path + "/"
        while true {
            let header = try reader.read(512)
            if header.count < 512 || header.allSatisfy({ $0 == 0 }) { return }
            func field(_ offset: Int, _ length: Int) -> String {
                let bytes = header[offset..<offset + length].prefix { $0 != 0 }
                return String(decoding: bytes, as: UTF8.self)
            }
            var name = field(0, 100)
            if field(257, 5) == "ustar", case let prefix = field(345, 155), !prefix.isEmpty { name = prefix + "/" + name }
            guard let size = Int(field(124, 12).trimmingCharacters(in: .whitespaces), radix: 8) else { throw unexpected() }
            let out = dir.appendingPathComponent(name).standardizedFileURL
            guard out.path.hasPrefix(base) else { throw CompanionError("Unexpected path in the voice model.") }
            switch header[156] {
            case UInt8(ascii: "5"):
                try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            case UInt8(ascii: "0"), 0:
                try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
                guard FileManager.default.createFile(atPath: out.path, contents: nil) else { throw unexpected() }
                let handle = try FileHandle(forWritingTo: out)
                defer { try? handle.close() }
                var left = size
                while left > 0 {
                    let chunk = try reader.read(min(left, 1 << 20))
                    guard !chunk.isEmpty else { throw unexpected() }
                    try handle.write(contentsOf: chunk)
                    left -= chunk.count
                }
            default:
                throw unexpected() // links and devices
            }
            let padding = (512 - size % 512) % 512
            if header[156] != UInt8(ascii: "5"), padding > 0 { _ = try reader.read(padding) }
        }
    }

    private static func unexpected() -> CompanionError { CompanionError("Unexpected entry in the voice model.") }
}

/// A bzip2 file as a byte stream.
private final class Bz2Reader {
    private let input: FileHandle
    private var stream = bz_stream()
    private var inputBuffer = Data()
    private var ended = false

    init(_ file: URL) throws {
        input = try FileHandle(forReadingFrom: file)
        guard BZ2_bzDecompressInit(&stream, 0, 0) == BZ_OK else { try? input.close(); throw CompanionError("Could not unpack the voice model.") }
    }

    func close() {
        BZ2_bzDecompressEnd(&stream)
        try? input.close()
    }

    /// Up to `count` bytes; fewer only at the end of the stream.
    func read(_ count: Int) throws -> Data {
        var out = Data(count: count)
        var filled = 0
        while filled < count && !ended {
            if stream.avail_in == 0 {
                inputBuffer = try input.read(upToCount: 1 << 16) ?? Data()
                if inputBuffer.isEmpty { throw CompanionError("The voice model archive is truncated.") }
            }
            let status: Int32 = inputBuffer.withUnsafeMutableBytes { inBytes in
                out.withUnsafeMutableBytes { outBytes in
                    if stream.avail_in == 0 {
                        stream.next_in = inBytes.baseAddress!.assumingMemoryBound(to: CChar.self)
                        stream.avail_in = UInt32(inBytes.count)
                    } else {
                        // Same buffer as last time: point at what is left of it.
                        stream.next_in = inBytes.baseAddress!.assumingMemoryBound(to: CChar.self) + (inBytes.count - Int(stream.avail_in))
                    }
                    stream.next_out = outBytes.baseAddress!.assumingMemoryBound(to: CChar.self) + filled
                    stream.avail_out = UInt32(count - filled)
                    let status = BZ2_bzDecompress(&stream)
                    filled = count - Int(stream.avail_out)
                    return status
                }
            }
            if status == BZ_STREAM_END { ended = true } else if status != BZ_OK { throw CompanionError("Could not unpack the voice model (\(status)).") }
        }
        return out.prefix(filled)
    }
}

/// Kokoro through sherpa-onnx's offline TTS C API (CPU). Loads the model on first use; `close` frees it.
final class KokoroSynthesizer: Synthesizer {
    let model = KokoroModel.id
    private let files: KokoroModel
    private var tts: OpaquePointer?

    init(files: KokoroModel) { self.files = files }

    func accepts(_ params: [String: Any]) -> Bool { KokoroModel.params(params) != nil }

    func synthesize(_ text: String, params: [String: Any], keepGoing: @escaping () -> Bool) throws -> Audio? {
        guard let (sid, speed) = KokoroModel.params(params) else { return nil }
        let tts = try load()
        var generation = SherpaOnnxGenerationConfig()
        generation.sid = sid
        generation.speed = speed
        generation.silence_scale = 0.2
        let callback = Callback(keepGoing)
        let arg = Unmanaged.passUnretained(callback).toOpaque()
        let audio = withExtendedLifetime(callback) {
            SherpaOnnxOfflineTtsGenerateWithConfig(tts, text, &generation, { _, _, _, arg in
                let callback = Unmanaged<Callback>.fromOpaque(arg!).takeUnretainedValue()
                if callback.keepGoing() { return 1 }
                callback.stopped = true
                return 0
            }, arg)
        }
        defer { if let audio { SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio) } }
        if callback.stopped { return nil }
        guard let audio else { throw CompanionError("The voice model could not narrate this text.") }
        let n = Int(audio.pointee.n)
        let samples = n > 0 ? Array(UnsafeBufferPointer(start: audio.pointee.samples, count: n)) : []
        return Audio(samples: samples, sampleRate: Int(audio.pointee.sample_rate))
    }

    func close() {
        if let tts { SherpaOnnxDestroyOfflineTts(tts) }
        tts = nil
    }

    deinit { close() }

    private func load() throws -> OpaquePointer {
        if let tts { return tts }
        let root = files.root
        // The C strings live until the engine is created, which copies them.
        var owned: [UnsafeMutablePointer<CChar>] = []
        defer { owned.forEach { free($0) } }
        func c(_ s: String) -> UnsafePointer<CChar> { let p = strdup(s)!; owned.append(p); return UnsafePointer(p) }
        var config = SherpaOnnxOfflineTtsConfig()
        config.model.kokoro.model = c(root.appendingPathComponent("model.onnx").path)
        config.model.kokoro.voices = c(root.appendingPathComponent("voices.bin").path)
        config.model.kokoro.tokens = c(root.appendingPathComponent("tokens.txt").path)
        // No data_dir: sherpa-onnx 2.x ignores espeak-ng-data and phonemizes through the lexicons.
        config.model.kokoro.lexicon = c(["lexicon-us-en.txt", "lexicon-zh.txt"].map { root.appendingPathComponent($0).path }.joined(separator: ","))
        config.model.kokoro.length_scale = 1
        config.model.num_threads = Int32(min(max(ProcessInfo.processInfo.activeProcessorCount, 1), 4))
        config.model.provider = c("cpu")
        config.max_num_sentences = 1
        config.silence_scale = 0.2
        guard let created = SherpaOnnxCreateOfflineTts(&config) else { throw CompanionError("The voice model could not be loaded. Delete it and download it again.") }
        tts = created
        return created
    }

    private final class Callback {
        let keepGoing: () -> Bool
        var stopped = false
        init(_ keepGoing: @escaping () -> Bool) { self.keepGoing = keepGoing }
    }
}
