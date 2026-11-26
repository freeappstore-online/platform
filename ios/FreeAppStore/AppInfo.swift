import Foundation

/// Version, build and source commit for About and the attempt records (#832). All come from Config/Version.xcconfig
/// through Info.plist; CI numbers the build, and a local build (FAS_DEV_BUILD = YES) shows "dev" as its build.
struct AppInfo {
    let version: String
    let build: String
    let commit: String

    init(_ info: [String: Any]) {
        func value(_ key: String) -> String? { (info[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        version = value("CFBundleShortVersionString") ?? "unknown"
        build = value("FASDevBuild") == "YES" ? "dev" : value("CFBundleVersion") ?? "unknown"
        commit = value("FASCommit") ?? "dev"
    }

    /// "0.3.0 (57, abc1234)", or "0.3.0 (dev, abc1234)" for a local build.
    var label: String { "\(version) (\(build), \(commit))" }
    /// The GitHub release notes for this version (docs/versioning.md).
    var notesLink: String { "https://github.com/freeappstore-online/platform/releases/tag/ios-v\(version)" }

    static let current = AppInfo(Bundle.main.infoDictionary ?? [:])
}
