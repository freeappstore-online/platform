package online.freeappstore.companion

import android.content.Context
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
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

    private fun screen(state: CompanionState, actions: CompanionActions = CompanionActions(), store: CatalogueState = catalogue, tab: Tab = Tab.SHARING) {
        compose.setContent {
            var consent by remember { mutableStateOf<ConnectedApp?>(null) }
            MaterialTheme { FasScreen(state, store, actions, consent, { consent = it }, tab) }
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
        // A grant still held while the server revocation is pending reads "Turning off…", as on iOS.
        compose.onNodeWithText("Turning off…", useUnmergedTree = true).assertExists()
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
        screen(CompanionState(), tab = Tab.STORE)
        compose.onNodeWithText("Health Fitness").assertExists()
        compose.onNodeWithTag("store").performScrollToNode(hasText("All apps"))
        compose.onNodeWithText("All apps").assertIsDisplayed()
        compose.onNodeWithTag("store").performScrollToNode(hasContentDescription("Open Hanzi Practice"))
        compose.onNodeWithContentDescription("Open Hanzi Practice").assertIsDisplayed()
        compose.onAllNodesWithText("中", useUnmergedTree = true).onFirst().assertExists()
    }
    @Test fun storeOpenUsesTheValidatedAppUrlWithInstall() {
        val opened = mutableListOf<String>()
        screen(CompanionState(), CompanionActions(open = { opened += it }), tab = Tab.STORE)
        compose.onNodeWithTag("store").performScrollToNode(hasContentDescription("Open Hanzi Practice"))
        compose.onNodeWithContentDescription("Open Hanzi Practice").performClick()
        assertEquals(listOf("https://hanzi.freeappstore.online/?install=1"), opened)
    }
    @Test fun searchFiltersAndSaysWhenNothingMatches() {
        screen(CompanionState(), tab = Tab.STORE)
        compose.onNodeWithText("Search apps").performTextInput("chinese")
        compose.onNodeWithContentDescription("Open Hanzi Practice").assertIsDisplayed()
        compose.onNodeWithContentDescription("Open Run").assertDoesNotExist()
        compose.onNodeWithText("chinese").performTextReplacement("zzz")
        compose.onNodeWithText("No apps match “zzz”").assertIsDisplayed()
    }
    @Test fun emptyStoreOffersRetry() {
        var retried = 0
        screen(CompanionState(), CompanionActions(refreshCatalogue = { retried++ }), store = CatalogueState(), tab = Tab.STORE)
        compose.onNodeWithText("Connect to the internet to load the store").assertIsDisplayed()
        compose.onNodeWithText("Retry").performClick()
        assertEquals(1, retried)
    }
    /** The toggle never grants: it opens the same disclosure, and only its button enables. */
    @Test fun detailToggleOpensTheDisclosureAndOnlyItsButtonEnables() {
        var granted = 0
        screen(CompanionState(signedIn = true, apps = listOf(run)), CompanionActions(enable = { granted++ }), tab = Tab.STORE)
        compose.onAllNodesWithText("Run").onFirst().performClick()
        compose.onNodeWithText("Use with companion").assertIsDisplayed()
        compose.onNodeWithText("Permissions").performScrollTo().assertIsDisplayed()
        // The first switch is the companion's; the second, Contribute (#731).
        compose.onAllNodes(isToggleable()).onFirst().performScrollTo().assertIsOff().performClick()
        compose.onNodeWithText(run.disclosure).assertIsDisplayed()
        assertEquals(0, granted)
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(0, granted)
        compose.onAllNodes(isToggleable()).onFirst().performClick()
        compose.onNodeWithText("Enable for Run").performClick()
        assertEquals(1, granted)
    }
    /** #731: opting in to Contribute asks first; only its button opts in. */
    @Test fun contributeAsksBeforeOptingIn() {
        val opted = mutableListOf<Pair<String, Boolean>>()
        screen(CompanionState(signedIn = true, apps = listOf(run)), CompanionActions(contribute = { id, on -> opted += id to on }), tab = Tab.STORE)
        compose.onAllNodesWithText("Run").onFirst().performClick()
        compose.onAllNodes(isToggleable())[1].performScrollTo().assertIsOff().performClick()
        compose.onNodeWithText(contributeDisclosure("Run")).assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        assertTrue(opted.isEmpty())
        compose.onAllNodes(isToggleable())[1].performClick()
        compose.onNodeWithText("Contribute to Run").performClick()
        assertEquals(listOf("run" to true), opted)
    }
    /** #820: the status card, today's chips opening Activity filtered, a job's detail, and Settings behind the gear. */
    @Test fun contributeTabSplitsStatusActivityAndSettings() {
        val now = System.currentTimeMillis()
        val rejected = Contribution("j1", "run", "book/1", now, "rejected", "transcript_mismatch", "It was a bright cold day.", 3_000, 12_000, submissionId = "s1")
        val accepted = Contribution("j2", "run", "book/2", now - 1, "accepted", "", "Then it rained.", artifactUrl = "https://api.freeappstore.online/v1/apps/run/generation/artifacts/j2")
        var refreshed = 0
        val reports = mutableListOf<Triple<String, Boolean, String>>()
        screen(CompanionState(signedIn = true, now = now, contributeApps = setOf("run"), contributedToday = mapOf("run" to 2), contributions = listOf(rejected, accepted)),
            CompanionActions(openJobs = { mapOf("run" to 3, "hanzi-practice" to 1) }, refreshContributions = { refreshed++ },
                sendReport = { c, good, note -> reports += Triple(c.jobId, good, note) }), tab = Tab.CONTRIBUTE)
        compose.onNodeWithText("Paused").assertIsDisplayed()
        compose.onNodeWithText("No voice model. Download it in Settings.").assertIsDisplayed()
        compose.onNodeWithText("1 accepted").assertIsDisplayed()
        compose.onNodeWithText("1 rejected").performClick()
        compose.onNodeWithText("Run · book/1").assertIsDisplayed()
        compose.onNodeWithText("Run · book/2").assertDoesNotExist()
        compose.onNodeWithText("Run · book/1").performClick()
        compose.onNodeWithText("transcript_mismatch").assertIsDisplayed()
        compose.onNodeWithText("Error rate").assertDoesNotExist() // people judge quality, no AI (#831)
        compose.onNodeWithText("0:03").assertIsDisplayed()
        compose.onNodeWithText("It was a bright cold day.").assertIsDisplayed()
        compose.onNodeWithText("Play").assertDoesNotExist() // only accepted jobs play
        compose.onNodeWithText("Not good").performScrollTo().performClick()
        compose.onNodeWithText("Send").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals("this phone's own upload gets a report (#831)", listOf(Triple("j1", false, "")), reports)
        compose.onNodeWithText("‹ Activity").performClick()
        compose.onNodeWithText("All").performClick()
        compose.onNodeWithText("Run · book/2").performClick()
        compose.onNodeWithText("Play").assertIsDisplayed()
        compose.onNodeWithText("Your report").assertDoesNotExist() // not uploaded from this phone
        compose.onNodeWithText("‹ Activity").performClick()
        compose.onNodeWithText("‹ Contribute").performClick()
        compose.onNodeWithContentDescription("Contribute settings").performClick()
        compose.onNodeWithText("3 open jobs · 2 today").assertIsDisplayed()
        compose.onNodeWithText("1 open job").assertIsDisplayed() // an app with work, not opted in
        compose.onNodeWithText("Download (${KokoroModel.DOWNLOAD_BYTES / 1_000_000} MB)").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Only while plugged in on Wi‑Fi").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Storage used").performScrollTo().assertIsDisplayed()
        assertEquals(0, refreshed)
    }
    /** Lines that break inside a word in the texts on screen. */
    private fun brokenWords(): List<String> =
        compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), useUnmergedTree = true).fetchSemanticsNodes().flatMap { node ->
            val layouts = mutableListOf<TextLayoutResult>()
            node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layouts)
            val layout = layouts.firstOrNull() ?: return@flatMap emptyList()
            val text = layout.layoutInput.text.text
            (0 until layout.lineCount - 1).map { layout.getLineEnd(it) }
                .filter { it in 1 until text.length && text[it - 1].isLetterOrDigit() && text[it].isLetterOrDigit() }.map { "$text @$it" }
        }
    /** #806, #820: at large font sizes no text breaks inside a word on any Contribute page: label/value rows stack, tab labels stay on one line. */
    @Test fun largeFontsNeverBreakAWord() {
        val now = System.currentTimeMillis()
        val state = CompanionState(signedIn = true, now = now, contributeApps = setOf("run"), model = ModelState.WAITING, modelDownloaded = 120_000_000,
            contributing = "Generating Run · pride-and-prejudice/chapter-12 · sentence 3 of 40 · 1.6× real time",
            contributions = listOf(Contribution("j1", "run", "pride-and-prejudice/chapter-12", now, "skipped", "stopped", "It is a truth universally acknowledged."),
                Contribution("j2", "run", "pride-and-prejudice/chapter-11", now, "pending", "", "", 63_000, 412_000)))
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                MaterialTheme { FasScreen(state, catalogue, CompanionActions(openJobs = { mapOf("run" to 12) }), null, {}, Tab.CONTRIBUTE) }
            }
        }
        compose.onNodeWithText("Running").assertExists()
        assertEquals("status", emptyList<String>(), brokenWords())
        compose.onNodeWithText("Activity").performScrollTo().performClick()
        compose.onNodeWithText("Being checked").performScrollTo()
        compose.onNodeWithText("stopped · not retried on this phone", substring = true).assertExists()
        assertEquals("activity", emptyList<String>(), brokenWords())
        compose.onNodeWithText("Run · pride-and-prejudice/chapter-11").performScrollTo().performClick()
        compose.onNodeWithText("1:03").performScrollTo()
        assertEquals("detail", emptyList<String>(), brokenWords())
        compose.onNodeWithText("‹ Activity").performClick()
        compose.onNodeWithText("Run · pride-and-prejudice/chapter-12").performScrollTo().performClick()
        compose.onNodeWithText("Reason on this phone").performScrollTo()
        assertEquals("device detail", emptyList<String>(), brokenWords())
        compose.onNodeWithText("‹ Activity").performClick()
        compose.onNodeWithText("‹ Contribute").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Contribute settings").performClick()
        compose.onNodeWithText("12 open jobs").assertExists()
        compose.onNodeWithText("Storage used").performScrollTo()
        assertEquals("settings", emptyList<String>(), brokenWords())
    }
    @Test fun signedOutDetailOffersSignInInsteadOfTheToggle() {
        var connects = 0
        screen(CompanionState(apps = listOf(run)), CompanionActions(connect = { connects++ }), tab = Tab.STORE)
        compose.onAllNodesWithText("Run").onFirst().performClick()
        compose.onNode(isToggleable()).assertDoesNotExist()
        compose.onNodeWithText("Sign in to use with FreeAppStore").performClick()
        assertEquals(1, connects)
    }
    @Test fun enabledAppsAppearUnderYours() {
        screen(CompanionState(signedIn = true, apps = listOf(run.copy(grantId = "g"))), tab = Tab.STORE)
        compose.onNodeWithText("Yours").assertExists()
    }

    @Test fun queueSurvivesReopenAndRevokesOnlyItsRecipient() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val local = LocalStore(context)
        local.clear()
        fun app(id: String, grant: String) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", JSONObject().put("id", grant).put("consent_at", 1))
        local.saveApps(JSONArray().put(app("walk", "walk-old")).put(app("rideshare", "ride-grant")))
        local.paused = false
        local.enqueue(TrackPoint("point", 10, 1.0, 2.0, 5f, listOf("walk-old", "ride-grant")))
        local.close()
        val reopened = LocalStore(context)
        assertEquals(1, reopened.count())
        reopened.block("walk")
        assertEquals(listOf("ride-grant"), reopened.pending().single().grants)
        // A callback prepared before revocation cannot put the old recipient back.
        reopened.enqueue(TrackPoint("late", 11, 1.0, 2.0, 5f, listOf("walk-old")))
        assertEquals(1, reopened.count())
        reopened.acknowledge(listOf("not-this-point"))
        assertEquals(1, reopened.count())
        reopened.acknowledge(listOf("point"))
        assertEquals(0, reopened.count())
        reopened.clear(); reopened.close()
    }
    // Per-app pause (#619, ported from PAS #626)
    private fun store(): LocalStore {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val local = LocalStore(context)
        local.clear()
        fun app(id: String, grant: String) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", JSONObject().put("id", grant).put("consent_at", 1))
        local.saveApps(JSONArray().put(app("walk", "walk-g")).put(app("run", "run-g")))
        local.paused = false
        local.writableDatabase.delete("share_events", null, null) // start each history test from an empty record
        return local
    }
    @Test fun pauseFiltersNewPointsToTheOtherRecipient() {
        val local = store()
        local.pause("walk")
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("walk-g", "run-g")))
        assertEquals(listOf("run-g"), local.pending().single().grants)
        local.pause("run")
        local.enqueue(TrackPoint("q", 11, 1.0, 2.0, 5f, listOf("walk-g", "run-g")))
        assertEquals(1, local.count())
        local.clear(); local.close()
    }
    @Test fun pauseLeavesQueuedPointsUntouched() {
        val local = store()
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("walk-g", "run-g")))
        local.pause("walk")
        assertEquals(listOf("walk-g", "run-g"), local.pending().single().grants)
        local.clear(); local.close()
    }
    @Test fun resumeRestoresTaggingAndBlockClearsThePause() {
        val local = store()
        local.pause("walk"); local.resume("walk")
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("walk-g", "run-g")))
        assertEquals(listOf("walk-g", "run-g"), local.pending().single().grants)
        local.pause("walk"); local.block("walk")
        assertEquals(emptySet<String>(), local.pausedApps())
        assertEquals(setOf("walk"), local.excluded())
        local.clear(); local.close()
    }
    @Test fun pausesSurviveReopenAndClearEmptiesThem() {
        val local = store()
        local.pause("walk"); local.close()
        val reopened = LocalStore(ApplicationProvider.getApplicationContext())
        assertEquals(setOf("walk"), reopened.pausedApps())
        reopened.clear()
        assertEquals(emptySet<String>(), reopened.pausedApps())
        reopened.close()
    }
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
    @Test fun anExpiredConnectionShowsReconnectAndKeepsTheHistory() {
        var reconnects = 0
        val events = listOf(ShareEvent(1, 1, "run", ShareEvent.Kind.ENABLED, ""), ShareEvent(2, 2, null, ShareEvent.Kind.EXPIRED, ""))
        screen(CompanionState(expired = true, apps = listOf(run.copy(grantId = "old")), events = events), CompanionActions(reconnect = { reconnects++ }))
        compose.onAllNodesWithText("Connection expired").onFirst().assertIsDisplayed()
        compose.onNodeWithText("Sign in to FreeAppStore").assertDoesNotExist()
        compose.onNodeWithText("Pause all").assertDoesNotExist()
        compose.onAllNodesWithText("Connection expired", useUnmergedTree = true).assertCountEquals(2) // the card and Run's chip
        compose.onNodeWithText("Reconnect").performClick()
        assertEquals(1, reconnects)
        compose.onNodeWithText("Activity").performClick()
        compose.onNodeWithText("Connection to FreeAppStore expired: sharing stopped", substring = true).assertExists()
    }
    @Test fun theExpiryNoteShowsInSettingsOnlyWhenSet() {
        var reconnects = 0
        screen(CompanionState(signedIn = true, expiresInDays = 1), CompanionActions(reconnect = { reconnects++ }), tab = Tab.SETTINGS)
        compose.onNodeWithText("Connection renews when you reconnect — expires in 1 day").assertIsDisplayed()
        compose.onNodeWithText("Reconnect").performClick()
        assertEquals(1, reconnects)
    }
    @Test fun noExpiryNoteWithMoreThanAWeekLeft() {
        screen(CompanionState(signedIn = true, apps = listOf(run)), tab = Tab.SETTINGS)
        compose.onNodeWithText("Reconnect").assertDoesNotExist()
    }

    // Google Play readiness (#650, #653, #657)
    @Test fun settingsOffersDeleteAccountBesideDisconnect() {
        val opened = mutableListOf<String>()
        screen(CompanionState(signedIn = true, name = "Alex"), CompanionActions(open = { opened += it }), tab = Tab.SETTINGS)
        compose.onNodeWithText("Sign out").assertExists()
        compose.onNodeWithText("Delete account").performScrollTo().performClick()
        assertEquals(listOf("https://freeappstore.online/app/settings?delete-account=1"), opened)
    }
    // The signed-in profile (#829).
    @Test fun settingsShowTheProfileAndTheStoreItsSummary() {
        val opened = mutableListOf<String>()
        val profile = Profile("gh:1", "Alex", "alex", "github", null, "a@example.com", listOf("user", "creator"), 3, "Google Pixel 8", 1L, 2L)
        screen(CompanionState(signedIn = true, name = "Alex", profile = profile), CompanionActions(open = { opened += it }), tab = Tab.SETTINGS)
        compose.onNodeWithText("@alex").assertExists()
        compose.onNodeWithText("gh:1").assertExists()
        compose.onNodeWithText("a@example.com").assertExists()
        compose.onNodeWithText("user, creator").assertExists()
        compose.onNodeWithText("Google Pixel 8").performScrollTo().assertExists()
        compose.onNodeWithText("Open the console").performScrollTo().performClick()
        assertEquals(listOf("https://freeappstore.online/app/"), opened)
        compose.onNodeWithText("Store").performClick()
        compose.onNodeWithTag("profile-summary").assertIsDisplayed().performClick()
        compose.onNodeWithText("gh:1").assertExists()
    }
    @Test fun permissionCopyUsesTheSystemsOptionLabel() {
        screen(CompanionState(signedIn = true, permission = "always", backgroundOption = "Allow always"), tab = Tab.SETTINGS)
        compose.onNodeWithText("Precise location is set to “Allow always”.").assertExists()
    }
    @Test fun uploadWorkIsScheduledOnlyWhilePaired() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        fun states() = androidx.work.WorkManager.getInstance(context).getWorkInfosForUniqueWork(UploadWorker.NAME).get().map { it.state }
        UploadWorker.schedule(context, paired = true)
        assertEquals(listOf(androidx.work.WorkInfo.State.ENQUEUED), states())
        UploadWorker.schedule(context, paired = false)
        assertTrue(states().all { it == androidx.work.WorkInfo.State.CANCELLED })
    }

    /** Answers like the server: `status(path)` decides per call; 200 paths get a usable body. */
    private class Server(var status: (String) -> Int) : FasApi() {
        val seen = mutableListOf<String>()
        override fun request(method: String, path: String, token: String?, body: JSONObject?): JSONObject {
            seen += "$method $path"
            when (val code = status(path)) {
                0 -> throw java.io.IOException("offline")
                200 -> return when (path) {
                    "/native/me" -> JSONObject().put("user", JSONObject().put("id", userId).put("name", "Alex"))
                        .put("device", JSONObject().put("id", "d1").put("label", "Pixel").put("expiresAt", 123L))
                        .put("apps", JSONArray().put(JSONObject().put("id", "walk").put("name", "Walk").put("purpose", "Routes").put("disclosure", "D").put("version", "1")
                            .put("grant", if (token == "ndev_new") JSONObject.NULL else JSONObject().put("id", "walk-g").put("consent_at", 1))))
                    "/native/auth/complete" -> JSONObject().put("token", "ndev_new")
                    "/native/locations" -> JSONObject().put("acknowledged", JSONArray(body!!.getJSONArray("points").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") } }))
                    else -> JSONObject()
                }
                else -> throw ApiFailure(code, "Device connection expired or was disconnected.")
            }
        }
        var userId = "u1"
    }
    private fun connected(server: Server): CompanionRepository {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val local = store()
        // Only Walk, as the fake server answers, so no `grant_lost` for Run.
        local.saveApps(JSONArray().put(JSONObject().put("id", "walk").put("name", "Walk").put("purpose", "Routes").put("disclosure", "D").put("version", "1")
            .put("grant", JSONObject().put("id", "walk-g").put("consent_at", 1))))
        local.writableDatabase.delete("share_events", null, null)
        SecureStore(context).write(JSONObject().put("token", "ndev_old").put("userId", "u1"))
        local.enqueue(TrackPoint("p", System.currentTimeMillis(), 1.0, 2.0, 5f, listOf("walk-g")))
        return CompanionRepository(local, SecureStore(context), server)
    }
    private fun LocalStore.kinds() = events().map { it.kind }
    @Test fun a401FromAnyDeviceCallExpiresTheConnection() = kotlinx.coroutines.runBlocking {
        for (failing in listOf("/native/me", "/native/locations")) {
            val repository = connected(Server { if (it == failing) 401 else 200 })
            assertTrue(runCatching { repository.sync() }.isFailure)
            val local = repository.local
            assertTrue(failing, local.expired)
            assertEquals("u1", local.expiredUser)
            assertNull(repository.token())
            assertFalse("collection stops", repository.collecting())
            assertEquals("", local.message)
            assertEquals(listOf(ShareEvent.Kind.EXPIRED), local.kinds())
            local.enqueue(TrackPoint("late", System.currentTimeMillis(), 1.0, 2.0, 5f, listOf("walk-g")))
            assertEquals(1, local.count())
            local.clear(); local.close()
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
    @Test fun expiredSurvivesARelaunchAndReconnectKeepsHistoryButNotQueueOrGrants() = kotlinx.coroutines.runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val server = Server { 200 }
        val first = connected(server)
        first.sync() // "p" uploads: shared history
        first.local.enqueue(TrackPoint("q", System.currentTimeMillis(), 1.0, 2.0, 5f, listOf("walk-g"))) // still queued
        first.local.record(ShareEvent.Kind.ENABLED, "walk")
        server.status = { if (it == "/native/me") 401 else 200 }
        assertTrue(runCatching { first.sync() }.isFailure)
        first.local.close()
        // Relaunch: new store and repository instances.
        val local = LocalStore(context)
        val repository = CompanionRepository(local, SecureStore(context), server)
        assertTrue(local.expired); assertNull(repository.token()); assertEquals(1, local.count())
        // Reconnect: the same pairing flow, same account.
        server.status = { 200 }
        SecureStore(context).write(JSONObject().put("pairId", "abcdef0123").put("verifier", "00"))
        assertTrue(repository.finishSignIn())
        assertEquals("ndev_new", repository.token())
        assertFalse(local.expired)
        assertEquals(0, local.count())
        assertNull("the old device's grant is gone", local.apps().single().grantId)
        assertEquals("no grant_lost noise", listOf(ShareEvent.Kind.ENABLED, ShareEvent.Kind.EXPIRED), local.kinds())
        assertEquals("the shared point stays, the unsent one goes", 1, local.track("walk", 0, Long.MAX_VALUE).size)
        assertEquals(123L, local.deviceExpiresAt)
        local.clear(); local.close(); SecureStore(context).clear()
    }
    @Test fun reconnectingAsAnotherAccountClearsEverything() = kotlinx.coroutines.runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val server = Server { if (it == "/native/me") 401 else 200 }
        val repository = connected(server)
        assertTrue(runCatching { repository.sync() }.isFailure)
        server.status = { 200 }; server.userId = "u2"
        SecureStore(context).write(JSONObject().put("pairId", "abcdef0123").put("verifier", "00"))
        assertTrue(repository.finishSignIn())
        assertEquals(emptyList<ShareEvent>(), repository.local.events())
        assertEquals(0, repository.local.count())
        repository.local.clear(); repository.local.close(); SecureStore(context).clear()
    }
    @Test fun renewingEarlyUploadsFirstThenKeepsHistory() = kotlinx.coroutines.runBlocking {
        val server = Server { 200 }
        val repository = connected(server)
        repository.renew()
        assertEquals(listOf("GET /native/me", "POST /native/locations"), server.seen)
        assertTrue(repository.local.expired); assertNull(repository.token()); assertEquals(0, repository.local.count())
        assertEquals("renew", repository.local.events().last().detail)
        assertEquals(1, repository.local.track("walk", 0, Long.MAX_VALUE).size)
        repository.local.clear(); repository.local.close()
    }
    @Test fun disconnectStillWipesEverything() = kotlinx.coroutines.runBlocking {
        for (expire in listOf(false, true)) {
            val server = Server { 200 }
            val repository = connected(server)
            repository.sync()
            if (expire) { server.status = { 401 }; runCatching { repository.sync() }; server.status = { 200 } }
            repository.disconnect()
            val local = repository.local
            assertFalse(local.expired)
            assertEquals(emptyList<ShareEvent>(), local.events())
            assertEquals(emptyList<TrackSample>(), local.track("walk", 0, Long.MAX_VALUE))
            assertEquals(0, local.count())
            assertEquals(emptyList<ConnectedApp>(), local.apps())
            assertNull(repository.token())
            local.close()
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

    /** The one-time exchange's credential survives a failed `/native/me`, so the retry does not hit 409. */
    @Test fun theIssuedCredentialSurvivesAFailedMe() = kotlinx.coroutines.runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val secure = SecureStore(context)
        val calls = mutableListOf<String>()
        var meFails = true
        val api = object : FasApi() {
            override fun request(method: String, path: String, token: String?, body: JSONObject?): JSONObject {
                calls += path
                return when (path) {
                    "/native/auth/complete" -> JSONObject().put("token", "ndev_once")
                    else -> if (meFails) throw java.io.IOException("offline") else JSONObject()
                        .put("user", JSONObject().put("id", "u1").put("name", "Sam")).put("apps", JSONArray())
                }
            }
        }
        val repository = CompanionRepository(LocalStore(context), secure, api)
        secure.write(JSONObject().put("pairId", "abcdef0123").put("verifier", "00"))
        assertTrue(runCatching { repository.finishSignIn() }.isFailure)
        assertNull(repository.token())
        meFails = false
        assertTrue(repository.finishSignIn())
        assertEquals(listOf("/native/auth/complete", "/native/me", "/native/me"), calls)
        assertEquals("ndev_once", repository.token())
        repository.local.clear(); secure.clear()
    }

    /** #660: re-enabling an app that is still turning off keeps the new grant when `/native/me` fails after the PUT. */
    @Test fun reEnablingWhileTurningOffSurvivesAFailedMe() = kotlinx.coroutines.runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val secure = SecureStore(context)
        val local = store() // walk and run granted
        secure.write(JSONObject().put("token", "ndev_test").put("userId", "u1"))
        local.block("walk")
        val calls = mutableListOf<String>()
        val api = object : FasApi() {
            override fun request(method: String, path: String, token: String?, body: JSONObject?): JSONObject {
                calls += "$method $path"
                return when (method) {
                    "PUT" -> JSONObject().put("grant", JSONObject().put("id", "walk-2").put("consent_at", 2))
                    "DELETE" -> JSONObject().put("revoked", true)
                    else -> throw java.io.IOException("offline")
                }
            }
        }
        CompanionRepository(local, secure, api).enable(local.apps().first { it.id == "walk" })
        assertEquals(listOf("DELETE /native/apps/walk/location", "PUT /native/apps/walk/location", "GET /native/me"), calls)
        assertEquals(emptySet<String>(), local.blocked())
        assertEquals("walk-2", local.apps().first { it.id == "walk" }.grantId)
        assertFalse(local.events().any { it.kind == ShareEvent.Kind.GRANT_LOST })
        assertEquals(ShareEvent.Kind.ENABLED, local.events().last().kind)
        local.clear(); local.close(); secure.clear()
    }

    // On-device sharing history (#649), ported from PAS (iOS LocalStoreTests).
    @Test fun enqueueWritesHistoryPerAppAndAcknowledgeKeepsIt() {
        val local = store()
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("walk-g", "run-g")))
        assertEquals(1, local.pendingCount("walk")); assertEquals(1, local.pendingCount("run"))
        assertNull(local.lastUpload("run"))
        local.acknowledge(listOf("p"), now = 500)
        assertEquals(0, local.count())
        assertEquals(0, local.pendingCount("run"))
        assertEquals(500L, local.lastUpload("run"))
        assertEquals(listOf(TrackSample(10, 1.0, 2.0, 5.0, 500)), local.track("walk", 0, 100))
        assertEquals(emptyList<TrackSample>(), local.track("walk", 11, 100))
        local.clear(); local.close()
    }
    @Test fun blockDropsOnlyThatAppsUnsentHistory() {
        val local = store()
        local.enqueue(TrackPoint("sent", 10, 1.0, 2.0, 5f, listOf("walk-g", "run-g")))
        local.acknowledge(listOf("sent"))
        local.enqueue(TrackPoint("queued", 11, 1.0, 2.0, 5f, listOf("walk-g", "run-g")))
        local.block("walk")
        assertEquals(listOf(10L), local.track("walk", 0, 100).map { it.at })
        assertEquals(listOf(10L, 11L), local.track("run", 0, 100).map { it.at })
        assertEquals(listOf(ShareEvent.Kind.DISABLED), local.events().map { it.kind })
        local.clear(); local.close()
    }
    @Test fun expireKeepsThirtyDaysAndTheLastStateBeforeTheWindow() {
        val local = store()
        val day = 24 * 60 * 60 * 1000L
        val now = 100 * day
        local.record(ShareEvent.Kind.ENABLED, "run", at = now - 40 * day)
        local.record(ShareEvent.Kind.PAUSED, "run", at = now - 39 * day)
        local.record(ShareEvent.Kind.PAUSED, "run", at = now - 35 * day)
        local.record(ShareEvent.Kind.RESUMED, "run", at = now - day)
        local.enqueue(TrackPoint("old", now - 31 * day, 1.0, 2.0, 5f, listOf("run-g")))
        local.enqueue(TrackPoint("unsent", now - 8 * day, 1.0, 2.0, 5f, listOf("run-g")))
        local.enqueue(TrackPoint("recent", now - day, 1.0, 2.0, 5f, listOf("run-g")))
        local.acknowledge(listOf("old", "recent"))
        local.expire(now)
        assertEquals(listOf(now - day), local.track("run", 0, now).map { it.at })
        assertEquals(listOf(now - 40 * day, now - 35 * day, now - day), local.events().map { it.at })
        local.clear(); local.close()
    }
    @Test fun clearHistoryKeepsTheQueueAndReseeds() {
        val local = store()
        local.pause("walk")
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("run-g")))
        local.clearHistory(now = 1_000)
        assertEquals(1, local.count())
        assertEquals(emptyList<TrackSample>(), local.track("run", 0, 100))
        assertEquals(listOf("history_cleared", "enabled:walk", "enabled:run", "paused:walk"),
            local.events().map { e -> e.kind.raw + (e.appId?.let { ":$it" } ?: "") })
        local.clear()
        assertEquals(emptyList<ShareEvent>(), local.events())
        local.close()
    }
    @Test fun seedingAnEmptyHistoryStartsAtConsent() {
        val local = store()
        local.seedIfEmpty(now = 5_000)
        assertEquals(listOf(1L, 1L), local.events().map { it.at })
        assertEquals("seeded", local.events().first().detail)
        local.seedIfEmpty(now = 6_000)
        assertEquals(2, local.events().size)
        local.clear(); local.close()
    }
    @Test fun perAppHistoryReadsUseTheIndexAndUpgradeIsRepeatable() {
        val local = store()
        local.onUpgrade(local.writableDatabase, 2, 3) // a version-2 install, and running it again changes nothing
        for (sql in listOf("SELECT COUNT(*) FROM share_points WHERE app_id = ? AND sent_at IS NULL", "SELECT MAX(sent_at) FROM share_points WHERE app_id = ?")) {
            val plan = local.readableDatabase.rawQuery("EXPLAIN QUERY PLAN $sql", arrayOf("walk")).use { c -> buildList { while (c.moveToNext()) add(c.getString(3)) } }
            assertTrue(plan.toString(), plan.any { "share_points_app_sent" in it })
        }
        local.clear(); local.close()
    }
    @Test fun pauseAllAndAForcedStopAreRecordedOnce() {
        val local = store()
        local.paused = true; local.paused = true; local.paused = false
        local.stop("signed_out"); local.stop("signed_out")
        assertEquals(listOf("paused_all", "resumed_all", "stopped"), local.events().map { it.kind.raw })
        assertEquals("signed_out", local.events().last().detail)
        assertTrue(local.paused)
        local.clear(); local.close()
    }
    @Test fun grantChangesFromTheServerAreLogged() {
        val local = store()
        fun app(id: String, grant: String?) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", grant?.let { JSONObject().put("id", it).put("consent_at", 1) } ?: JSONObject.NULL)
        local.saveApps(JSONArray().put(app("walk", null)).put(app("run", "run-new")))
        assertEquals(listOf("grant_lost:walk:revoked", "grant_lost:run:replaced"), local.events().map { "${it.kind.raw}:${it.appId}:${it.detail}" })
        local.saveApps(JSONArray().put(app("walk", "walk-back")).put(app("run", "run-new")))
        assertEquals(ShareEvent.Kind.GRANT_RESTORED, local.events().last().kind)
        local.clear(); local.close()
    }
    @Test fun syncFailuresAreDeduplicatedAndRecoveryCounted() {
        val local = store()
        repeat(3) { local.syncFailed("0 offline") }
        local.syncSucceeded()
        local.syncSucceeded()
        assertEquals(listOf("sync_failed", "sync_recovered"), local.events().map { it.kind.raw })
        assertEquals("after 3 attempts", local.events().last().detail)
        local.syncFailed("x".repeat(300))
        assertEquals(120, local.events().last().detail.length)
        assertFalse(local.events().any { Regex("-?\\d{1,3}\\.\\d{4,}").containsMatchIn(it.detail) })
        local.clear(); local.close()
    }
}
