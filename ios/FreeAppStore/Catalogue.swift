import Foundation

/// One public app from `https://freeappstore.online/registry.json`. Built from each entry on its own, so one bad
/// entry is skipped rather than failing the whole file. The rules mirror the storefront's build-time validator
/// (`sites/storefront/build.js`: ID_RE, URL_RE, COLOR_RE, categoryLabel).
struct CatalogueApp: Equatable, Identifiable {
    struct Permission: Equatable {
        let id: String
        let reason: String
    }

    let id: String
    let name: String
    /// Display category, normalised so `lifestyle` and `Lifestyle` are one category.
    let category: String
    /// The emoji drawn on the tile: HTML entities decoded, or the name's first letter.
    let icon: String
    /// `#hex`, validated; the storefront's default when absent or invalid.
    let iconBg: String
    let description: String
    let developer: String?
    let appUrl: URL
    /// Nil when the registry does not say; empty when the app asks for none.
    let permissions: [Permission]?

    static let defaultIconBg = "#2563eb"

    init?(json: [String: Any]) {
        guard let id = json["id"] as? String, id.range(of: #"^[a-z0-9][a-z0-9-]*$"#, options: .regularExpression) != nil,
              let name = (json["name"] as? String).flatMap(Self.text), name.count <= 80,
              let link = json["appUrl"] as? String, let url = Self.appUrl(link) else { return nil }
        self.id = id
        self.name = name
        category = Self.categoryLabel(json["category"] as? String)
        icon = Self.emoji(json["icon"] as? String ?? "", name: name)
        iconBg = (json["iconBg"] as? String).flatMap(Self.color) ?? Self.defaultIconBg
        description = (json["description"] as? String).flatMap(Self.text) ?? ""
        developer = (json["developer"] as? String).flatMap(Self.text)
        appUrl = url
        permissions = (json["permissions"] as? [Any]).map(Self.permissions)
    }

    /// `{apps:[...]}` to apps, skipping invalid entries and repeated ids. Nil when the file is not that shape.
    static func decode(_ data: Data) -> [CatalogueApp]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let entries = root["apps"] as? [Any] else { return nil }
        var seen = Set<String>()
        return entries.compactMap { ($0 as? [String: Any]).flatMap(CatalogueApp.init(json:)) }.filter { seen.insert($0.id).inserted }
    }

    /// `https` on a subdomain of freeappstore.online only.
    static func appUrl(_ link: String) -> URL? {
        guard link.range(of: #"^https://[a-z0-9.-]+\.freeappstore\.online(/.*)?$"#, options: .regularExpression) != nil,
              let url = URL(string: link), url.scheme == "https", url.host?.hasSuffix(".freeappstore.online") == true else { return nil }
        return url
    }

    static func color(_ value: String) -> String? {
        value.range(of: #"^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"#, options: .regularExpression) != nil ? value : nil
    }

    /// The storefront's `categoryLabel`: "brain-training" → "Brain Training", "lifestyle" → "Lifestyle".
    static func categoryLabel(_ raw: String?) -> String {
        guard let raw = raw.flatMap(text) else { return "Other" }
        if raw.lowercased() == "other (specify in description)" { return "Other" }
        return raw.split(separator: "-", omittingEmptySubsequences: false).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    /// Decodes `&#NNNN;` and `&#xHHHH;` to their characters and keeps any other text as is. Empty result: the
    /// first letter of the name.
    static func emoji(_ raw: String, name: String) -> String {
        var result = ""
        var rest = Substring(raw)
        while let start = rest.range(of: "&#") {
            result += rest[..<start.lowerBound]
            let after = rest[start.upperBound...]
            guard let end = after.firstIndex(of: ";") else { result += rest[start.lowerBound...]; rest = ""; break }
            let body = after[..<end]
            let value = body.first == "x" || body.first == "X" ? UInt32(body.dropFirst(), radix: 16) : UInt32(body, radix: 10)
            if let value, let scalar = Unicode.Scalar(value) { result.unicodeScalars.append(scalar) } else { result += rest[start.lowerBound...end] }
            rest = after[after.index(after: end)...]
        }
        result += rest
        let trimmed = result.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? String(name.prefix(1)).uppercased() : trimmed
    }

    /// Display names, the same set and order as the storefront's PERMISSION_INFO.
    static let permissionLabels: [(id: String, label: String)] = [
        ("microphone", "Microphone"), ("camera", "Camera"), ("location", "Location"), ("motion", "Motion sensors"),
        ("notifications", "Notifications"), ("midi", "MIDI devices"), ("clipboard", "Clipboard"), ("screen", "Screen sharing"),
        ("bluetooth", "Bluetooth devices"), ("usb", "USB devices"), ("serial", "Serial devices"), ("hid", "HID devices"),
    ]

    /// Entries are `"camera"` or `{name, reason}`; unknown ids are dropped, known ones come in display order.
    private static func permissions(_ raw: [Any]) -> [Permission] {
        var reasons: [String: String] = [:]
        for entry in raw {
            let object = entry as? [String: Any]
            guard let id = entry as? String ?? object?["name"] as? String, reasons[id] == nil else { continue }
            reasons[id] = object?["reason"] as? String ?? ""
        }
        return permissionLabels.compactMap { item in reasons[item.id].map { Permission(id: item.id, reason: $0) } }
    }

    static func permissionLabel(_ id: String) -> String { permissionLabels.first { $0.id == id }?.label ?? id }

    /// Trimmed, non-empty, no control characters.
    private static func text(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) ? nil : trimmed
    }
}

/// Browsing rules for the Store tab. Pure, so they are tested without a view.
enum Catalogue {
    struct Category: Equatable {
        let name: String
        let apps: [CatalogueApp]
    }

    /// The registry has no featured flag, so the first apps in registry order are featured.
    static func featured(_ apps: [CatalogueApp], limit: Int = 5) -> [CatalogueApp] { Array(apps.prefix(limit)) }

    /// One row per category, most apps first, then by name. Apps keep registry order within a row.
    static func categories(_ apps: [CatalogueApp]) -> [Category] {
        var order: [String] = []
        var groups: [String: [CatalogueApp]] = [:]
        for app in apps {
            let key = app.category.lowercased()
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(app)
        }
        return order.map { Category(name: groups[$0]![0].category, apps: groups[$0]!) }.sorted {
            $0.apps.count != $1.apps.count ? $0.apps.count > $1.apps.count : $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    static func sortedByName(_ apps: [CatalogueApp]) -> [CatalogueApp] {
        apps.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// Case- and diacritic-insensitive match on name, description, category, developer and permission names.
    static func search(_ apps: [CatalogueApp], _ query: String) -> [CatalogueApp] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return apps }
        return apps.filter { app in
            let fields = [app.name, app.description, app.category, app.developer ?? ""]
                + (app.permissions ?? []).map { CatalogueApp.permissionLabel($0.id) }
            let haystack = fields.joined(separator: " ")
            return words.allSatisfy { haystack.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
        }
    }
}
