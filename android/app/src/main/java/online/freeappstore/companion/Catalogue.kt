package online.freeappstore.companion

import java.net.URI
import java.text.Normalizer
import org.json.JSONArray
import org.json.JSONObject

/**
 * One public app from `https://freeappstore.online/registry.json`. Built from each entry on its own, so one bad
 * entry is skipped rather than failing the whole file. The rules mirror the storefront's build-time validator
 * (`sites/storefront/build.js`: ID_RE, URL_RE, COLOR_RE, categoryLabel) and the iOS companion's Store tab.
 */
data class CatalogueApp(
    val id: String,
    val name: String,
    /** Display category, normalised so `lifestyle` and `Lifestyle` are one category. */
    val category: String,
    /** The emoji drawn on the tile: HTML entities decoded, or the name's first letter. */
    val icon: String,
    /** `#hex`, validated; the storefront's default when absent or invalid. */
    val iconBg: String,
    val description: String,
    val developer: String?,
    val appUrl: String,
    /** Null when the registry does not say; empty when the app asks for none. */
    val permissions: List<Permission>?,
) {
    data class Permission(val id: String, val reason: String)
}

/** Browsing rules for the Store tab. Pure, so they are unit-tested without a device. */
object Catalogue {
    const val DEFAULT_ICON_BG = "#2563eb"
    private val ID = Regex("^[a-z0-9][a-z0-9-]*$")
    private val APP_URL = Regex("^https://[a-z0-9.-]+\\.freeappstore\\.online(/.*)?$")
    private val COLOR = Regex("^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
    private val ENTITY = Regex("&#([xX][0-9a-fA-F]+|[0-9]+);")

    /** Display names, the same set and order as the storefront's PERMISSION_INFO. */
    val permissionLabels = listOf(
        "microphone" to "Microphone", "camera" to "Camera", "location" to "Location", "motion" to "Motion sensors",
        "notifications" to "Notifications", "midi" to "MIDI devices", "clipboard" to "Clipboard", "screen" to "Screen sharing",
        "bluetooth" to "Bluetooth devices", "usb" to "USB devices", "serial" to "Serial devices", "hid" to "HID devices",
    )

    fun permissionLabel(id: String): String = permissionLabels.firstOrNull { it.first == id }?.second ?: id

    /** `{apps:[...]}` to apps, skipping invalid entries and repeated ids. Null when the text is not that shape. */
    fun decode(text: String): List<CatalogueApp>? {
        val entries = try { JSONObject(text).getJSONArray("apps") } catch (_: Exception) { return null }
        val seen = HashSet<String>()
        return (0 until entries.length()).mapNotNull { i -> entries.optJSONObject(i)?.let(::app) }.filter { seen.add(it.id) }
    }

    fun app(json: JSONObject): CatalogueApp? {
        val id = json.optString("id").takeIf { json.opt("id") is String && ID.matches(it) } ?: return null
        val name = text(json.opt("name"))?.takeIf { it.length <= 80 } ?: return null
        val appUrl = (json.opt("appUrl") as? String)?.let(::appUrl) ?: return null
        return CatalogueApp(
            id = id,
            name = name,
            category = categoryLabel(json.opt("category") as? String),
            icon = emoji(json.opt("icon") as? String ?: "", name),
            iconBg = (json.opt("iconBg") as? String)?.takeIf { COLOR.matches(it) } ?: DEFAULT_ICON_BG,
            description = text(json.opt("description")) ?: "",
            developer = text(json.opt("developer")),
            appUrl = appUrl,
            permissions = (json.opt("permissions") as? JSONArray)?.let(::permissions),
        )
    }

    /** `https` on a subdomain of freeappstore.online only. */
    fun appUrl(link: String): String? = try {
        link.takeIf { APP_URL.matches(it) && URI(it).let { u -> u.scheme == "https" && u.host?.endsWith(".freeappstore.online") == true } }
    } catch (_: Exception) { null }

    /**
     * Where Open goes: the app's own URL with `install=1`, so the host offers its Install bar (#621). Built from the
     * validated `appUrl`, not the id, because a few apps live on another subdomain (hanzi-practice → hanzi).
     */
    fun installUrl(appUrl: String): String {
        val u = URI(appUrl)
        val path = u.rawPath.orEmpty().ifEmpty { "/" }
        val query = u.rawQuery?.let { "$it&install=1" } ?: "install=1"
        return "https://${u.rawAuthority}$path?$query"
    }

    /** The storefront's `categoryLabel`: "brain-training" → "Brain Training", "lifestyle" → "Lifestyle". */
    fun categoryLabel(raw: String?): String {
        val value = raw?.let(::text) ?: return "Other"
        if (value.lowercase() == "other (specify in description)") return "Other"
        return value.split("-").joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
    }

    /** Decodes `&#NNNN;` and `&#xHHHH;` and keeps any other text as is. Empty result: the name's first letter. */
    fun emoji(raw: String, name: String): String {
        val decoded = ENTITY.replace(raw) { m ->
            val body = m.groupValues[1]
            val code = if (body[0] == 'x' || body[0] == 'X') body.drop(1).toIntOrNull(16) else body.toIntOrNull()
            if (code != null && Character.isValidCodePoint(code) && code !in 0xD800..0xDFFF) String(Character.toChars(code)) else m.value
        }.trim()
        return decoded.ifEmpty { name.take(1).uppercase() }
    }

    /** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (already validated) as ARGB. */
    fun argb(hex: String): Long {
        var digits = hex.drop(1)
        if (digits.length <= 4) digits = digits.map { "$it$it" }.joinToString("")
        val value = digits.toLong(16)
        return if (digits.length == 8) ((value and 0xff) shl 24) or (value shr 8) else 0xff000000 or value
    }

    /** The registry has no featured flag, so the first apps in registry order are featured. */
    fun featured(apps: List<CatalogueApp>, limit: Int = 5): List<CatalogueApp> = apps.take(limit)

    /** One row per category, most apps first, then by name. Apps keep registry order within a row. */
    fun categories(apps: List<CatalogueApp>): List<Pair<String, List<CatalogueApp>>> =
        apps.groupBy { it.category.lowercase() }.values.map { it[0].category to it }
            .sortedWith(compareByDescending<Pair<String, List<CatalogueApp>>> { it.second.size }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.first })

    fun sortedByName(apps: List<CatalogueApp>): List<CatalogueApp> = apps.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })

    /** Case- and diacritic-insensitive match of every word on name, description, category, developer and permissions. */
    fun search(apps: List<CatalogueApp>, query: String): List<CatalogueApp> {
        val words = query.split(Regex("\\s+")).filter { it.isNotEmpty() }.map(::fold)
        if (words.isEmpty()) return apps
        return apps.filter { app ->
            val haystack = fold((listOf(app.name, app.description, app.category, app.developer ?: "") +
                (app.permissions ?: emptyList()).map { permissionLabel(it.id) }).joinToString(" "))
            words.all { it in haystack }
        }
    }

    private fun fold(s: String) = Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase()

    /** Entries are `"camera"` or `{name, reason}`; unknown ids are dropped, known ones come in display order. */
    private fun permissions(raw: JSONArray): List<CatalogueApp.Permission> {
        val reasons = LinkedHashMap<String, String>()
        for (i in 0 until raw.length()) {
            val entry = raw.opt(i)
            val obj = entry as? JSONObject
            val id = entry as? String ?: obj?.opt("name") as? String ?: continue
            if (id !in reasons) reasons[id] = obj?.opt("reason") as? String ?: ""
        }
        return permissionLabels.mapNotNull { (id, _) -> reasons[id]?.let { CatalogueApp.Permission(id, it) } }
    }

    /** Trimmed, non-empty, no control characters. */
    private fun text(value: Any?): String? {
        val trimmed = (value as? String)?.trim() ?: return null
        return trimmed.takeIf { it.isNotEmpty() && it.none { c -> c.code < 0x20 || c.code == 0x7f } }
    }
}
