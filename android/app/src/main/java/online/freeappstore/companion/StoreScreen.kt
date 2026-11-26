package online.freeappstore.companion

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The Store tab: featured, your companion apps, category rows, all apps and search, from the public catalogue.
 * Browse only, no WebView: Open hands `<appUrl>?install=1` to the browser, where the host offers Install (#621).
 */
@Composable
internal fun StoreScreen(state: CompanionState, catalogue: CatalogueState, actions: CompanionActions, askConsent: (ConnectedApp) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    val openApp = { app: CatalogueApp -> actions.open(Catalogue.installUrl(app.appUrl)) }
    val detail = selected?.let { id -> catalogue.apps.find { it.id == id } }
    if (detail != null) {
        BackHandler { selected = null }
        AppDetail(detail, state, actions, askConsent, openApp) { selected = null }
        return
    }
    val show = { app: CatalogueApp -> selected = app.id }
    LazyColumn(Modifier.fillMaxSize().testTag("store"), contentPadding = PaddingValues(vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Column(Modifier.padding(horizontal = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Store", style = MaterialTheme.typography.headlineLarge)
                OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text("Search apps") }, singleLine = true)
            }
        }
        when {
            catalogue.apps.isEmpty() -> item {
                Column(Modifier.fillMaxWidth().padding(top = 64.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (catalogue.loading) CircularProgressIndicator()
                    else {
                        Text("Connect to the internet to load the store", style = MaterialTheme.typography.titleMedium)
                        Button(onClick = actions.refreshCatalogue) { Text("Retry") }
                    }
                }
            }
            query.isNotBlank() -> {
                val found = Catalogue.sortedByName(Catalogue.search(catalogue.apps, query))
                if (found.isEmpty()) item { Text("No apps match “${query.trim()}”", Modifier.padding(horizontal = 24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                items(found, key = { "result-${it.id}" }) { AppRow(it, show, openApp) }
            }
            else -> {
                if (catalogue.stale) item {
                    Text("Showing the last copy of the store saved on this phone.", Modifier.padding(horizontal = 24.dp), style = MaterialTheme.typography.bodySmall)
                }
                item { Featured(Catalogue.featured(catalogue.apps), show) }
                val yours = catalogue.apps.filter { app -> state.apps.any { it.id == app.id && state.enabled(it) } }
                if (state.signedIn && yours.isNotEmpty()) item { CategoryRow("Yours", yours, show) }
                items(Catalogue.categories(catalogue.apps), key = { "category-${it.first}" }) { (name, apps) -> CategoryRow(name, apps, show) }
                item { Text("All apps", Modifier.padding(horizontal = 24.dp), style = MaterialTheme.typography.titleLarge) }
                items(Catalogue.sortedByName(catalogue.apps), key = { "all-${it.id}" }) { AppRow(it, show, openApp) }
            }
        }
    }
}

@Composable
private fun Featured(apps: List<CatalogueApp>, show: (CatalogueApp) -> Unit) {
    LazyRow(contentPadding = PaddingValues(horizontal = 24.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        items(apps, key = { it.id }) { app ->
            Column(Modifier.width(280.dp).height(200.dp).background(app.color, RoundedCornerShape(20.dp)).clickable { show(app) }.padding(20.dp)
                .semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.Bottom) {
                Text(app.icon, fontSize = with(LocalDensity.current) { 56.dp.toSp() })
                Text(app.name, color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(app.description, color = Color.White, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun CategoryRow(title: String, apps: List<CatalogueApp>, show: (CatalogueApp) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, Modifier.padding(horizontal = 24.dp), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        LazyRow(contentPadding = PaddingValues(horizontal = 24.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            items(apps, key = { it.id }) { app ->
                Column(Modifier.width(110.dp).clickable { show(app) }.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    AppIcon(app, 64.dp)
                    Text(app.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(app.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun AppRow(app: CatalogueApp, show: (CatalogueApp) -> Unit, open: (CatalogueApp) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.weight(1f).clickable { show(app) }.semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AppIcon(app, 48.dp)
            Column {
                Text(app.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(app.category, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        OutlinedButton(onClick = { open(app) }, Modifier.semantics { contentDescription = "Open ${app.name}" }) { Text("Open") }
    }
}

/** One app's page: icon, description, Open, Use with companion for apps on the native list, and permissions. */
@Composable
private fun AppDetail(
    app: CatalogueApp, state: CompanionState, actions: CompanionActions, askConsent: (ConnectedApp) -> Unit,
    open: (CatalogueApp) -> Unit, back: () -> Unit,
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        TextButton(onClick = back, contentPadding = PaddingValues(0.dp)) { Text("‹ Store") }
        Box(Modifier.fillMaxWidth().height(120.dp).background(app.color, RoundedCornerShape(16.dp)))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            AppIcon(app, 96.dp)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(app.name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(app.category, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                app.developer?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
        Button(onClick = { open(app) }, Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "Open ${app.name}" }) { Text("Open") }
        if (app.description.isNotEmpty()) Text(app.description)
        state.apps.find { it.id == app.id }?.let { connected -> CompanionCard(connected, state, actions, askConsent) }
        if (state.signedIn) Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ContributeSwitch(app.id, app.name, state, actions.contribute)
                Text("Generate ${app.name}'s published jobs, such as narration, on this phone. Nothing happens if it has none.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        app.permissions?.let { permissions ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Permissions", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                if (permissions.isEmpty()) Text("${app.name} doesn't ask for any permissions: no microphone, camera, location or device access.")
                permissions.forEach { p ->
                    Column(Modifier.semantics(mergeDescendants = true) {}) {
                        Text(Catalogue.permissionLabel(p.id), fontWeight = FontWeight.SemiBold)
                        if (p.reason.isNotEmpty()) Text(p.reason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/** Never grants directly: switching on opens the shared disclosure, and only its button enables. */
@Composable
private fun CompanionCard(connected: ConnectedApp, state: CompanionState, actions: CompanionActions, askConsent: (ConnectedApp) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (state.signedIn) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Use with companion", Modifier.weight(1f))
                    Switch(checked = state.enabled(connected), enabled = !state.busy,
                        onCheckedChange = { on -> if (on) askConsent(connected) else actions.disable(connected) })
                }
                if (connected.id in state.blocked) Text("Disabled on this phone. Server revocation will finish when connected.", style = MaterialTheme.typography.bodySmall)
            } else {
                Button(onClick = actions.connect, enabled = !state.busy) { Text("Sign in to use with FreeAppStore") }
            }
            Text("Background location: ${connected.purpose}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private val CatalogueApp.color get() = Color(Catalogue.argb(iconBg))

/** The app's emoji on its `iconBg`, as on the storefront. No image loading. */
@Composable
internal fun AppIcon(app: CatalogueApp, size: Dp) {
    Box(Modifier.size(size).background(app.color, RoundedCornerShape(size * 0.22f)).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
        Text(app.icon, fontSize = with(LocalDensity.current) { (size * 0.55f).toSp() })
    }
}
