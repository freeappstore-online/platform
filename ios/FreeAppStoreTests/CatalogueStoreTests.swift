import XCTest
@testable import FreeAppStore

/// The catalogue cache and its conditional GET, against the URLProtocol stub.
@MainActor
final class CatalogueStoreTests: XCTestCase {
    private var directory: URL!
    private let configuration: URLSessionConfiguration = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return configuration
    }()

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        StubProtocol.seen = []
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var registry: [String: Any] { ["apps": CatalogueTests.entries] }

    private func store() -> CatalogueStore { CatalogueStore(directory: directory, configuration: configuration) }

    func testFirstLoadCachesAndTheNextRequestRevalidates() async throws {
        StubProtocol.handler = { [registry] _ in .init(json: registry, headers: ["ETag": "\"v1\""]) }
        let first = store()
        XCTAssertEqual(first.apps, [])
        await first.refresh()
        XCTAssertEqual(first.apps.map(\.id), ["language", "run", "lol-app"])
        XCTAssertFalse(first.stale)
        XCTAssertNil(StubProtocol.seen[0].value(forHTTPHeaderField: "If-None-Match"))
        XCTAssertEqual(StubProtocol.seen[0].url, URL(string: "https://freeappstore.online/registry.json"))

        // A new launch shows the cached copy before any request, then a 304 keeps it.
        StubProtocol.handler = { _ in .init(status: 304) }
        let second = store()
        XCTAssertEqual(second.apps.map(\.id), ["language", "run", "lol-app"])
        XCTAssertEqual(StubProtocol.seen.count, 1)
        await second.refresh()
        XCTAssertEqual(StubProtocol.seen[1].value(forHTTPHeaderField: "If-None-Match"), "\"v1\"")
        XCTAssertEqual(second.apps.count, 3)
        XCTAssertFalse(second.stale)
    }

    func testA200ReplacesTheCache() async throws {
        StubProtocol.handler = { [registry] _ in .init(json: registry, headers: ["ETag": "\"v1\""]) }
        await store().refresh()
        StubProtocol.handler = { _ in .init(json: ["apps": [CatalogueTests.entries[1]]], headers: ["ETag": "\"v2\""]) }
        let next = store()
        await next.refresh()
        XCTAssertEqual(next.apps.map(\.id), ["run"])
        XCTAssertEqual(store().apps.map(\.id), ["run"])
    }

    func testUnusableResponsesKeepTheCacheAndMarkItStale() async throws {
        StubProtocol.handler = { [registry] _ in .init(json: registry, headers: ["ETag": "\"v1\""]) }
        let catalogue = store()
        await catalogue.refresh()
        for stub in [StubProtocol.Stub(json: ["nope": 1]), .init(json: ["apps": [CatalogueTests.entries[4]]]), .init(status: 500), .init(offline: true)] {
            StubProtocol.handler = { _ in stub }
            await catalogue.refresh()
            XCTAssertEqual(catalogue.apps.count, 3)
            XCTAssertTrue(catalogue.stale)
        }
        XCTAssertEqual(store().apps.count, 3)
    }

    func testNoCacheAndNoNetworkIsEmpty() async {
        StubProtocol.handler = { _ in .init(offline: true) }
        let catalogue = store()
        await catalogue.refresh()
        XCTAssertEqual(catalogue.apps, [])
        XCTAssertTrue(catalogue.stale)
    }

    func testRequestsCarryNoCredentialsAndRedirectsAreRefused() async throws {
        StubProtocol.handler = { _ in .init(status: 302, redirect: URL(string: "https://attacker.example/registry.json")!) }
        let catalogue = store()
        await catalogue.refresh()
        XCTAssertEqual(StubProtocol.seen.map { $0.url!.host }, ["freeappstore.online"])
        XCTAssertEqual(catalogue.apps, [])
        XCTAssertTrue(catalogue.stale)

        StubProtocol.handler = { [registry] _ in .init(json: registry, headers: ["ETag": "\"v1\"", "Set-Cookie": "session=x"]) }
        await catalogue.refresh()
        await catalogue.refresh()
        for request in StubProtocol.seen {
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        }
    }

    func testTheCacheSurvivesClearingTheCompanionStore() async throws {
        let local = try LocalStore(directory: directory.appendingPathComponent("fas-native"))
        StubProtocol.handler = { [registry] _ in .init(json: registry, headers: ["ETag": "\"v1\""]) }
        await CatalogueStore(directory: directory.appendingPathComponent("fas-catalogue"), configuration: configuration).refresh()
        try local.clear()
        local.close()
        XCTAssertEqual(CatalogueStore(directory: directory.appendingPathComponent("fas-catalogue"), configuration: configuration).apps.count, 3)
        XCTAssertNotEqual(CatalogueStore.defaultDirectory, LocalStore.defaultDirectory)
    }
}
