package online.freeappstore.companion

import android.content.Context
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class CompanionTest {
    @get:Rule val compose = createComposeRule()
    private val run = ConnectedApp("run", "Run", "Record routes", "Run receives precise location even when closed. You can revoke access.", "1", null)
    private val catalogue = CatalogueState(Catalogue.decode("""{"apps":[
        {"id":"run","name":"Run","category":"health-fitness","icon":"&#127939;","iconBg":"#16a34a","description":"Track runs and walks.","appUrl":"https://run.freeappstore.online","permissions":["location"]},
        {"id":"hanzi-practice","name":"Hanzi Practice","category":"Learning","icon":"&#20013;","description":"Write Chinese characters.","appUrl":"https://hanzi.freeappstore.online","permissions":[]}
    ]}""")!!)

    private fun screen(state: CompanionState, actions: CompanionActions = CompanionActions(), store: CatalogueState = catalogue, startOnStore: Boolean = false) {
        compose.setContent {
            var consent by remember { mutableStateOf<ConnectedApp?>(null) }
            MaterialTheme { FasScreen(state, store, actions, consent, { consent = it }, startOnStore) }
        }
    }

    @Test fun consumerLandingHasSignInWithoutDeveloperTools() {
        screen(CompanionState())
        compose.onNodeWithText("Sign in to FreeAppStore").assertIsDisplayed()
        compose.onNodeWithText("Create app").assertDoesNotExist()
        compose.onNodeWithText("API key").assertDoesNotExist()
    }
    @Test fun enablingRequiresSpecificDisclosureAndConfirmation() {
        var granted = 0
        screen(CompanionState(signedIn = true, name = "Alex", apps = listOf(run)), CompanionActions(enable = { granted++ }))
        compose.onNodeWithText("Enable", useUnmergedTree = true).performScrollTo().performClick()
        compose.onNodeWithText(run.disclosure).assertIsDisplayed()
        assertEquals(0, granted)
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(0, granted)
        compose.onNodeWithText("Enable", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Enable for Run").performClick()
        assertEquals(1, granted)
    }
    @Test fun offlineRevocationAndPausedStateAreVisible() {
        screen(CompanionState(signedIn = true, apps = listOf(run.copy(grantId = "old")), blocked = setOf("run"), paused = true))
        compose.onNodeWithText("Location paused").assertIsDisplayed()
        compose.onNodeWithText("Disabled on this phone. Server revocation will finish when connected.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Off", useUnmergedTree = true).assertExists()
    }
    /** #621: Open on a companion app goes to the browser with the install hint. */
    @Test fun openOnACompanionAppAddsTheInstallHint() {
        val opened = mutableListOf<String>()
        screen(CompanionState(signedIn = true, apps = listOf(run)), CompanionActions(open = { opened += it }))
        compose.onNodeWithText("Open Run").performScrollTo().performClick()
        assertEquals(listOf("https://run.freeappstore.online/?install=1"), opened)
    }

    // Store tab (#621, same rules as the iOS Store tab #620)
    @Test fun storeListsCategoriesAndAllAppsWithEmojiIcons() {
        screen(CompanionState(), startOnStore = true)
        compose.onNodeWithText("Health Fitness").assertExists()
        compose.onNodeWithTag("store").performScrollToNode(hasText("All apps"))
        compose.onNodeWithText("All apps").assertIsDisplayed()
        compose.onNodeWithTag("store").performScrollToNode(hasContentDescription("Open Hanzi Practice"))
        compose.onNodeWithContentDescription("Open Hanzi Practice").assertIsDisplayed()
        compose.onAllNodesWithText("中", useUnmergedTree = true).onFirst().assertExists()
    }
    @Test fun storeOpenUsesTheValidatedAppUrlWithInstall() {
        val opened = mutableListOf<String>()
        screen(CompanionState(), CompanionActions(open = { opened += it }), startOnStore = true)
        compose.onNodeWithTag("store").performScrollToNode(hasContentDescription("Open Hanzi Practice"))
        compose.onNodeWithContentDescription("Open Hanzi Practice").performClick()
        assertEquals(listOf("https://hanzi.freeappstore.online/?install=1"), opened)
    }
    @Test fun searchFiltersAndSaysWhenNothingMatches() {
        screen(CompanionState(), startOnStore = true)
        compose.onNodeWithText("Search apps").performTextInput("chinese")
        compose.onNodeWithContentDescription("Open Hanzi Practice").assertIsDisplayed()
        compose.onNodeWithContentDescription("Open Run").assertDoesNotExist()
        compose.onNodeWithText("chinese").performTextReplacement("zzz")
        compose.onNodeWithText("No apps match “zzz”").assertIsDisplayed()
    }
    @Test fun emptyStoreOffersRetry() {
        var retried = 0
        screen(CompanionState(), CompanionActions(refreshCatalogue = { retried++ }), store = CatalogueState(), startOnStore = true)
        compose.onNodeWithText("Connect to the internet to load the store").assertIsDisplayed()
        compose.onNodeWithText("Retry").performClick()
        assertEquals(1, retried)
    }
    /** The toggle never grants: it opens the same disclosure, and only its button enables. */
    @Test fun detailToggleOpensTheDisclosureAndOnlyItsButtonEnables() {
        var granted = 0
        screen(CompanionState(signedIn = true, apps = listOf(run)), CompanionActions(enable = { granted++ }), startOnStore = true)
        compose.onAllNodesWithText("Run").onFirst().performClick()
        compose.onNodeWithText("Use with companion").assertIsDisplayed()
        compose.onNodeWithText("Permissions").performScrollTo().assertIsDisplayed()
        compose.onNode(isToggleable()).performScrollTo().assertIsOff().performClick()
        compose.onNodeWithText(run.disclosure).assertIsDisplayed()
        assertEquals(0, granted)
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(0, granted)
        compose.onNode(isToggleable()).performClick()
        compose.onNodeWithText("Enable for Run").performClick()
        assertEquals(1, granted)
    }
    @Test fun signedOutDetailOffersSignInInsteadOfTheToggle() {
        var connects = 0
        screen(CompanionState(apps = listOf(run)), CompanionActions(connect = { connects++ }), startOnStore = true)
        compose.onAllNodesWithText("Run").onFirst().performClick()
        compose.onNode(isToggleable()).assertDoesNotExist()
        compose.onNodeWithText("Sign in to use with FreeAppStore").performClick()
        assertEquals(1, connects)
    }
    @Test fun enabledAppsAppearUnderYours() {
        screen(CompanionState(signedIn = true, apps = listOf(run.copy(grantId = "g"))), startOnStore = true)
        compose.onNodeWithText("Yours").assertExists()
    }

    @Test fun queueSurvivesReopenAndRevokesOnlyItsRecipient() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val local = LocalStore(context)
        local.clear()
        fun app(id: String, grant: String) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", JSONObject().put("id", grant).put("consent_at", 1))
        local.saveApps(JSONArray().put(app("run", "run-old")).put(app("walk", "walk-grant")))
        local.paused = false
        local.enqueue(TrackPoint("point", 10, 1.0, 2.0, 5f, listOf("run-old", "walk-grant")))
        local.close()
        val reopened = LocalStore(context)
        assertEquals(1, reopened.count())
        reopened.block("run")
        assertEquals(listOf("walk-grant"), reopened.pending().single().grants)
        // A callback prepared before revocation cannot put the old recipient back.
        reopened.enqueue(TrackPoint("late", 11, 1.0, 2.0, 5f, listOf("run-old")))
        assertEquals(1, reopened.count())
        reopened.acknowledge(listOf("not-this-point"))
        assertEquals(1, reopened.count())
        reopened.acknowledge(listOf("point"))
        assertEquals(0, reopened.count())
        reopened.clear(); reopened.close()
    }
    // Per-app pause (ported from PAS #626)
    private fun store(): LocalStore {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val local = LocalStore(context)
        local.clear()
        fun app(id: String, grant: String) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", JSONObject().put("id", grant).put("consent_at", 1))
        local.saveApps(JSONArray().put(app("run", "run-g")).put(app("walk", "walk-g")))
        local.paused = false
        return local
    }
    @Test fun pauseFiltersNewPointsToTheOtherRecipient() {
        val local = store()
        local.pause("run")
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("run-g", "walk-g")))
        assertEquals(listOf("walk-g"), local.pending().single().grants)
        local.pause("walk")
        local.enqueue(TrackPoint("q", 11, 1.0, 2.0, 5f, listOf("run-g", "walk-g")))
        assertEquals(1, local.count())
        local.clear(); local.close()
    }
    @Test fun pauseLeavesQueuedPointsUntouched() {
        val local = store()
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("run-g", "walk-g")))
        local.pause("run")
        assertEquals(listOf("run-g", "walk-g"), local.pending().single().grants)
        local.clear(); local.close()
    }
    @Test fun resumeRestoresTaggingAndBlockClearsThePause() {
        val local = store()
        local.pause("run"); local.resume("run")
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("run-g", "walk-g")))
        assertEquals(listOf("run-g", "walk-g"), local.pending().single().grants)
        local.pause("run"); local.block("run")
        assertEquals(emptySet<String>(), local.pausedApps())
        assertEquals(setOf("run"), local.excluded())
        local.clear(); local.close()
    }
    @Test fun pausesSurviveReopenAndClearEmptiesThem() {
        val local = store()
        local.pause("run"); local.close()
        val reopened = LocalStore(ApplicationProvider.getApplicationContext())
        assertEquals(setOf("run"), reopened.pausedApps())
        reopened.clear()
        assertEquals(emptySet<String>(), reopened.pausedApps())
        reopened.close()
    }
    /** Browsing survives pairing and disconnect: the catalogue cache is not account data. */
    @Test fun catalogueCacheSurvivesLocalStoreClear() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val cached = File(File(context.noBackupFilesDir, "fas-catalogue").apply { mkdirs() }, "registry.json")
        cached.writeText("""{"apps":[{"id":"run","name":"Run","appUrl":"https://run.freeappstore.online"}]}""")
        val local = LocalStore(context)
        local.clear(); local.close()
        assertTrue(cached.exists())
        assertEquals(listOf("run"), CatalogueStore(cached.parentFile!!).apps.map { it.id })
        cached.delete()
    }
    @Test fun credentialRoundTripUsesKeystoreAndCanBeCleared() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val store = SecureStore(context)
        store.write(JSONObject().put("token", "test-device-secret"))
        assertEquals("test-device-secret", SecureStore(context).read().getString("token"))
        val stored = context.getSharedPreferences("native-credentials", Context.MODE_PRIVATE).getString("value", "")!!
        assertFalse(stored.contains("test-device-secret"))
        store.clear(); assertFalse(store.read().has("token"))
    }

    // Connection expired (#638)
    @Test fun anExpiredConnectionShowsReconnectInsteadOfSignIn() {
        var reconnects = 0
        screen(CompanionState(expired = true, apps = listOf(run.copy(grantId = "old"))), CompanionActions(reconnect = { reconnects++ }))
        compose.onNodeWithText("Connection expired").assertIsDisplayed()
        compose.onNodeWithText("Sign in to FreeAppStore").assertDoesNotExist()
        compose.onNodeWithText("Disable").assertDoesNotExist()
        compose.onNodeWithText("Reconnect").performClick()
        assertEquals(1, reconnects)
    }
    @Test fun theExpiryNoteShowsOnlyWhenSet() {
        var reconnects = 0
        screen(CompanionState(signedIn = true, apps = listOf(run), expiresInDays = 3), CompanionActions(reconnect = { reconnects++ }))
        compose.onNodeWithText("Connection renews when you reconnect — expires in 3 days").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Reconnect").performScrollTo().performClick()
        assertEquals(1, reconnects)
    }
    @Test fun noExpiryNoteWithMoreThanAWeekLeft() {
        screen(CompanionState(signedIn = true, apps = listOf(run)))
        compose.onNodeWithText("Reconnect").assertDoesNotExist()
    }

    /** Answers like the server: `status(path)` decides per call; 200 paths get a usable body. */
    private class Server(var status: (String) -> Int) : FasApi() {
        val seen = mutableListOf<String>()
        override fun request(method: String, path: String, token: String?, body: JSONObject?): JSONObject {
            seen += "$method $path"
            when (val code = status(path)) {
                0 -> throw java.io.IOException("offline")
                200 -> return when (path) {
                    "/native/me" -> JSONObject().put("user", JSONObject().put("id", "u1").put("name", "Alex"))
                        .put("device", JSONObject().put("id", "d1").put("label", "Pixel").put("expiresAt", 123L))
                        .put("apps", JSONArray().put(JSONObject().put("id", "run").put("name", "Run").put("purpose", "Routes").put("disclosure", "D").put("version", "1")
                            .put("grant", if (token == "ndev_new") JSONObject.NULL else JSONObject().put("id", "run-g").put("consent_at", 1))))
                    "/native/auth/complete" -> JSONObject().put("token", "ndev_new")
                    "/native/locations" -> JSONObject().put("acknowledged", JSONArray(body!!.getJSONArray("points").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") } }))
                    else -> JSONObject()
                }
                else -> throw ApiFailure(code, "Device connection expired or was disconnected.")
            }
        }
    }
    private fun connected(server: Server): CompanionRepository {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val local = store()
        SecureStore(context).write(JSONObject().put("token", "ndev_old").put("userId", "u1"))
        local.enqueue(TrackPoint("p", System.currentTimeMillis(), 1.0, 2.0, 5f, listOf("run-g")))
        return CompanionRepository(local, SecureStore(context), server)
    }
    @Test fun a401FromAnyDeviceCallExpiresTheConnection() = kotlinx.coroutines.runBlocking {
        for (failing in listOf("/native/me", "/native/locations")) {
            val repository = connected(Server { if (it == failing) 401 else 200 })
            assertTrue(runCatching { repository.sync() }.isFailure)
            assertTrue(failing, repository.local.expired)
            assertEquals("u1", repository.local.expiredUser)
            assertNull(repository.token())
            assertFalse("collection stops", repository.collecting())
            assertEquals("", repository.local.message)
            // A late fix is not queued.
            repository.local.enqueue(TrackPoint("late", System.currentTimeMillis(), 1.0, 2.0, 5f, listOf("run-g")))
            assertEquals(1, repository.local.count())
            repository.local.clear(); repository.local.close()
        }
        val repository = connected(Server { if (it.startsWith("/native/apps/")) 401 else 200 })
        assertTrue(runCatching { repository.enable(repository.local.apps().first()) }.isFailure)
        assertTrue(repository.local.expired)
        repository.local.clear(); repository.local.close(); SecureStore(ApplicationProvider.getApplicationContext()).clear()
    }
    @Test fun networkErrors429And5xxNeverExpire() = kotlinx.coroutines.runBlocking {
        for (status in listOf(0, 429, 500, 503)) {
            val repository = connected(Server { if (it == "/native/me") status else 200 })
            assertTrue(runCatching { repository.sync() }.isFailure)
            assertFalse("$status", repository.local.expired)
            assertEquals("ndev_old", repository.token())
            assertEquals(1, repository.local.count())
            repository.local.clear(); repository.local.close()
        }
        SecureStore(ApplicationProvider.getApplicationContext()).clear()
    }
    @Test fun expiredSurvivesARelaunchAndReconnectClearsTheQueueAndGrants() = kotlinx.coroutines.runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val server = Server { if (it == "/native/me") 401 else 200 }
        val first = connected(server)
        assertTrue(runCatching { first.sync() }.isFailure)
        first.local.close()
        // Relaunch: new store and repository instances.
        val local = LocalStore(context)
        val repository = CompanionRepository(local, SecureStore(context), server)
        assertTrue(local.expired); assertNull(repository.token()); assertEquals(1, local.count())
        // Reconnect: the same pairing flow.
        server.status = { 200 }
        SecureStore(context).write(JSONObject().put("pairId", "abcdef0123").put("verifier", "00"))
        assertTrue(repository.finishSignIn())
        assertEquals("ndev_new", repository.token())
        assertFalse(local.expired)
        assertEquals(0, local.count())
        assertNull("the old device's grant is gone", local.apps().single().grantId)
        assertEquals(123L, local.deviceExpiresAt)
        local.clear(); local.close(); SecureStore(context).clear()
    }
    @Test fun renewingEarlyUploadsFirst() = kotlinx.coroutines.runBlocking {
        val server = Server { 200 }
        val repository = connected(server)
        repository.renew()
        assertEquals(listOf("GET /native/me", "POST /native/locations"), server.seen)
        assertTrue(repository.local.expired); assertNull(repository.token()); assertEquals(0, repository.local.count())
        repository.local.clear(); repository.local.close()
    }
    @Test fun disconnectStillWipesEverything() = kotlinx.coroutines.runBlocking {
        for (expire in listOf(false, true)) {
            val server = Server { 200 }
            val repository = connected(server)
            if (expire) { server.status = { 401 }; runCatching { repository.sync() }; server.status = { 200 } }
            repository.disconnect()
            assertFalse(repository.local.expired)
            assertEquals(0, repository.local.count())
            assertEquals(emptyList<ConnectedApp>(), repository.local.apps())
            assertNull(repository.token())
            repository.local.close()
        }
    }

    /** A pairing the server calls expired (403) or used (409) is forgotten; a pending one or a network error keeps it. */
    @Test fun aDeadPairingIsForgottenSoSignInStartsClean() = kotlinx.coroutines.runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val secure = SecureStore(context)
        var answer: () -> JSONObject = { JSONObject().put("pending", true) }
        val api = object : FasApi() { override fun request(method: String, path: String, token: String?, body: JSONObject?) = answer() }
        val repository = CompanionRepository(LocalStore(context), secure, api)
        fun pair() = secure.write(JSONObject().put("pairId", "abcdef0123").put("verifier", "00"))
        pair()
        assertFalse(repository.finishSignIn()); assertEquals("ABCDEF01", repository.pairingCode())
        answer = { throw java.io.IOException("offline") }
        assertTrue(runCatching { repository.finishSignIn() }.isFailure); assertEquals("ABCDEF01", repository.pairingCode())
        for (status in listOf(403, 409)) {
            pair()
            answer = { throw ApiFailure(status, "Invalid or expired connection.") }
            assertEquals(status, (runCatching { repository.finishSignIn() }.exceptionOrNull() as ApiFailure).status)
            assertEquals("", repository.pairingCode())
            assertFalse(repository.finishSignIn())
        }
        secure.clear()
    }
}
