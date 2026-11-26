import Darwin
import Foundation
import Network
import UIKit

/// How one attempt at a job went on this phone (#827): the body of `POST …/generation/events` (#813) beside `jobId`,
/// and the record kept with the job's row on the phone. Numbers and context only, never text or audio. A nil field is
/// one this attempt did not measure, and is left out.
struct AttemptRecord: Codable, Equatable {
    var runner = "ios"
    /// The #813 end reason, see `GenerationPolicy.endReason`.
    var reason = "other"
    var error: String?
    var appVersion: String?
    var os: String?
    var device: String?
    var network: String?
    var thermalStart: String?
    var thermalEnd: String?
    var background: Bool?
    var chargingStart: Bool?
    var chargingEnd: Bool?
    var batteryStart: Int?
    var batteryEnd: Int?
    var startedAt: Int64?
    var wallMs: Int64?
    var loadMs: Int64?
    var synthMs: Int64?
    var encodeMs: Int64?
    var uploadMs: Int64?
    var cpuMs: Int64?
    var peakMemMb: Int?
    var rtf: Double?
    var bytes: Int64?
    var durationMs: Int64?

    /// The event `POST …/generation/events` takes for `jobId`.
    func event(_ jobId: String) throws -> [String: Any] {
        var out = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as? [String: Any] ?? [:]
        out["jobId"] = jobId
        return out
    }

    static func decode(_ json: String) -> AttemptRecord? { try? JSONDecoder().decode(AttemptRecord.self, from: Data(json.utf8)) }
    var json: String { (try? JSONEncoder().encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "" }
}

/// What an attempt reads from the phone, as closures so tests can fake them. The defaults read this process (CPU time,
/// memory, thermal state, a monotonic clock) and know nothing of battery, network or the app's state; the runner
/// passes `DeviceProbes.phone` for those.
struct DeviceProbes {
    /// Monotonic milliseconds, for stage times.
    var clock: () -> Int64 = { Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000) }
    /// This process's CPU time (user + system), ms.
    var cpuMs: () -> Int64 = DeviceProbes.processCpuMs
    /// This process's memory footprint, MB.
    var memoryMb: () -> Int = DeviceProbes.footprintMb
    var thermal: () -> String = { DeviceProbes.name(ProcessInfo.processInfo.thermalState) }
    /// Battery 0-100 and whether it is charging (or full), each nil when unknown.
    var power: () async -> (level: Int?, charging: Bool?) = { (nil, nil) }
    /// Whether the work is in the background now: a BGProcessingTask, or the app not active.
    var background: () -> Bool = { false }
    /// wifi, cellular, wired, none or other; nil when unknown.
    var network: () -> String? = { nil }

    static func name(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "other"
        }
    }

    static func processCpuMs() -> Int64 {
        var usage = rusage()
        guard getrusage(RUSAGE_SELF, &usage) == 0 else { return 0 }
        func ms(_ t: timeval) -> Int64 { Int64(t.tv_sec) * 1000 + Int64(t.tv_usec) / 1000 }
        return ms(usage.ru_utime) + ms(usage.ru_stime)
    }

    /// `phys_footprint`, what iOS counts against the app's memory limit.
    static func footprintMb() -> Int {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let rc = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return rc == KERN_SUCCESS ? Int(info.phys_footprint / 1_048_576) : 0
    }

    /// "1.4 (12)", from Config/Version.xcconfig through Info.plist.
    static var appVersion: String { "\(AppInfo.current.version) (\(AppInfo.current.build))" }

    static var os: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "iOS \(v.majorVersion).\(v.minorVersion)" + (v.patchVersion > 0 ? ".\(v.patchVersion)" : "")
    }

    /// The hardware model, e.g. iPhone15,3 (the simulated one in the simulator).
    static var device: String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var name = utsname()
        uname(&name)
        return withUnsafeBytes(of: &name.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }

    /// This phone: battery through UIDevice (monitoring is on while Contribute runs), the network path from `path`, and
    /// `background` from the runner.
    static func phone(path: NetworkPath, background: @escaping () -> Bool) -> DeviceProbes {
        DeviceProbes(power: {
            await MainActor.run {
                let device = UIDevice.current
                let level = device.batteryLevel
                return (level < 0 ? nil : Int((level * 100).rounded()), device.batteryState == .unknown ? nil : [.charging, .full].contains(device.batteryState))
            }
        }, background: background, network: { path.type })
    }
}

/// The current network type, kept by an NWPathMonitor for as long as the run lasts.
final class NetworkPath: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    init() { monitor.start(queue: DispatchQueue(label: "online.freeappstore.companion.contribute.path")) }
    deinit { monitor.cancel() }

    var type: String {
        let path = monitor.currentPath
        if path.status != .satisfied { return "none" }
        if path.usesInterfaceType(.wifi) { return "wifi" }
        if path.usesInterfaceType(.cellular) { return "cellular" }
        if path.usesInterfaceType(.wiredEthernet) { return "wired" }
        return "other"
    }
}

/// Whether the app is in the background (#827), followed through UIApplication's notifications while a run lasts.
final class AppBackground: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Bool
    private var observers: [NSObjectProtocol] = []

    @MainActor init() {
        value = UIApplication.shared.applicationState == .background
        for (name, background) in [(UIApplication.didEnterBackgroundNotification, true), (UIApplication.willEnterForegroundNotification, false)] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                guard let self else { return }
                lock.withLock { self.value = background }
            })
        }
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    var now: Bool { lock.withLock { value } }
}

/// Measures one attempt as it goes: stage times, CPU time, peak memory (sampled at sentence boundaries) and the phone's
/// state at the start and the end.
final class AttemptMeter {
    /// Where an error came from, for its end reason.
    enum Stage { case start, synth, encode, upload }

    private let probes: DeviceProbes
    private let wallStart: Int64
    private let cpuStart: Int64
    private(set) var record = AttemptRecord()
    var stage = Stage.start
    /// The #813 end reason, once known.
    var reason: String?
    /// The error the attempt ended in, if any.
    var failure: Error?
    /// A job this phone had handled before: nothing was attempted, so nothing is sent.
    var skip = false

    init(probes: DeviceProbes, startedAt: Int64) async {
        self.probes = probes
        wallStart = probes.clock()
        cpuStart = probes.cpuMs()
        record.startedAt = startedAt
        record.appVersion = DeviceProbes.appVersion
        record.os = DeviceProbes.os
        record.device = DeviceProbes.device
        record.network = probes.network()
        record.thermalStart = probes.thermal()
        let power = await probes.power()
        record.batteryStart = power.level
        record.chargingStart = power.charging
        sample()
    }

    /// At each sentence boundary.
    func sample() {
        record.peakMemMb = max(record.peakMemMb ?? 0, probes.memoryMb())
        if probes.background() { record.background = true }
    }

    /// Runs `body` and adds its time to `field`.
    func time<T>(_ field: WritableKeyPath<AttemptRecord, Int64?>, _ body: () async throws -> T) async rethrows -> T {
        let start = probes.clock()
        defer { record[keyPath: field] = (record[keyPath: field] ?? 0) + max(probes.clock() - start, 0) }
        return try await body()
    }

    /// The model load's time, when `body` says it loaded.
    func load(_ body: () throws -> Bool) rethrows {
        let start = probes.clock()
        if try body() { record.loadMs = max(probes.clock() - start, 0) }
    }

    func output(bytes: Int64, durationMs: Int64) {
        record.bytes = bytes
        record.durationMs = durationMs
        if durationMs > 0, let synth = record.synthMs { record.rtf = Double(synth) / Double(durationMs) }
    }

    /// The finished record: `reason` (or `other`), `error` when it ended in one.
    func finish() async -> AttemptRecord {
        sample()
        if record.background == nil { record.background = false }
        record.reason = reason ?? "other"
        if let error = failure { record.error = String("\(type(of: error)): \(error.localizedDescription)".prefix(300)) }
        record.wallMs = max(probes.clock() - wallStart, 0)
        record.cpuMs = max(probes.cpuMs() - cpuStart, 0)
        record.thermalEnd = probes.thermal()
        let power = await probes.power()
        record.batteryEnd = power.level
        record.chargingEnd = power.charging
        return record
    }
}

/// The audio and sentence timings of this phone's latest attempts (#827), kept so its own items, rejected ones included,
/// can be played back. Excluded from backup; the oldest beyond `keep` are deleted.
struct AttemptAudio {
    let dir: URL
    var keep = 20

    static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("fas-generation", isDirectory: true)
    }

    func audio(_ jobId: String) -> URL { dir.appendingPathComponent("\(jobId).m4a") }
    private func meta(_ jobId: String) -> URL { dir.appendingPathComponent("\(jobId).json") }

    /// Moves `file` in as the job's audio, with its `[charStart, charEnd, startSec, endSec]` segments.
    func save(_ jobId: String, file: URL, segments: [[Any]]) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var folder = dir
        try folder.setResourceValues(values)
        try? FileManager.default.removeItem(at: audio(jobId))
        try FileManager.default.moveItem(at: file, to: audio(jobId))
        try JSONSerialization.data(withJSONObject: ["segments": segments]).write(to: meta(jobId))
        try prune()
    }

    /// The job's kept audio and segments, or nil when this phone no longer has them.
    func load(_ jobId: String) -> (audio: URL, segments: [(range: NSRange, from: Double, to: Double)])? {
        guard FileManager.default.fileExists(atPath: audio(jobId).path) else { return nil }
        let rows = ((try? Data(contentsOf: meta(jobId))).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["segments"]
        return (audio(jobId), Self.segments(rows))
    }

    static func segments(_ value: Any?) -> [(range: NSRange, from: Double, to: Double)] {
        (value as? [[NSNumber]] ?? []).compactMap { row in
            guard row.count == 4, row[1].intValue >= row[0].intValue else { return nil }
            return (NSRange(location: row[0].intValue, length: row[1].intValue - row[0].intValue), row[2].doubleValue, row[3].doubleValue)
        }
    }

    private func prune() throws {
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
            .filter { $0.pathExtension == "m4a" }
            .sorted { modified($0) > modified($1) }
        for old in files.dropFirst(keep) {
            try? FileManager.default.removeItem(at: old)
            try? FileManager.default.removeItem(at: old.deletingPathExtension().appendingPathExtension("json"))
        }
    }

    private func modified(_ url: URL) -> Date { (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast }
}
