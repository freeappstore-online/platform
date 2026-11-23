package online.freeappstore.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
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
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*

data class CompanionState(
    val signedIn: Boolean = false, val name: String = "", val apps: List<ConnectedApp> = emptyList(),
    val blocked: Set<String> = emptySet(), val paused: Boolean = true, val running: Boolean = false,
    val permissions: Boolean = false, val queued: Int = 0, val message: String = "", val busy: Boolean = false,
    val pairingCode: String = "", val lastSync: Long = 0, val pausedApps: Set<String> = emptySet(),
) {
    fun enabled(app: ConnectedApp) = app.grantId != null && app.id !in blocked
}

data class CatalogueState(val apps: List<CatalogueApp> = emptyList(), val stale: Boolean = false, val loading: Boolean = false)

/** Everything the screens can ask for. Defaults are no-ops so tests pass only what they check. */
data class CompanionActions(
    val connect: () -> Unit = {}, val enable: (ConnectedApp) -> Unit = {}, val disable: (ConnectedApp) -> Unit = {},
    val pauseApp: (ConnectedApp) -> Unit = {}, val resumeApp: (ConnectedApp) -> Unit = {},
    val pause: () -> Unit = {}, val resume: () -> Unit = {}, val permissions: () -> Unit = {}, val sync: () -> Unit = {},
    val disconnect: () -> Unit = {}, val privacy: () -> Unit = {}, val account: () -> Unit = {},
    /** Opens a URL in the browser. Open buttons pass `?install=1` URLs (#621). */
    val open: (String) -> Unit = {}, val refreshCatalogue: () -> Unit = {},
)

class MainActivity : ComponentActivity() {
    private val graph get() = application as FasApplication
    private var state by mutableStateOf(CompanionState())
    private var catalogue by mutableStateOf(CatalogueState())
    private var consent by mutableStateOf<ConnectedApp?>(null)
    private var error by mutableStateOf("")
    private var working by mutableStateOf(false)
    private var permissionExplanation by mutableStateOf(false)
    private var linkedApp: String? = null
    private var refreshJob: Job? = null
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh(); maybeStart() }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        if (savedInstanceState == null) handleLink(intent)
        catalogue = CatalogueState(graph.catalogue.apps)
        refresh()
        val actions = CompanionActions(
            connect = { act { open(graph.repository.startSignIn()) } },
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
        )
        // Sharing first when any app already shares, otherwise the Store.
        val startOnStore = state.apps.none(state::enabled)
        setContent {
            val colors = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFF60A5FA)) else lightColorScheme(primary = Color(0xFF2563EB))
            MaterialTheme(colorScheme = colors) {
                FasScreen(state.copy(busy = working, message = error.ifBlank { state.message }), catalogue, actions,
                    consent, { consent = it }, startOnStore)
                if (permissionExplanation) AlertDialog(onDismissRequest = { permissionExplanation = false },
                    title = { Text("Allow background location") },
                    text = { Text("FreeAppStore collects precise location to automatically record routes for apps you enable, even when FreeAppStore and those apps are closed. Updates go to FreeAppStore and only your enabled apps. Choose Precise location, then Allow all the time on the next settings screen. You can pause or revoke access here.") },
                    confirmButton = { TextButton(onClick = { permissionExplanation = false; requestLocation() }) { Text("Continue") } },
                    dismissButton = { TextButton(onClick = { permissionExplanation = false }) { Text("Not now") } })
            }
        }
    }
    override fun onResume() {
        super.onResume()
        refresh(); maybeStart(); refreshCatalogue()
        refreshJob?.cancel()
        refreshJob = lifecycleScope.launch {
            try { graph.repository.finishSignIn(); if (graph.repository.token() != null) graph.repository.sync() }
            catch (e: Exception) { if (e !is CancellationException) error = e.message ?: "Could not connect." else throw e }
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
    }
    private fun showLinkedDisclosure() {
        val id = linkedApp ?: return
        linkedApp = null
        state.apps.find { it.id == id && !state.enabled(it) }?.let { consent = it }
    }
    private fun refresh() {
        state = CompanionState(graph.repository.token() != null, graph.local.userName, graph.local.apps(), graph.local.blocked(),
            graph.local.paused, LocationService.running, LocationService.allowed(this), graph.local.count(), graph.local.message,
            pairingCode = graph.repository.pairingCode(), lastSync = graph.local.lastSync, pausedApps = graph.local.pausedApps())
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
            try { action() } catch (e: Exception) { if (e is CancellationException) throw e; error = e.message ?: "Please try again." }
            finally { working = false; refresh() }
        }
    }
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
    private fun open(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: RuntimeException) { error = "No browser is available to open $url." }
    }
}

/**
 * The tab shell: Store and Sharing. The disclosure dialog and disconnect prompt live here, so a deep link or the
 * Store's "Use with companion" shows the same disclosure from either tab, and only its button enables.
 */
@Composable
internal fun FasScreen(
    state: CompanionState, catalogue: CatalogueState, actions: CompanionActions,
    consent: ConnectedApp?, askConsent: (ConnectedApp?) -> Unit, startOnStore: Boolean = true,
) {
    var storeTab by rememberSaveable { mutableStateOf(startOnStore) }
    Scaffold(bottomBar = {
        NavigationBar {
            NavigationBarItem(selected = storeTab, onClick = { storeTab = true },
                icon = { Icon(painterResource(R.drawable.ic_store), contentDescription = null) }, label = { Text("Store") })
            NavigationBarItem(selected = !storeTab, onClick = { storeTab = false },
                icon = { Icon(painterResource(R.drawable.ic_location), contentDescription = null) }, label = { Text("Sharing") })
        }
    }) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            if (storeTab) StoreScreen(state, catalogue, actions, askConsent)
            else CompanionScreen(state, actions, askConsent, catalogue.apps)
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

@Composable
internal fun CompanionScreen(state: CompanionState, actions: CompanionActions, askConsent: (ConnectedApp) -> Unit, catalogue: List<CatalogueApp> = emptyList()) {
    var disconnectPrompt by remember { mutableStateOf(false) }
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(8.dp))
        Text("FreeAppStore", style = MaterialTheme.typography.headlineLarge)
        Text("Your apps, connected to your phone", style = MaterialTheme.typography.bodyLarge)
        if (!state.signedIn) {
            Text("Enable background features for the FAS apps you use. You stay in control of what each app can access.")
            Button(onClick = actions.connect, enabled = !state.busy) { Text("Sign in to FreeAppStore") }
            if (state.pairingCode.isNotBlank()) Text("Match this code in your browser: ${state.pairingCode}")
        } else {
            Text(state.name, style = MaterialTheme.typography.titleMedium)
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val enabledApps = state.apps.filter(state::enabled)
                    Text(when { state.paused -> "Location paused"; enabledApps.isNotEmpty() && enabledApps.all { it.id in state.pausedApps } -> "All apps paused"; !state.permissions -> "Location permission needed"; state.running -> "Location sharing is on"; else -> "Location is not running" }, style = MaterialTheme.typography.titleLarge)
                    if (!state.permissions) Button(onClick = actions.permissions, enabled = !state.busy) { Text("Set up location") }
                    else if (state.paused) Button(onClick = actions.resume, enabled = !state.busy && state.apps.any(state::enabled)) { Text("Resume location") }
                    else OutlinedButton(onClick = actions.pause) { Text("Pause all") }
                    Text("${state.queued} updates waiting to sync", style = MaterialTheme.typography.bodyMedium)
                    if (state.lastSync > 0) Text("Last sync: ${java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(state.lastSync))}", style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = actions.sync, enabled = !state.busy) { Text("Sync now") }
                }
            }
            Text("App permissions", style = MaterialTheme.typography.titleLarge)
            if (state.apps.isEmpty()) Text("No supported native features are available for your apps yet.")
            state.apps.forEach { app ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(app.name, style = MaterialTheme.typography.titleMedium)
                        Text("Background location", style = MaterialTheme.typography.bodyMedium)
                        val enabled = state.enabled(app)
                        val appPaused = app.id in state.pausedApps
                        Text(if (!enabled) "Off" else if (appPaused) "Paused" else "Sharing", color = MaterialTheme.colorScheme.primary)
                        if (app.id in state.blocked) Text("Disabled on this phone. Server revocation will finish when connected.", style = MaterialTheme.typography.bodySmall)
                        Row {
                            if (enabled) {
                                if (appPaused) TextButton(onClick = { actions.resumeApp(app) }, enabled = !state.paused) { Text("Resume") }
                                else TextButton(onClick = { actions.pauseApp(app) }) { Text("Pause") }
                            }
                            TextButton(onClick = { if (enabled) actions.disable(app) else askConsent(app) }, enabled = !state.busy) { Text(if (enabled) "Disable" else "Enable") }
                        }
                        TextButton(onClick = { actions.open(companionAppUrl(app, catalogue)) }) { Text("Open ${app.name}") }
                        if (state.paused && enabled && appPaused) Text("All sharing is paused. Resume location to continue.", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            TextButton(onClick = actions.account) { Text("Manage account") }
            TextButton(onClick = { disconnectPrompt = true }, enabled = !state.busy) { Text("Disconnect this phone") }
        }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (state.message.isNotBlank()) Text(state.message, color = MaterialTheme.colorScheme.error)
        TextButton(onClick = actions.privacy) { Text("How your data is used") }
        Spacer(Modifier.height(24.dp))
    }
    if (disconnectPrompt) AlertDialog(onDismissRequest = { disconnectPrompt = false },
        title = { Text("Disconnect this phone?") },
        text = { Text("Stops location sharing and deletes this phone’s pending updates and platform location copies. Saved runs in your apps are separate. An internet connection is needed to finish.") },
        confirmButton = { TextButton(onClick = { disconnectPrompt = false; actions.disconnect() }) { Text("Disconnect") } },
        dismissButton = { TextButton(onClick = { disconnectPrompt = false }) { Text("Cancel") } })
}
