import Foundation

struct ApiFailure: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

/// Only the platform origin receives the narrow native credential; redirects are refused. Ported from the PAS iOS
/// companion (proappstore-online/platform ios/), itself a port of the PAS Android client.
final class FasApi: Sendable {
    static let ORIGIN = "https://api.freeappstore.online"
    private let session: URLSession

    /// `configuration` exists for tests (a URLProtocol stub); the origin is fixed. `resourceTimeout` is longer for the
    /// contributor's uploads (#733).
    init(configuration: URLSessionConfiguration = .ephemeral, resourceTimeout: TimeInterval = 20) {
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = resourceTimeout
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil)
    }

    /// The device credential goes to the native routes and to the contributor routes of community generation (#733).
    private static let allowed = try! NSRegularExpression(pattern: "^/(native/|apps/[a-z0-9][a-z0-9-]{0,62}/generation/)")

    /// The only URLs a request may target: `/v1/native/*` and `/v1/apps/<id>/generation/*` on the fixed origin, with no
    /// `..` segment. Nil for any other path.
    static func endpoint(_ path: String) -> URL? {
        guard !path.contains(".."), allowed.firstMatch(in: path, range: NSRange(location: 0, length: path.utf16.count)) != nil else { return nil }
        return URL(string: "\(ORIGIN)/v1\(path)")
    }

    func request(_ method: String, _ path: String, token: String? = nil, body: Data? = nil, headers: [String: String] = [:]) async throws -> [String: Any] {
        var request = Self.request(method, path, token: token, headers: headers)
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await send(request)
    }

    /// A multipart request with one `file` part and an optional `meta` JSON part (#733), streamed from a temporary file.
    func upload(_ method: String, _ path: String, token: String, headers: [String: String], file: URL, contentType: String,
                meta: [String: Any]?) async throws -> [String: Any] {
        var request = Self.request(method, path, token: token, headers: headers)
        let boundary = "fas-\(UUID().uuidString)"
        let body = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: body) }
        guard FileManager.default.createFile(atPath: body.path, contents: nil) else { throw CompanionError("Could not prepare the upload.") }
        let out = try FileHandle(forWritingTo: body)
        do {
            func part(_ disposition: String, _ type: String) throws {
                try out.write(contentsOf: Data("--\(boundary)\r\nContent-Disposition: form-data; \(disposition)\r\nContent-Type: \(type)\r\n\r\n".utf8))
            }
            try part("name=\"file\"; filename=\"\(file.lastPathComponent)\"", contentType)
            let input = try FileHandle(forReadingFrom: file)
            defer { try? input.close() }
            while let chunk = try input.read(upToCount: 64 * 1024), !chunk.isEmpty { try out.write(contentsOf: chunk) }
            try out.write(contentsOf: Data("\r\n".utf8))
            if let meta {
                try part("name=\"meta\"", "application/json")
                try out.write(contentsOf: try JSONSerialization.data(withJSONObject: meta))
                try out.write(contentsOf: Data("\r\n".utf8))
            }
            try out.write(contentsOf: Data("--\(boundary)--\r\n".utf8))
            try out.close()
        } catch { try? out.close(); throw error }
        let size = (try FileManager.default.attributesOfItem(atPath: body.path)[.size] as? NSNumber)?.int64Value ?? 0
        request.httpBodyStream = InputStream(url: body)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue(String(size), forHTTPHeaderField: "Content-Length")
        return try await send(request)
    }

    private static func request(_ method: String, _ path: String, token: String?, headers: [String: String]) -> URLRequest {
        guard let url = endpoint(path) else { preconditionFailure("Native requests are limited to /native/ and generation routes") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        return request
    }

    private func send(_ request: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200...299).contains(code) else {
            throw ApiFailure(status: code, message: result["error"] as? String ?? "Could not reach FreeAppStore (\(code)).")
        }
        return result
    }
}

/// Refuses every redirect, so a session only ever talks to the URL it was given: FasApi's origin, the catalogue's file.
final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
