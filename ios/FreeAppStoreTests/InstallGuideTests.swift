import XCTest
@testable import FreeAppStore

final class InstallGuideTests: XCTestCase {
    private let suite = "online.freeappstore.companion.installguidetests"
    private var defaults: UserDefaults!

    override func setUp() {
        UserDefaults().removePersistentDomain(forName: suite)
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() { UserDefaults().removePersistentDomain(forName: suite) }

    func testShowsOncePerApp() {
        let guide = InstallGuide(defaults: defaults)
        XCTAssertTrue(guide.shouldShow("run"))
        guide.markSeen("run")
        XCTAssertFalse(guide.shouldShow("run"))
        XCTAssertTrue(guide.shouldShow("language"))
        guide.markSeen("run")
        XCTAssertEqual(defaults.stringArray(forKey: InstallGuide.seenKey), ["run"])
    }

    func testDontShowAgainCoversEveryApp() {
        let guide = InstallGuide(defaults: defaults)
        guide.opened("run", dontShowAgain: true)
        XCTAssertFalse(guide.shouldShow("run"))
        XCTAssertFalse(guide.shouldShow("language"))
    }

    /// The toggle alone saves nothing: Cancel after turning it on leaves the guide on for every app.
    func testDontShowAgainPersistsOnlyOnOpen() {
        let guide = InstallGuide(defaults: defaults)
        guide.opened("run", dontShowAgain: false)
        XCTAssertNil(defaults.object(forKey: InstallGuide.offKey))
        XCTAssertFalse(guide.shouldShow("run"))
        XCTAssertTrue(guide.shouldShow("language"))
    }

    func testSurvivesClearingTheCompanionStore() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let guide = InstallGuide(defaults: defaults)
        guide.markSeen("run")
        let local = try LocalStore(directory: directory)
        try local.clear()
        local.close()
        XCTAssertFalse(InstallGuide(defaults: defaults).shouldShow("run"))
    }
}
