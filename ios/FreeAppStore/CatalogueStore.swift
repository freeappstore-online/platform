import Foundation

/// The public app catalogue, cached on the phone and revalidated with a conditional GET.
///
/// It uses its own credential-free session, never FasApi: the device credential stays on `/v1/native/*`. The cache
/// lives outside the companion's `fas-native` store, so pairing and disconnect (`LocalStore.clear()`) keep it.
@MainActor
final class CatalogueStore: ObservableObject {
    static let url = URL(string: "https://freeappstore.online/registry.json")!
    /// The live file is about 95 KB; anything far larger is not the registry.
    static let maxBytes = 1_000_000
    nonisolated static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("fas-catalogue", isDirectory: true)
    }

    @Published private(set) var apps: [CatalogueApp] = []
    /// The last refresh failed or returned something unusable; `apps` is the previous copy.
    @Published private(set) var stale = false
    @Published private(set) var loading = false

    private let directory: URL
    private let session: URLSession
    private var dataFile: URL { directory.appendingPathComponent("registry.json") }
    private var etagFile: URL { directory.appendingPathComponent("registry.etag") }

    /// `configuration` exists for tests (a URLProtocol stub); the URL is fixed.
    init(directory: URL = CatalogueStore.defaultDirectory, configuration: URLSessionConfiguration = .ephemeral) {
        self.directory = directory
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil)
        if let data = try? Data(contentsOf: dataFile), let cached = CatalogueApp.decode(data) { apps = cached }
    }

    /// 304 keeps the cache; a usable 200 replaces it; anything else keeps it and marks it stale.
    func refresh() async {
        if loading { return }
        loading = true
        defer { loading = false }
        var request = URLRequest(url: Self.url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !apps.isEmpty, let etag = try? String(contentsOf: etagFile, encoding: .utf8), !etag.isEmpty {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        guard let (data, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse else { stale = true; return }
        if http.statusCode == 304, !apps.isEmpty { stale = false; return }
        guard http.statusCode == 200, data.count <= Self.maxBytes, let fresh = CatalogueApp.decode(data), !fresh.isEmpty else { stale = true; return }
        // A failed write only loses the cache; the fresh copy is still shown.
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var dir = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        try? data.write(to: dataFile, options: .atomic)
        try? Data((http.value(forHTTPHeaderField: "ETag") ?? "").utf8).write(to: etagFile, options: .atomic)
        apps = fresh
        stale = false
    }
}
