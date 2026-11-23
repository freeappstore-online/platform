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
}
