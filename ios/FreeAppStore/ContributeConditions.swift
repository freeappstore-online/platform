import Foundation
import Network
import UIKit

/// Contribute's mode and conditions (#830), all decided on this phone: the server sets no per-user limit. Auto runs
/// whenever every condition holds; Off is a hard stop that survives relaunches and updates. Run now is not stored: it is
/// one run that ignores the conditions, after which the mode is Auto again.
struct ContributePrefs: Codable, Equatable {
    enum Mode: String, Codable { case auto, off }
    enum Cpu: String, Codable, CaseIterable { case light, balanced, full }
    enum InUse: String, Codable { case pause, slower }

    var mode = Mode.auto
    /// Wi-Fi only, or Wi-Fi and mobile data up to `cellularCapMB` a month.
    var cellular = false
    var cellularCapMB = 500
    /// Charging only, or also on battery at or above `minBattery` percent.
    var chargingOnly = true
    var minBattery = 40
    /// Pause while the thermal state is serious or critical.
    var thermal = true
    var inUse = InUse.pause
    var cpu = Cpu.balanced
    /// Daily maximums, 0 for none: jobs uploaded, and minutes of work.
    var dailyJobs = 0
    var dailyMinutes = 0
    /// Quiet hours, from and to (hours 0-23, may wrap past midnight), when `quiet`.
    var quiet = false
    var quietFrom = 22
    var quietTo = 7
    /// The overnight summary notification (#844).
    var summary = true

    init() {}

    /// Missing fields keep their defaults, so a newer app reads an older app's settings.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func v<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T { (try? c.decodeIfPresent(T.self, forKey: key)) .flatMap { $0 } ?? fallback }
        let d = ContributePrefs()
        mode = v(.mode, d.mode); cellular = v(.cellular, d.cellular); cellularCapMB = v(.cellularCapMB, d.cellularCapMB)
        chargingOnly = v(.chargingOnly, d.chargingOnly); minBattery = v(.minBattery, d.minBattery); thermal = v(.thermal, d.thermal)
        inUse = v(.inUse, d.inUse); cpu = v(.cpu, d.cpu); dailyJobs = v(.dailyJobs, d.dailyJobs); dailyMinutes = v(.dailyMinutes, d.dailyMinutes)
        quiet = v(.quiet, d.quiet); quietFrom = v(.quietFrom, d.quietFrom); quietTo = v(.quietTo, d.quietTo); summary = v(.summary, d.summary)
    }

    /// sherpa-onnx threads and the rest between sentences for `cpu`.
    static func effort(_ cpu: Cpu, cores: Int = ProcessInfo.processInfo.activeProcessorCount) -> (threads: Int, rest: Duration) {
        switch cpu {
        case .light: (1, .seconds(1))
        case .balanced: (2, .milliseconds(250))
        case .full: (min(max(cores, 1), 4), .zero)
        }
    }
}

/// What the phone is like now, as the conditions read it.
struct DeviceNow {
    var plugged = true
    /// 0-100, nil when unknown.
    var battery: Int?
    /// wifi, cellular, wired, none or other, as `NetworkPath.type`.
    var network = "wifi"
    var hot = false
    var lowPower = false
    var date = Date()
    var calendar = Calendar.current
    /// Jobs uploaded today and minutes worked today.
    var jobsToday = 0
    var minutesToday = 0
    /// Mobile data this month, bytes.
    var cellularBytes: Int64 = 0
}

/// Why Contribute is not running now: each names its local stop reason, kept on the job's row, and says why on screen.
enum ContributePause: Equatable {
    case off, quietHours(from: Int, to: Int), dailyJobs(Int), dailyMinutes(Int), noNetwork, mobileData, dataCap(capMB: Int)
    case unplugged, battery(level: Int, min: Int), lowPower, hot

    /// The local reason recorded when it stops a job (see `GenerationPolicy.endReason`).
    var reason: String {
        switch self {
        case .off: "off"
        case .quietHours: "quiet_hours"
        case .dailyJobs, .dailyMinutes: "daily_max"
        case .noNetwork: "no_network"
        case .mobileData: "mobile_data"
        case .dataCap: "data_cap"
        case .unplugged: "unplugged"
        case .battery: "battery_low"
        case .lowPower: "low_power"
        case .hot: "thermal"
        }
    }

    var text: String {
        switch self {
        case .off: "Contribute is off. It will not start again until you turn it on."
        case let .quietHours(from, to): "Paused: quiet hours (\(Self.hour(from))–\(Self.hour(to)))."
        case let .dailyJobs(n): "Paused: today's maximum of \(n) jobs is reached."
        case let .dailyMinutes(n): "Paused: today's maximum of \(n) minutes is reached."
        case .noNetwork: "Waiting: no connection."
        case .mobileData: "Paused: on mobile data (Wi-Fi only)."
        case let .dataCap(cap): "Paused: this month's \(cap) MB of mobile data is used."
        case .unplugged: "Paused: not charging."
        case let .battery(level, min): "Paused: battery \(level)% (min \(min)%)."
        case .lowPower: "Paused: Low Power Mode is on."
        case .hot: "Paused: the phone is hot. It goes on by itself once it cools down."
        }
    }

    static func hour(_ h: Int) -> String { String(format: "%02d:00", h) }
}

enum ContributeConditions {
    /// The first condition that fails, or nil when Contribute may run. Heat comes last: it pauses a job in hand without
    /// stopping it, so any other failure is the one that counts.
    static func pause(_ p: ContributePrefs, _ d: DeviceNow) -> ContributePause? {
        if p.mode == .off { return .off }
        if p.quiet && inQuietHours(from: p.quietFrom, to: p.quietTo, hour: d.calendar.component(.hour, from: d.date)) {
            return .quietHours(from: p.quietFrom, to: p.quietTo)
        }
        if p.dailyJobs > 0 && d.jobsToday >= p.dailyJobs { return .dailyJobs(p.dailyJobs) }
        if p.dailyMinutes > 0 && d.minutesToday >= p.dailyMinutes { return .dailyMinutes(p.dailyMinutes) }
        if d.network == "none" { return .noNetwork }
        if d.network == "cellular" {
            if !p.cellular { return .mobileData }
            if d.cellularBytes >= Int64(p.cellularCapMB) * 1_000_000 { return .dataCap(capMB: p.cellularCapMB) }
        }
        if !d.plugged {
            if p.chargingOnly { return .unplugged }
            if let level = d.battery, level < p.minBattery { return .battery(level: level, min: p.minBattery) }
        }
        if d.lowPower { return .lowPower }
        if p.thermal && d.hot { return .hot }
        return nil
    }

    static func inQuietHours(from: Int, to: Int, hour: Int) -> Bool {
        if from == to { return false }
        return from < to ? (from..<to).contains(hour) : hour >= from || hour < to
    }

    /// A job this far along when a condition fails is finished (and uploaded) rather than stopped.
    static func nearlyDone(_ done: Int, _ total: Int) -> Bool { total > 0 && done * 10 >= total * 8 }

    /// Statuses of a job this phone generated and uploaded (or is uploading).
    static let made: Set<String> = ["uploading", "pending", "accepted", "rejected", "superseded"]

    /// Today's jobs uploaded and minutes worked (every attempt's wall time), from today's rows, for the daily maximums.
    static func usage(_ rows: [Contribution]) -> (jobs: Int, minutes: Int) {
        (rows.filter { made.contains($0.status) }.count, Int(rows.reduce(Int64(0)) { $0 + ($1.record?.wallMs ?? 0) } / 60_000))
    }

    /// The month mobile data is counted in, "2026-11".
    static func month(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }
}

/// The overnight summary notification (#844).
enum ContributeSummary {
    /// "Generated 42 clips, 38 accepted, 1 h 10 min CPU", or nil when nothing was generated.
    static func text(_ rows: [Contribution]) -> String? {
        let made = rows.filter { ContributeConditions.made.contains($0.status) }.count
        guard made > 0 else { return nil }
        let accepted = rows.filter { $0.status == "accepted" }.count
        let minutes = Int(rows.reduce(Int64(0)) { $0 + ($1.record?.cpuMs ?? 0) } / 60_000)
        let cpu = minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : minutes > 0 ? "\(minutes) min" : "under a minute of"
        return "Generated \(made) \(made == 1 ? "clip" : "clips"), \(accepted) accepted, \(cpu) CPU"
    }

    /// The next 8:00 after `date`.
    static func morning(after date: Date, calendar: Calendar = .current) -> Date {
        calendar.nextDate(after: date, matching: DateComponents(hour: 8, minute: 0), matchingPolicy: .nextTime) ?? date.addingTimeInterval(86_400)
    }
}

/// The phone's power and network, read off the main thread between sentences. Battery comes from UIDevice through its
/// notifications on the main thread; the network from an NWPathMonitor.
final class DeviceWatch: @unchecked Sendable {
    let path = NetworkPath()
    private let lock = NSLock()
    private var plugged = true
    private var level: Int?
    private var observers: [NSObjectProtocol] = []

    @MainActor init() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        update()
        for name in [UIDevice.batteryStateDidChangeNotification, UIDevice.batteryLevelDidChangeNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.update() }
            })
        }
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    @MainActor private func update() {
        let device = UIDevice.current
        let state = device.batteryState
        let level = device.batteryLevel
        // Unknown (the simulator) counts as plugged in, as before.
        lock.withLock {
            plugged = state != .unplugged
            self.level = level < 0 ? nil : Int((level * 100).rounded())
        }
    }

    func now(hot: Bool) -> DeviceNow {
        lock.withLock {
            DeviceNow(plugged: plugged, battery: level, network: path.type, hot: hot, lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled)
        }
    }

    static var hot: Bool { ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue }
}
