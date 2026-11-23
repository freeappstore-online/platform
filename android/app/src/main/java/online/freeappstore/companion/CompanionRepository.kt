package online.freeappstore.companion

import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

class CompanionRepository(val local: LocalStore, private val secure: SecureStore, private val api: FasApi) {
    private val operations = Mutex()
    fun token(): String? = try { secure.read().optString("token").takeIf { it.isNotBlank() } } catch (_: Exception) {
        local.paused = true; local.message = "The device connection could not be unlocked. Reconnect your account."; null
    }
    /** Grants that may receive a fix taken now: held, consented, and neither revoked nor paused on this phone. */
    fun recipients(): List<String> = LocationPolicy.recipients(local.apps(), local.excluded(), System.currentTimeMillis())
    /** Whether collection should run, permissions aside: connected, not paused, and some app would receive a fix. */
    fun collecting(): Boolean = token() != null && !local.paused && recipients().isNotEmpty()
    fun pairingCode(): String = try { secure.read().optString("pairId").take(8).uppercase() } catch (_: Exception) { "" }
    suspend fun startSignIn(): String = withContext(Dispatchers.IO) { operations.withLock {
        check(token() == null) { "Disconnect this account before connecting another." }
        val verifier = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val challenge = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()).joinToString("") { "%02x".format(it) }
        val result = api.request("POST", "/native/auth/start", body = JSONObject().put("challenge", challenge).put("label", "${Build.MANUFACTURER} ${Build.MODEL}".take(80)))
        secure.write(JSONObject().put("pairId", result.getString("id")).put("verifier", verifier))
        result.getString("authorizationUrl").also { check(it.startsWith("${FasApi.ORIGIN}/v1/native/auth/authorize?")) }
    } }
    suspend fun finishSignIn(): Boolean = withContext(Dispatchers.IO) { operations.withLock {
        val state = secure.read()
        if (!state.has("pairId")) return@withLock false
        val result = try {
            api.request("POST", "/native/auth/complete", body = JSONObject().put("id", state.getString("pairId")).put("verifier", state.getString("verifier")))
        } catch (e: ApiFailure) {
            // 403 expired or unknown, 409 already used: this pairing can never finish. Forget it, so the next open is a
            // plain Sign in instead of the same error and a dead pairing code.
            if (e.status == 403 || e.status == 409) secure.clear()
            throw e
        }
        if (result.optBoolean("pending")) return@withLock false
        val credential = result.getString("token")
        val me = api.request("GET", "/native/me", credential)
        // Pairing never adopts a previous installation/account's queue or grants. Reconnecting after an expiry (#638)
        // is the same: this app keeps no sharing history, and the catalogue cache lives outside LocalStore.
        local.clear()
        secure.write(JSONObject().put("token", credential).put("userId", me.getJSONObject("user").getString("id")))
        updateMe(me)
        true
    } }
    private fun updateMe(me: JSONObject) {
        check(me.getJSONObject("user").getString("id") == secure.read().getString("userId")) { "Account changed. Reconnect this device." }
        local.userName = me.getJSONObject("user").getString("name")
        local.deviceExpiresAt = me.optJSONObject("device")?.optLong("expiresAt") ?: 0
        local.saveApps(me.getJSONArray("apps"))
    }
    suspend fun enable(app: ConnectedApp) = withContext(Dispatchers.IO) { operations.withLock {
        val credential = token() ?: error("Sign in first.")
        // Finish any queued revocation before granting a new epoch.
        if (app.id in local.blocked()) device("DELETE", "/native/apps/${app.id}/location", credential)
        device("PUT", "/native/apps/${app.id}/location", credential, JSONObject().put("version", app.version).put("enabled", true))
        updateMe(device("GET", "/native/me", credential))
        local.unblock(app.id); local.resume(app.id); local.paused = false; local.message = ""
    } }
    suspend fun disable(app: ConnectedApp) = withContext(Dispatchers.IO) {
        local.block(app.id) // Immediate, durable local stop even without network; recipient removed from the queue.
        sync()
    }
    suspend fun disconnect() = withContext(Dispatchers.IO) { operations.withLock {
        local.paused = true
        token()?.let { credential ->
            try { api.request("DELETE", "/native/device", credential) } catch (e: ApiFailure) { if (e.status != 401) throw e }
        }
        local.clear(); secure.clear()
    } }
    suspend fun sync() = withContext(Dispatchers.IO) { operations.withLock {
        val credential = token() ?: return@withLock
        try {
            val blocked = local.blocked()
            for (id in blocked) device("DELETE", "/native/apps/$id/location", credential)
            updateMe(device("GET", "/native/me", credential))
            for (id in blocked) local.unblock(id)
            local.expire(System.currentTimeMillis())
            repeat(10) {
                val batch = local.pending()
                if (batch.isEmpty()) return@repeat
                val result = device("POST", "/native/locations", credential, JSONObject().put("points", JSONArray(batch.map { it.json() })))
                val ack = result.getJSONArray("acknowledged")
                val ids = (0 until ack.length()).map { ack.getString(it) }
                check(ids.toSet() == batch.map { it.id }.toSet()) { "Upload was not fully acknowledged. Device copy retained." }
                local.acknowledge(ids)
            }
            local.lastSync = System.currentTimeMillis(); local.message = ""
        } catch (e: Exception) {
            if (DeviceConnection.expired(e)) throw e // the expired card says it, not a sync failure
            local.message = if (e is ApiFailure) e.message ?: "Reconnect your account." else "Waiting to sync. Location stays on this phone."
            throw e
        }
    } }
    /**
     * Reconnecting before the connection expires (#638): uploads what it can, then takes the expiry path. The old
     * credential is only forgotten: revoking it would delete the platform copies already shared, and it lapses within days.
     */
    suspend fun renew() = withContext(Dispatchers.IO) {
        if (token() == null) return@withContext
        try { sync() } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e }
        operations.withLock { if (token() != null) expire() }
    }
    /** A device-authenticated request. A 401 expires the connection (#638). */
    private fun device(method: String, path: String, credential: String, body: JSONObject? = null): JSONObject = try {
        api.request(method, path, credential, body)
    } catch (e: ApiFailure) {
        if (DeviceConnection.expired(e)) expire()
        throw e
    }
    /** Drops the credential, so collection stops, and remembers the account for the Reconnect card. */
    private fun expire() { local.markExpired(secure.read().optString("userId")); secure.clear() }
}
