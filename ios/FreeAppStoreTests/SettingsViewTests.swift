import XCTest
@testable import FreeAppStore

final class SettingsViewTests: XCTestCase {
    /// #653: Delete account opens the web deletion flow, not the console home.
    func testDeleteAccountOpensTheDeletionFlow() {
        XCTAssertEqual(SettingsView.deleteAccountLink, "https://freeappstore.online/app/settings?delete-account=1")
        XCTAssertNotNil(URL(string: SettingsView.deleteAccountLink))
    }
}
