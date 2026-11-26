import XCTest
@testable import FreeAppStore

final class AppInfoTests: XCTestCase {
    func testReadsVersionBuildAndCommit() {
        let info = AppInfo(["CFBundleShortVersionString": "1.2.3", "CFBundleVersion": "42", "FASCommit": "abc1234"])
        XCTAssertEqual([info.version, info.build, info.commit], ["1.2.3", "42", "abc1234"])
    }

    func testDevBuildLabelAndReleaseNotes() {
        let dev = AppInfo(["CFBundleShortVersionString": "0.3.0", "CFBundleVersion": "1", "FASCommit": "abc1234", "FASDevBuild": "YES"])
        XCTAssertEqual(dev.label, "0.3.0 (dev, abc1234)")
        XCTAssertEqual(AppInfo(["CFBundleShortVersionString": "0.3.0", "CFBundleVersion": "57", "FASCommit": "abc1234", "FASDevBuild": "NO"]).label, "0.3.0 (57, abc1234)")
        XCTAssertEqual(dev.notesLink, "https://github.com/freeappstore-online/platform/releases/tag/ios-v0.3.0")
    }

    func testMissingOrEmptyValuesFallBack() {
        let missing = AppInfo([:])
        XCTAssertEqual([missing.version, missing.build, missing.commit], ["unknown", "unknown", "dev"])
        XCTAssertEqual(AppInfo(["FASCommit": ""]).commit, "dev")
    }

    /// The host app's Info.plist must carry the substituted xcconfig values, not the `$(…)` placeholders.
    func testBuiltBundleHasSubstitutedValues() {
        let info = AppInfo.current
        XCTAssertNotNil(info.version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression), info.version)
        XCTAssert(info.build == "dev" || Int(info.build) != nil, info.build)
        XCTAssertNotNil(info.commit.range(of: #"^[0-9a-f]{7}$"#, options: .regularExpression), info.commit)
    }
}
