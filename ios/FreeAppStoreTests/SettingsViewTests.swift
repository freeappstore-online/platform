import XCTest
@testable import FreeAppStore

final class SettingsViewTests: XCTestCase {
    /// #653: Delete account opens the web deletion flow, not the console home.
    func testDeleteAccountOpensTheDeletionFlow() {
        XCTAssertEqual(SettingsView.deleteAccountLink, "https://freeappstore.online/app/settings?delete-account=1")
        XCTAssertNotNil(URL(string: SettingsView.deleteAccountLink))
    }

    /// #829: the profile as `/native/me` sends it, kept on the phone.
    func testProfileFromAGithubAccount() throws {
        let profile = try XCTUnwrap(Profile(json: """
        {"user":{"id":"gh:1","name":"Alex","login":"alex","provider":"github","avatarUrl":"https://avatars.githubusercontent.com/u/1",
         "email":null,"roles":["user","creator"],"appCount":3},"device":{"id":"d","label":"iPhone (iOS 18.0)","createdAt":10,"expiresAt":20}}
        """))
        XCTAssertEqual(profile, Profile(id: "gh:1", name: "Alex", login: "alex", provider: "github", avatarUrl: URL(string: "https://avatars.githubusercontent.com/u/1"),
                                        email: nil, roles: ["user", "creator"], appCount: 3, deviceLabel: "iPhone (iOS 18.0)", pairedAt: 10, expiresAt: 20))
        XCTAssertEqual(profile.account, "@alex")
        XCTAssertEqual(profile.providerName, "GitHub")
        XCTAssertTrue(profile.creator)
    }

    func testProfileFromAGoogleAccountOrAnOlderServer() throws {
        let google = try XCTUnwrap(Profile(json: #"{"user":{"id":"google:9","name":"Gail","login":null,"provider":"google","avatarUrl":"http://x/a.png","email":"g@example.com","roles":["user"],"appCount":0},"device":{}}"#))
        XCTAssertEqual(google.account, "Google")
        XCTAssertNil(google.avatarUrl)
        XCTAssertEqual(google.email, "g@example.com")
        XCTAssertFalse(google.creator)
        XCTAssertNil(Profile(json: ""))
        let older = try XCTUnwrap(Profile(json: #"{"user":{"id":"gh:1","name":"alice"},"device":{"label":"Phone","expiresAt":5}}"#))
        XCTAssertEqual(older.provider, "github"); XCTAssertEqual(older.roles, ["user"]); XCTAssertEqual(older.pairedAt, 0)
    }
}
