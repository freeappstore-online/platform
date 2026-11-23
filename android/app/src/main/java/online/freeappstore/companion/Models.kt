package online.freeappstore.companion

data class ConnectedApp(
    val id: String, val name: String, val purpose: String, val disclosure: String,
    val version: String, val grantId: String?, val consentAt: Long = 0,
)
data class TrackPoint(val id: String, val at: Long, val lat: Double, val lng: Double, val accuracy: Float, val grants: List<String>)

object LocationPolicy {
    const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000
    const val MAX_QUEUE = 60_000
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
