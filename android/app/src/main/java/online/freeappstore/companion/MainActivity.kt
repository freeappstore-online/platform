package online.freeappstore.companion

import android.Manifest
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*
import java.io.IOException

data class CompanionState(
    val signedIn: Boolean = false, val name: String = "", val apps: List<ConnectedApp> = emptyList(),
    val blocked: Set<String> = emptySet(), val paused: Boolean = true, val running: Boolean = false,
    val permissions: Boolean = false, val queued: Int = 0, val message: String = "", val busy: Boolean = false,
    val pairingCode: String = "", val lastSync: Long = 0, val pausedApps: Set<String> = emptySet(),
    // Sharing control room, history and activity log (#649).
    val now: Long = System.currentTimeMillis(), val events: List<ShareEvent> = emptyList(),
    val pendingByApp: Map<String, Int> = emptyMap(), val lastUploadByApp: Map<String, Long> = emptyMap(),
    val lastSyncAttempt: Long = 0, val lastSyncError: String = "", val online: Boolean = true,
    /** `denied`, `approximate`, `whenInUse` or `always` (LocationService.permissionState). */
    val permission: String = "", val locationOn: Boolean = true, val powerSave: Boolean = false, val batteryOptimized: Boolean = false,
    val lastFix: LiveFix? = null, val version: String = "",
    /** The device connection expired or was revoked (#638); [expiresInDays] is set only in its last 7 days. */
    val expired: Boolean = false, val expiresInDays: Int? = null,
    /** The system's label for background location access (`backgroundPermissionOptionLabel`), localised (#650). */
    val backgroundOption: String = "Allow all the time",
    // Contribute (#731).
    val contributeApps: Set<String> = emptySet(), val contributeAnyTime: Boolean = false, val model: ModelState = ModelState.NONE,
    /** What the contribute work is doing, null while idle. */
    val contributing: String? = null,
    /** Voice model bytes downloaded, null while not downloading (#806). */
    val modelDownloaded: Long? = null,
    val contributions: List<Contribution> = emptyList(), val contributedToday: Map<String, Int> = emptyMap(),
    /** Why Contribute is paused (#820): plugged in (`EXTRA_PLUGGED`) and on an unmetered network. */
    val plugged: Boolean = true, val unmetered: Boolean = true,
)

data class CatalogueState(val apps: List<CatalogueApp> = emptyList(), val stale: Boolean = false, val loading: Boolean = false)

/** Everything the screens can ask for. Defaults are no-ops so tests pass only what they check. */
data class CompanionActions(
    val connect: () -> Unit = {}, val reconnect: () -> Unit = {}, val enable: (ConnectedApp) -> Unit = {}, val disable: (ConnectedApp) -> Unit = {},
    val pauseApp: (ConnectedApp) -> Unit = {}, val resumeApp: (ConnectedApp) -> Unit = {},
    val pause: () -> Unit = {}, val resume: () -> Unit = {}, val permissions: () -> Unit = {}, val sync: () -> Unit = {},
    val disconnect: () -> Unit = {}, val privacy: () -> Unit = {}, val account: () -> Unit = {},
    /** Opens a URL in the browser. Open buttons pass `?install=1` URLs (#621). */
    val open: (String) -> Unit = {}, val refreshCatalogue: () -> Unit = {},
    /** The on-device sharing history (#649): clear it, and read tracks off the main thread. */
    val clearHistory: () -> Unit = {},
    val loadTracks: suspend (List<String>, LongRange) -> Map<String, List<TrackSample>> = { _, _ -> emptyMap() },
    /** Contribute (#731): opt an app in or out, the voice model, when it runs, and the current run. */
    val contribute: (String, Boolean) -> Unit = { _, _ -> }, val downloadModel: () -> Unit = {}, val deleteModel: () -> Unit = {},
    val contributeAnyTime: (Boolean) -> Unit = {}, val contributeNow: () -> Unit = {}, val stopContributing: () -> Unit = {},
    /** Contribute's Activity and Settings (#820): the server's verdicts, open jobs by app (null when unknown), storage, artifact timings. */
    val refreshContributions: suspend () -> Unit = {}, val openJobs: suspend () -> Map<String, Int>? = { null },
    val contributeStorage: suspend () -> Pair<Long, Long> = { 0L to 0L },
    /** An accepted job's whole input (the preview when unavailable) and its sentence timings, for Play (#820, #824). */
    val loadPlayback: suspend (Contribution) -> Pair<String, List<Segment>> = { it.inputPreview to emptyList() },
)

enum class Tab(val label: String, val icon: Int) {
    STORE("Store", R.drawable.ic_store), SHARING("Sharing", R.drawable.ic_location), CONTRIBUTE("Contribute", R.drawable.ic_contribute),
    SETTINGS("Settings", R.drawable.ic_settings)
}

class MainActivity : ComponentActivity() {
    private val graph get() = application as FasApplication
    private var state by mutableStateOf(CompanionState())
    private var catalogue by mutableStateOf(CatalogueState())
    private var consent by mutableStateOf<ConnectedApp?>(null)
    private var error by mutableStateOf("")
    private var working by mutableStateOf(false)
    private var permissionExplanation by mutableStateOf(false)
    private var linkedApp: String? = null
    /** `freeappstore://native/contribute/<id>`: asks before opting in, never opts in by itself. */
    private var linkedContribute by mutableStateOf<String?>(null)
    private var refreshJob: Job? = null
    private val version by lazy { packageManager.getPackageInfo(packageName, 0).let { "${it.versionName} (${it.longVersionCode})" } }
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh(); maybeStart() }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        if (savedInstanceState == null) handleLink(intent)
        // Upgrade path: sessions for grants held before the history existed start at their consent time.
        if (graph.repository.token() != null) runCatching { graph.local.seedIfEmpty() }
        catalogue = CatalogueState(graph.catalogue.apps)
        refresh()
        val actions = CompanionActions(
            connect = { act { open(graph.repository.startSignIn()) } },
            // Pairs again keeping the history (#638): after an expiry, or early from the expiry note.
            reconnect = { act { graph.repository.renew(); stopService(Intent(this@MainActivity, LocationService::class.java)); open(graph.repository.startSignIn()) } },
            enable = { app -> act { graph.repository.enable(app); refresh(); if (LocationService.allowed(this@MainActivity)) maybeStart() else permissionExplanation = true } },
            disable = { app -> act { graph.repository.disable(app) } },
            // Local writes, not `act`: pausing works offline and instantly.
            pauseApp = { app -> graph.local.pause(app.id); if (graph.repository.recipients().isEmpty()) stopService(Intent(this, LocationService::class.java)); refresh() },
            resumeApp = { app -> graph.local.resume(app.id); refresh(); maybeStart() },
            pause = { graph.local.paused = true; stopService(Intent(this, LocationService::class.java)); refresh() },
            resume = { graph.local.paused = false; refresh(); if (LocationService.allowed(this)) maybeStart() else permissionExplanation = true },
            permissions = { permissionExplanation = true },
            sync = { act { graph.repository.sync() } },
            disconnect = { act { graph.local.paused = true; stopService(Intent(this@MainActivity, LocationService::class.java)); graph.repository.disconnect() } },
            privacy = { open("https://docs.freeappstore.online/native-companion/") },
            account = { open("https://freeappstore.online/app/") },
            open = ::open,
            refreshCatalogue = ::refreshCatalogue,
            clearHistory = { runCatching { graph.local.clearHistory() }.onFailure { error = it.message ?: "Could not clear history." }; refresh() },
            loadTracks = { ids, range -> withContext(Dispatchers.IO) { ids.associateWith { graph.local.track(it, range.first, range.last) } } },
            contribute = { id, on ->
                graph.local.setContributing(id, on)
                // Asking for an app also asks for the model it needs; the work downloads it under the same constraints.
                if (on && !graph.kokoro.installed) graph.local.modelWanted = true
                graph.scheduleWork(now = on); refresh()
            },
            downloadModel = { graph.local.modelWanted = true; graph.scheduleWork(now = true); refresh() },
            deleteModel = {
                graph.local.modelWanted = false; ContributeWorker.stop(this)
                lifecycleScope.launch { withContext(Dispatchers.IO) { graph.kokoro.delete() }; graph.scheduleWork(); refresh() }
            },
            contributeAnyTime = { graph.local.contributeAnyTime = it; graph.scheduleWork(now = true); refresh() },
            contributeNow = { graph.scheduleWork(now = true); refresh() },
            stopContributing = { ContributeWorker.stop(this); refresh() },
            refreshContributions = { withContext(Dispatchers.IO) { refreshVerdicts() }; refresh() },
            openJobs = { withContext(Dispatchers.IO) { runCatching { graph.generation.openJobs(KokoroModel.ID) }.getOrNull() } },
            contributeStorage = { withContext(Dispatchers.IO) { graph.kokoro.bytes() to graph.local.databaseBytes() } },
            loadPlayback = { c ->
                withContext(Dispatchers.IO) {
                    val text = runCatching { graph.generation.inputText(c.appId, c.jobId) }.getOrNull() ?: c.inputPreview
                    text to (c.metaUrl?.let { runCatching { graph.generation.segments(it) }.getOrNull() } ?: emptyList())
                }
            },
        )
        // Sharing when any app has a grant or the connection expired, otherwise the Store.
        val initialTab = if (state.expired || state.apps.any { it.grantId != null }) Tab.SHARING else Tab.STORE
        setContent {
            val colors = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFF60A5FA)) else lightColorScheme(primary = Color(0xFF2563EB))
            MaterialTheme(colorScheme = colors) {
                FasScreen(state.copy(busy = working, message = error.ifBlank { state.message }), catalogue, actions,
                    consent, { consent = it }, initialTab)
                if (permissionExplanation) AlertDialog(onDismissRequest = { permissionExplanation = false },
                    title = { Text("Allow background location") },
                    // Google's prominent-disclosure template (#650), and the system's own name for the option.
                    text = { Text("FreeAppStore collects location data to enable route recording for apps you enable, even when the app is closed or not in use. Updates go to FreeAppStore and only your enabled apps. On the next screen, choose Precise location, then “${state.backgroundOption}”. You can pause or revoke access here.") },
                    confirmButton = { TextButton(onClick = { permissionExplanation = false; requestLocation() }) { Text("Continue") } },
                    dismissButton = { TextButton(onClick = { permissionExplanation = false }) { Text("Not now") } })
                linkedContribute?.takeIf { state.signedIn }?.let { id ->
                    ContributeDialog(catalogue.apps.find { it.id == id }?.name ?: id, { linkedContribute = null }) {
                        linkedContribute = null; actions.contribute(id, true)
                    }
                }
            }
        }
    }
    override fun onResume() {
        super.onResume()
        refresh(); maybeStart(); refreshCatalogue()
        refreshJob?.cancel()
        refreshJob = lifecycleScope.launch {
            try {
                graph.repository.finishSignIn()
                if (graph.repository.token() != null) {
                    graph.repository.sync()
                    // The server's verdicts on this phone's contributions (#731). A refresh only.
                    withContext(Dispatchers.IO) { refreshVerdicts() }
                }
                error = ""
            }
            catch (e: Exception) { if (e is CancellationException) throw e; if (!DeviceConnection.expired(e)) error = failure(e, "Could not connect.") }
            graph.scheduleWork() // pairing finished, or the sync found the connection expired
            refresh(); maybeStart(); showLinkedDisclosure()
            while (isActive) { delay(2_000); refresh() }
        }
    }
    override fun onPause() { refreshJob?.cancel(); super.onPause() }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handleLink(intent) }
    /** `freeappstore://native/apps/<id>` selects a disclosure to show. It carries no credential and never grants. */
    private fun handleLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "freeappstore" || uri.host != "native") return
        val parts = uri.pathSegments
        if (parts.size == 2 && parts[0] == "apps") linkedApp = parts[1]
        if (parts.size == 2 && parts[0] == "contribute" && Regex("^[a-z0-9][a-z0-9-]{0,62}$").matches(parts[1])) linkedContribute = parts[1]
    }
    private fun showLinkedDisclosure() {
        val id = linkedApp ?: return
        linkedApp = null
        state.apps.find { it.id == id && !state.enabled(it) }?.let { consent = it }
    }
    /** The server's verdicts for every app this phone contributed to or is opted in to. Off the main thread. */
    private fun refreshVerdicts() =
        (graph.local.contributeApps() + graph.local.contributedApps()).forEach { runCatching { graph.generation.refresh(it, graph.local) } }
    private fun refresh() {
        val local = graph.local
        LocationService.notePermission(this, local)
        val apps = local.apps()
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val power = getSystemService(PowerManager::class.java)
        val signedIn = graph.repository.token() != null
        val network = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        state = CompanionState(signedIn, local.userName, apps, local.blocked(),
            local.paused, LocationService.running, LocationService.allowed(this), local.count(), local.message,
            pairingCode = graph.repository.pairingCode(), lastSync = local.lastSync, pausedApps = local.pausedApps(),
            now = System.currentTimeMillis(), events = runCatching { local.events() }.getOrDefault(emptyList()),
            pendingByApp = apps.associate { it.id to local.pendingCount(it.id) },
            lastUploadByApp = apps.mapNotNull { app -> local.lastUpload(app.id)?.let { app.id to it } }.toMap(),
            lastSyncAttempt = local.lastSyncAttempt, lastSyncError = local.lastSyncError,
            online = network?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
            permission = LocationService.permissionState(this),
            locationOn = getSystemService(LocationManager::class.java).isLocationEnabled,
            powerSave = power.isPowerSaveMode, batteryOptimized = !power.isIgnoringBatteryOptimizations(packageName),
            lastFix = LocationService.lastFix,
            version = version,
            expired = local.expired, backgroundOption = backgroundOption(),
            expiresInDays = if (signedIn) DeviceConnection.expiresInDays(local.deviceExpiresAt, System.currentTimeMillis()) else null,
            contributeApps = local.contributeApps(), contributeAnyTime = local.contributeAnyTime,
            model = when { graph.kokoro.installed -> ModelState.INSTALLED; local.modelWanted -> ModelState.WAITING; else -> ModelState.NONE },
            contributing = ContributeWorker.status, modelDownloaded = ContributeWorker.downloaded, contributions = local.contributions(),
            contributedToday = local.contributeApps().associateWith { local.contributedSince(it, SharingTimeline.today().first) },
            plugged = (registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0,
            unmetered = network?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true)
        if (state.expired && LocationService.running) stopService(Intent(this, LocationService::class.java))
    }
    /** Foreground only: no background budget is spent on the catalogue. */
    private fun refreshCatalogue() {
        if (catalogue.loading) return
        catalogue = catalogue.copy(loading = true)
        lifecycleScope.launch {
            withContext(Dispatchers.IO) { graph.catalogue.refresh() }
            catalogue = CatalogueState(graph.catalogue.apps, graph.catalogue.stale)
        }
    }
    private fun act(action: suspend () -> Unit) {
        if (working) return
        working = true; error = ""
        lifecycleScope.launch {
            try { action() } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (!DeviceConnection.expired(e)) error = failure(e, "Please try again.") // the expired card says it
            }
            finally { working = false; graph.scheduleWork(); refresh() } // Disconnect and expiry cancel the upload work
        }
    }
    /** Network failures get a plain sentence, not the exception's text (host names, errno). */
    private fun failure(e: Exception, fallback: String) =
        if (e is IOException) "Can't reach FreeAppStore. Check your connection and try again." else e.message ?: fallback
    private fun maybeStart() {
        if (!LocationService.allowed(this) || !graph.repository.collecting()) return
        val prompt = getSharedPreferences("native-permission-prompts", MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && !prompt.getBoolean("notifications", false)) {
            prompt.edit().putBoolean("notifications", true).apply()
            permissionRequest.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
        }
        try { LocationService.start(this) } catch (_: RuntimeException) { error = "Android could not start location sharing. Open FreeAppStore and try again." }
    }
    private fun requestLocation() {
        when {
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED ->
                permissionRequest.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            Build.VERSION.SDK_INT == 29 && !LocationService.allowed(this) -> permissionRequest.launch(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION))
            !LocationService.allowed(this) -> startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED ->
                permissionRequest.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
            else -> maybeStart()
        }
    }
    /** The localised name of the "Allow all the time" option (API 30+); API 29 shows that label in its own prompt. */
    private fun backgroundOption(): String =
        if (Build.VERSION.SDK_INT >= 30) packageManager.backgroundPermissionOptionLabel.toString() else "Allow all the time"
    private fun open(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: RuntimeException) { error = "No browser is available to open $url." }
    }
}

/** Where the user is inside the Sharing tab. */
private sealed class SharingPage {
    data object Dashboard : SharingPage()
    data object Map : SharingPage()
    data class App(val id: String) : SharingPage()
    data class Activity(val appId: String?, val from: SharingPage) : SharingPage()
}

/**
 * The tab shell: Store, Sharing and Settings. The disclosure dialog lives here, so a deep link, the Store's
 * "Use with companion" and the Sharing tab show the same disclosure, and only its button enables.
 */
@Composable
internal fun FasScreen(
    state: CompanionState, catalogue: CatalogueState, actions: CompanionActions,
    consent: ConnectedApp?, askConsent: (ConnectedApp?) -> Unit, initialTab: Tab = Tab.STORE,
) {
    var tab by rememberSaveable { mutableStateOf(initialTab) }
    var sharingPage by remember { mutableStateOf<SharingPage>(SharingPage.Dashboard) }
    var contributePage by remember { mutableStateOf<ContributePage>(ContributePage.Status) }
    val openApp = { app: ConnectedApp -> actions.open(companionAppUrl(app, catalogue.apps)) }
    val granted = state.apps.filter { it.grantId != null }
    BackHandler(enabled = tab == Tab.SHARING && sharingPage != SharingPage.Dashboard) {
        sharingPage = (sharingPage as? SharingPage.Activity)?.from ?: SharingPage.Dashboard
    }
    BackHandler(enabled = tab == Tab.CONTRIBUTE && contributePage != ContributePage.Status) { contributePage = contributePage.back }
    Scaffold(bottomBar = {
        NavigationBar {
            Tab.entries.forEach { t ->
                NavigationBarItem(selected = tab == t, onClick = {
                    if (tab == t) { sharingPage = SharingPage.Dashboard; contributePage = ContributePage.Status }
                    tab = t
                },
                    icon = { Icon(painterResource(t.icon), contentDescription = null) }, label = {
                        // One line at any font size (#806): shrinks to fit rather than breaking "Contribute" mid-word.
                        Text(t.label, maxLines = 1, softWrap = false,
                            autoSize = TextAutoSize.StepBased(minFontSize = 8.sp, maxFontSize = LocalTextStyle.current.fontSize))
                    })
            }
        }
    }) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                Tab.STORE -> StoreScreen(state, catalogue, actions, askConsent)
                Tab.SHARING -> when (val page = sharingPage) {
                    SharingPage.Dashboard -> {
                        val tracks = rememberTracks(granted, state, SharingTimeline.today(state.now), actions.loadTracks)
                        SharingDashboard(state, tracks, actions.connect, askConsent, actions.disable, actions.pauseApp, actions.resumeApp,
                            actions.pause, actions.resume, actions.permissions, actions.sync, openApp,
                            showApp = { sharingPage = SharingPage.App(it.id) }, showActivity = { sharingPage = SharingPage.Activity(null, page) },
                            showMap = { sharingPage = SharingPage.Map }, reconnect = actions.reconnect)
                    }
                    SharingPage.Map -> Column(Modifier.padding(horizontal = 16.dp).fillMaxSize()) {
                        BackRow("Sharing") { sharingPage = SharingPage.Dashboard }
                        Text("Today", style = MaterialTheme.typography.headlineMedium)
                        TrackMap(rememberTracks(granted, state, SharingTimeline.today(state.now), actions.loadTracks), state.liveFix(), interactive = true,
                            modifier = Modifier.fillMaxSize().padding(bottom = 8.dp))
                    }
                    is SharingPage.App -> state.apps.find { it.id == page.id }?.let { app ->
                        AppSharingScreen(state, app, actions.loadTracks, actions.pauseApp, actions.resumeApp, actions.disable, openApp,
                            showActivity = { sharingPage = SharingPage.Activity(app.id, page) }, back = { sharingPage = SharingPage.Dashboard })
                    } ?: LaunchedEffect(page) { sharingPage = SharingPage.Dashboard } // the app left /native/me
                    is SharingPage.Activity -> ActivityScreen(state, page.appId) { sharingPage = page.from }
                }
                Tab.CONTRIBUTE -> ContributeScreen(state, catalogue, actions, contributePage) { contributePage = it }
                Tab.SETTINGS -> SettingsScreen(state, actions.connect, actions.permissions, actions.disconnect, actions.privacy, actions.account,
                    actions.clearHistory, actions.open, actions.reconnect)
            }
        }
    }
    consent?.let { app -> AlertDialog(onDismissRequest = { askConsent(null) },
        title = { Text("Enable location for ${app.name}?") },
        text = { Text(app.disclosure) },
        confirmButton = { TextButton(onClick = { askConsent(null); actions.enable(app) }) { Text("Enable for ${app.name}") } },
        dismissButton = { TextButton(onClick = { askConsent(null) }) { Text("Cancel") } }) }
}

/** Where Open goes for a companion recipient: its catalogue URL when listed, else its default subdomain. */
internal fun companionAppUrl(app: ConnectedApp, catalogue: List<CatalogueApp>): String =
    Catalogue.installUrl(catalogue.find { it.id == app.id }?.appUrl ?: "https://${app.id}.freeappstore.online/")

/** Busy indicator and the last error, at the top of each tab. */
@Composable
internal fun StatusMessages(state: CompanionState) {
    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    if (state.message.isNotBlank()) Text(state.message, color = MaterialTheme.colorScheme.error)
}

internal const val DELETE_ACCOUNT_URL = "https://freeappstore.online/app/settings?delete-account=1"

/** Account, permissions, history and About. */
@Composable
private fun SettingsScreen(
    state: CompanionState, connect: () -> Unit, permissions: () -> Unit, disconnect: () -> Unit, privacy: () -> Unit, account: () -> Unit,
    clearHistory: () -> Unit, openUrl: (String) -> Unit, reconnect: () -> Unit,
) {
    var disconnectPrompt by remember { mutableStateOf(false) }
    var clearPrompt by remember { mutableStateOf(false) }
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(8.dp))
        Text("Settings", style = MaterialTheme.typography.headlineLarge)
        StatusMessages(state)
        if (state.expired) ExpiredCard(state, reconnect)
        if (state.signedIn || state.expired) {
            Text(state.name, style = MaterialTheme.typography.titleMedium)
            state.expiresInDays?.let { days ->
                Text("Connection renews when you reconnect — expires in $days day${if (days == 1) "" else "s"}", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = reconnect, enabled = !state.busy) { Text("Reconnect") }
            }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Labeled("Location permission", Format.permission[state.permission] ?: state.permission)
                    if (state.permission != "always") TextButton(onClick = permissions, enabled = !state.busy) { Text("Set up location") }
                    else Text("Precise location is set to “${state.backgroundOption}”.", style = MaterialTheme.typography.bodySmall)
                }
            }
            TextButton(onClick = account) { Text("Manage account") }
            // Play account deletion (#653): the console's delete flow, after sign-in on the web.
            TextButton(onClick = { openUrl(DELETE_ACCOUNT_URL) }) { Text("Delete account", color = MaterialTheme.colorScheme.error) }
            TextButton(onClick = { clearPrompt = true }) { Text("Clear sharing history") }
            TextButton(onClick = { disconnectPrompt = true }, enabled = !state.busy) { Text("Disconnect this phone") }
        } else Button(onClick = connect, enabled = !state.busy) { Text("Sign in to FreeAppStore") }
        Text("About", style = MaterialTheme.typography.titleLarge)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Labeled("Version", state.version)
                Labeled("Android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            }
        }
        TextButton(onClick = privacy) { Text("How your data is used") }
        TextButton(onClick = { openUrl("https://freeappstore.online/privacy") }) { Text("Privacy policy") }
        Spacer(Modifier.height(24.dp))
    }
    if (disconnectPrompt) AlertDialog(onDismissRequest = { disconnectPrompt = false },
        title = { Text("Disconnect this phone?") },
        text = { Text("Stops location sharing and deletes this phone’s pending updates, its sharing history and platform location copies. Saved runs in your apps are separate. An internet connection is needed to finish.") },
        confirmButton = { TextButton(onClick = { disconnectPrompt = false; disconnect() }) { Text("Disconnect") } },
        dismissButton = { TextButton(onClick = { disconnectPrompt = false }) { Text("Cancel") } })
    if (clearPrompt) AlertDialog(onDismissRequest = { clearPrompt = false },
        title = { Text("Clear sharing history?") },
        text = { Text("Deletes the sharing map, timeline and activity kept on this phone. Updates waiting to sync still upload.") },
        confirmButton = { TextButton(onClick = { clearPrompt = false; clearHistory() }) { Text("Clear history") } },
        dismissButton = { TextButton(onClick = { clearPrompt = false }) { Text("Cancel") } })
}
