import XCTest
@testable import FreeAppStore

/// Fixture: three live registry.json entries (language, run, lol-app) plus invalid ones.
final class CatalogueTests: XCTestCase {
    static let entries: [Any] = [
        ["id": "language", "name": "Language", "category": "Learning", "icon": "&#127463;", "iconBg": "#dc2626",
         "description": "Flashcards, cloze exercises, and speech practice across multiple languages.",
         "appUrl": "https://language.freeappstore.online", "repo": "freeappstore-online/language", "type": "connected",
         "developer": "FreeAppStore", "hostedOn": "r2", "creatorGithub": "serge-ivo", "requiresAuth": true, "permissions": ["microphone"]],
        ["id": "run", "name": "run", "category": "Health & Fitness", "icon": "🎓", "iconBg": "#dcfce7",
         "description": "Beginner running coach: guided 5K and 10K plans, GPS route, pace and splits. Private, on your device.",
         "appUrl": "https://run.freeappstore.online", "repo": "freeappstore-online/run", "hostedOn": "r2", "type": "standalone",
         "developer": "FreeAppStore", "discoveryStatus": "live", "creatorGithub": "serge-ivo"],
        ["id": "lol-app", "name": "lol-app", "category": "lifestyle", "icon": "😂", "iconBg": "#ffedd5", "description": "Mems",
         "appUrl": "https://lol-app.freeappstore.online", "developer": "FreeAppStore", "permissions": []],
        ["id": "Bad_Id", "name": "Bad", "appUrl": "https://bad.freeappstore.online"],
        ["id": "plain-http", "name": "Plain", "appUrl": "http://plain.freeappstore.online"],
        ["id": "elsewhere", "name": "Elsewhere", "appUrl": "https://evil.example"],
        ["id": "lookalike", "name": "Lookalike", "appUrl": "https://freeappstore.online.evil.example"],
        ["id": "no-name", "name": "", "appUrl": "https://no-name.freeappstore.online"],
        "not an object",
    ]

    static func data(_ entries: [Any] = entries) throws -> Data { try JSONSerialization.data(withJSONObject: ["apps": entries]) }

    private func app(_ fields: [String: Any]) -> CatalogueApp? {
        CatalogueApp(json: ["id": "x", "name": "X", "appUrl": "https://x.freeappstore.online"].merging(fields) { $1 })
    }

    func testDecodesEachEntryOnItsOwnAndSkipsInvalidOnes() throws {
        let apps = try XCTUnwrap(CatalogueApp.decode(try Self.data()))
        XCTAssertEqual(apps.map(\.id), ["language", "run", "lol-app"])
        XCTAssertEqual(apps[0].appUrl.absoluteString, "https://language.freeappstore.online")
        XCTAssertEqual(apps[0].developer, "FreeAppStore")
        XCTAssertNil(CatalogueApp.decode(Data("[]".utf8)))
        XCTAssertNil(CatalogueApp.decode(Data("not json".utf8)))
        XCTAssertEqual(CatalogueApp.decode(try Self.data([Self.entries[0], Self.entries[0]]))?.count, 1)
    }

    func testIconEntitiesDecodeOnTheirBackground() throws {
        let apps = try XCTUnwrap(CatalogueApp.decode(try Self.data()))
        XCTAssertEqual(apps.map(\.icon), ["🇧", "🎓", "😂"])
        XCTAssertEqual(CatalogueApp.emoji("&#128222;", name: "Meet"), "📞")
        XCTAssertEqual(CatalogueApp.emoji("&#10084;", name: "Love"), "❤")
        XCTAssertEqual(CatalogueApp.emoji("&#x1F331;", name: "Grass"), "🌱")
        XCTAssertEqual(CatalogueApp.emoji("&#127897;&#65039;", name: "Mic"), "🎙️")
        XCTAssertEqual(CatalogueApp.emoji("", name: "notes"), "N")
        XCTAssertEqual(CatalogueApp.emoji("&#bad;", name: "x"), "&#bad;")
        XCTAssertEqual(apps.map(\.iconBg), ["#dc2626", "#dcfce7", "#ffedd5"])
        XCTAssertEqual(app(["iconBg": "red"])?.iconBg, CatalogueApp.defaultIconBg)
        XCTAssertEqual(app(["iconBg": "#abc"])?.iconBg, "#abc")
    }

    func testCategoriesAreNormalisedAndOrderedByCount() throws {
        XCTAssertEqual(CatalogueApp.categoryLabel("lifestyle"), "Lifestyle")
        XCTAssertEqual(CatalogueApp.categoryLabel("brain-training"), "Brain Training")
        XCTAssertEqual(CatalogueApp.categoryLabel("Other (specify in description)"), "Other")
        XCTAssertEqual(CatalogueApp.categoryLabel(nil), "Other")
        let apps = [app(["id": "a", "category": "Lifestyle"]), app(["id": "b", "category": "lifestyle"]), app(["id": "c", "category": "Utilities"]),
                    app(["id": "d", "category": "Finance"])].compactMap { $0 }
        let categories = Catalogue.categories(apps)
        XCTAssertEqual(categories.map(\.name), ["Lifestyle", "Finance", "Utilities"])
        XCTAssertEqual(categories[0].apps.map(\.id), ["a", "b"])
    }

    func testPermissionsKeepKnownIdsInDisplayOrder() throws {
        let apps = try XCTUnwrap(CatalogueApp.decode(try Self.data()))
        XCTAssertEqual(apps[0].permissions, [.init(id: "microphone", reason: "")])
        XCTAssertNil(apps[1].permissions)
        XCTAssertEqual(apps[2].permissions, [])
        let mixed = app(["permissions": [["name": "screen", "reason": "Records a tab"], "camera", "teleport", "camera"]])
        XCTAssertEqual(mixed?.permissions, [.init(id: "camera", reason: ""), .init(id: "screen", reason: "Records a tab")])
    }

    func testSearchMatchesAcrossFieldsIgnoringCaseAndDiacritics() throws {
        let apps = try XCTUnwrap(CatalogueApp.decode(try Self.data()))
        XCTAssertEqual(Catalogue.search(apps, "CLOZE").map(\.id), ["language"])
        XCTAssertEqual(Catalogue.search(apps, "fitness").map(\.id), ["run"])
        XCTAssertEqual(Catalogue.search(apps, "microphone").map(\.id), ["language"])
        XCTAssertEqual(Catalogue.search(apps, "mems lifestyle").map(\.id), ["lol-app"])
        XCTAssertEqual(Catalogue.search(apps, "flâshcards").map(\.id), ["language"])
        XCTAssertEqual(Catalogue.search(apps, "zzz"), [])
        XCTAssertEqual(Catalogue.search(apps, "  ").count, 3)
    }

    func testFeaturedAndAllApps() throws {
        let apps = try XCTUnwrap(CatalogueApp.decode(try Self.data()))
        XCTAssertEqual(Catalogue.featured(apps).map(\.id), ["language", "run", "lol-app"])
        XCTAssertEqual(Catalogue.featured(apps, limit: 2).map(\.id), ["language", "run"])
        XCTAssertEqual(Catalogue.featured([]), [])
        XCTAssertEqual(Catalogue.sortedByName(apps).map(\.name), ["Language", "lol-app", "run"])
    }
}
