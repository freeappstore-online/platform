import Foundation

/// One catalog entry from `GET /native/me`. Same fields as PAS android Models.kt.
struct ConnectedApp: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let purpose: String
    let disclosure: String
    let version: String
    let grantId: String?
    let consentAt: Int64

    init(id: String, name: String, purpose: String, disclosure: String, version: String, grantId: String?, consentAt: Int64 = 0) {
        self.id = id; self.name = name; self.purpose = purpose; self.disclosure = disclosure
        self.version = version; self.grantId = grantId; self.consentAt = consentAt
    }

    private enum Keys: String, CodingKey { case id, name, purpose, disclosure, version, grant }
    private enum GrantKeys: String, CodingKey { case id, consent_at }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let grant = try c.decodeNil(forKey: .grant) ? nil : try c.nestedContainer(keyedBy: GrantKeys.self, forKey: .grant)
        self.init(id: try c.decode(String.self, forKey: .id), name: try c.decode(String.self, forKey: .name),
                  purpose: try c.decode(String.self, forKey: .purpose), disclosure: try c.decode(String.self, forKey: .disclosure),
                  version: try c.decode(String.self, forKey: .version), grantId: try grant?.decode(String.self, forKey: .id),
                  consentAt: try grant?.decode(Int64.self, forKey: .consent_at) ?? 0)
    }
}

/// The signed-in account and this device, from `GET /native/me` (#829). Kept on the phone only.
struct Profile: Equatable {
    let id: String
    let name: String
    let login: String?
    let provider: String
    let avatarUrl: URL?
    let email: String?
    let roles: [String]
    let appCount: Int
    let deviceLabel: String
    let pairedAt: Int64
    let expiresAt: Int64

    static let consoleLink = "https://freeappstore.online/app/"
    var providerName: String { ["github": "GitHub", "google": "Google", "apple": "Apple", "email": "Email"][provider] ?? provider.capitalized }
    /// `@login` for GitHub, otherwise the provider's name.
    var account: String { login.map { "@\($0)" } ?? providerName }
    var creator: Bool { roles.contains("creator") }

    /// `{ user, device }` as `/native/me` sends them; nil when there is no user.
    init?(json: String) {
        guard let data = json.data(using: .utf8), let me = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let user = me["user"] as? [String: Any], let id = user["id"] as? String else { return nil }
        let device = me["device"] as? [String: Any] ?? [:]
        func text(_ key: String) -> String? { (user[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        self.init(id: id, name: text("name") ?? "", login: text("login"), provider: text("provider") ?? "github",
                  avatarUrl: text("avatarUrl").flatMap { $0.hasPrefix("https://") ? URL(string: $0) : nil }, email: text("email"),
                  roles: user["roles"] as? [String] ?? ["user"], appCount: (user["appCount"] as? NSNumber)?.intValue ?? 0,
                  deviceLabel: device["label"] as? String ?? "", pairedAt: (device["createdAt"] as? NSNumber)?.int64Value ?? 0,
                  expiresAt: (device["expiresAt"] as? NSNumber)?.int64Value ?? 0)
    }

    init(id: String, name: String, login: String?, provider: String, avatarUrl: URL?, email: String?, roles: [String], appCount: Int,
         deviceLabel: String, pairedAt: Int64, expiresAt: Int64) {
        self.id = id; self.name = name; self.login = login; self.provider = provider; self.avatarUrl = avatarUrl; self.email = email
        self.roles = roles; self.appCount = appCount; self.deviceLabel = deviceLabel; self.pairedAt = pairedAt; self.expiresAt = expiresAt
    }
}

/// One queued fix. Encodes to exactly the `POST /native/locations` point shape.
struct TrackPoint: Codable, Equatable {
    let id: String
    let at: Int64
    let lat: Double
    let lng: Double
    let accuracy: Double
    let grants: [String]

    func with(grants: [String]) -> TrackPoint { TrackPoint(id: id, at: at, lat: lat, lng: lng, accuracy: accuracy, grants: grants) }
}

/// One row of the on-device sharing record (#621). `appId` nil = device-wide. `detail` is a short code, never
/// coordinates or response bodies.
struct ShareEvent: Equatable {
    enum Kind: String, CaseIterable {
        case enabled, disabled, paused, resumed
        case pausedAll = "paused_all", resumedAll = "resumed_all", stopped
        case grantLost = "grant_lost", historyCleared = "history_cleared"
        // Activity log only (#624).
        case syncFailed = "sync_failed", syncRecovered = "sync_recovered", uploadRejected = "upload_rejected", quota
        case permission, queueFull = "queue_full", grantRestored = "grant_restored"
        /// The device connection expired or was revoked (#638); `detail` "renew" when the user reconnected early.
        case expired
    }

    let id: Int64
    let at: Int64
    let appId: String?
    let kind: Kind
    let detail: String
}

/// A local failure whose text is shown to the user as is.
struct CompanionError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// `LocalStore.enqueue` at `LocationPolicy.MAX_QUEUE`: storage works, uploads are behind.
struct QueueFullError: LocalizedError {
    var errorDescription: String? { "Upload queue is full. Connect to the internet so FreeAppStore can send waiting points." }
}
