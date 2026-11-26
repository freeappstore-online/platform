package online.freeappstore.companion

import org.json.JSONObject

data class ConnectedApp(
    val id: String, val name: String, val purpose: String, val disclosure: String,
    val version: String, val grantId: String?, val consentAt: Long = 0,
)
data class TrackPoint(val id: String, val at: Long, val lat: Double, val lng: Double, val accuracy: Float, val grants: List<String>)

/** One shared point from the on-device history. `sentAt` null = still waiting to upload. */
data class TrackSample(val at: Long, val lat: Double, val lng: Double, val accuracy: Double, val sentAt: Long?)

/** One row of the on-device sharing record (#649). `appId` null = device-wide. `detail` is a short code, never coordinates or response bodies. */
data class ShareEvent(val id: Long, val at: Long, val appId: String?, val kind: Kind, val detail: String) {
    enum class Kind(val raw: String) {
        ENABLED("enabled"), DISABLED("disabled"), PAUSED("paused"), RESUMED("resumed"),
        PAUSED_ALL("paused_all"), RESUMED_ALL("resumed_all"), STOPPED("stopped"),
        GRANT_LOST("grant_lost"), HISTORY_CLEARED("history_cleared"),
        // Activity log only (#649).
        SYNC_FAILED("sync_failed"), SYNC_RECOVERED("sync_recovered"), UPLOAD_REJECTED("upload_rejected"), QUOTA("quota"),
        PERMISSION("permission"), QUEUE_FULL("queue_full"), GRANT_RESTORED("grant_restored"),
        /** The device connection expired or was revoked (#638); `detail` "renew" when the user reconnected early. */
        EXPIRED("expired");
        companion object { fun of(raw: String): Kind? = entries.firstOrNull { it.raw == raw } }
    }
}

/** The device connection's lifetime (#638). Pure, so the rules are unit-tested. */
/** The signed-in account and this device, from `GET /native/me` (#829). Kept on the phone only. */
data class Profile(
    val id: String, val name: String, val login: String?, val provider: String, val avatarUrl: String?, val email: String?,
    val roles: List<String>, val appCount: Int, val deviceLabel: String, val pairedAt: Long, val expiresAt: Long,
) {
    val providerName: String get() = mapOf("github" to "GitHub", "google" to "Google", "apple" to "Apple", "email" to "Email")[provider]
        ?: provider.replaceFirstChar { it.uppercase() }
    /** `@login` for GitHub, otherwise the provider's name. */
    val account: String get() = login?.let { "@$it" } ?: providerName
    val creator: Boolean get() = "creator" in roles
    companion object {
        const val CONSOLE_URL = "https://freeappstore.online/app/"
        /** `{ user, device }` as `/native/me` sends them; null when there is no user. */
        fun parse(json: String): Profile? {
            val me = try { JSONObject(json) } catch (_: Exception) { return null }
            val user = me.optJSONObject("user") ?: return null
            val device = me.optJSONObject("device") ?: JSONObject()
            fun text(o: JSONObject, key: String) = o.optString(key).takeIf { !o.isNull(key) && it.isNotBlank() }
            val roles = user.optJSONArray("roles")
            return Profile(
                id = user.optString("id"), name = user.optString("name"), login = text(user, "login"),
                provider = text(user, "provider") ?: "github", avatarUrl = text(user, "avatarUrl")?.takeIf { it.startsWith("https://") },
                email = text(user, "email"), roles = roles?.let { r -> (0 until r.length()).map { r.getString(it) } } ?: listOf("user"),
                appCount = user.optInt("appCount"), deviceLabel = device.optString("label"),
                pairedAt = device.optLong("createdAt"), expiresAt = device.optLong("expiresAt"),
            )
        }
    }
}

object DeviceConnection {
    /** Only a 401 means the credential expired or was revoked. Network errors, 429 and 5xx never do. */
    fun expired(e: Throwable): Boolean = e is ApiFailure && e.status == 401
    private const val DAY_MS = 24L * 60 * 60 * 1000
    /** The days left when `device.expiresAt` is under 7 days away, else null. */
    fun expiresInDays(expiresAt: Long, now: Long): Int? {
        val left = expiresAt - now
        if (expiresAt <= 0 || left <= 0 || left >= 7 * DAY_MS) return null
        return ((left + DAY_MS - 1) / DAY_MS).toInt()
    }
}

object LocationPolicy {
    const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000
    const val MAX_QUEUE = 60_000
    /** On-device sharing history (#649): kept 30 days, capped at about 20-30 MB worst case. */
    const val HISTORY_MS = 30L * 24 * 60 * 60 * 1000
    const val HISTORY_MAX_POINTS = 200_000
    fun valid(point: TrackPoint, now: Long): Boolean = point.at in (now - 15_000)..(now + 2_000) &&
        point.lat.isFinite() && point.lat in -90.0..90.0 && point.lng.isFinite() && point.lng in -180.0..180.0 &&
        point.accuracy.isFinite() && point.accuracy in 0f..100f && point.grants.isNotEmpty()
    fun recipients(apps: List<ConnectedApp>, blocked: Set<String>, at: Long): List<String> = apps
        .filter { it.id !in blocked && it.grantId != null && at >= it.consentAt }.mapNotNull { it.grantId }

    // #622 (port of proappstore-online/platform#639): indoor GPS jitter must not become a track. 16 minutes at home once uploaded 39 points and a 366 m scribble.
    const val EMIT_MIN_METERS = 10.0
    /** A stationary phone still emits this often, so apps see "still here". */
    const val HEARTBEAT_MS = 5L * 60 * 1000
    /** A Doppler speed below this, reported with a speed accuracy, counts as stationary. */
    const val STATIONARY_SPEED = 0.3f
    /** How often the collector refreshes grants when it has nothing to upload or revoke. */
    const val IDLE_SYNC_MS = 5L * 60 * 1000

    /**
     * Whether a valid fix becomes a queued point. The first fix and a heartbeat always do. Otherwise a fix with a valid
     * Doppler `speed` under [STATIONARY_SPEED] never does, and one must be at least `max(10 m, both accuracies)` from
     * the last emitted point, so jitter inside the accuracy circle is dropped. `speed` is null when the fix has none.
     */
    fun shouldEmit(last: TrackPoint?, fix: TrackPoint, speed: Float?): Boolean {
        if (last == null || fix.at - last.at >= HEARTBEAT_MS) return true
        if (speed != null && speed < STATIONARY_SPEED) return false
        return distanceMeters(last.lat, last.lng, fix.lat, fix.lng) >= maxOf(EMIT_MIN_METERS, last.accuracy.toDouble(), fix.accuracy.toDouble())
    }

    /** Great-circle distance (haversine, mean Earth radius). */
    fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val dLat = Math.toRadians(lat2 - lat1); val dLng = Math.toRadians(lng2 - lng1)
        val a = Math.sin(dLat / 2).let { it * it } + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLng / 2).let { it * it }
        return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a.coerceAtMost(1.0)))
    }

    /** The collector syncs when there is something to upload or revoke; otherwise only to refresh grants every [IDLE_SYNC_MS]. */
    fun syncDue(queued: Int, revoking: Boolean, lastSync: Long, now: Long): Boolean = queued > 0 || revoking || now - lastSync >= IDLE_SYNC_MS
}
