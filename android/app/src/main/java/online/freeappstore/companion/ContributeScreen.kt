package online.freeappstore.companion

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** The voice model on this phone (#731). */
enum class ModelState { NONE, WAITING, INSTALLED }

/** What opting in means, shown before an app is turned on (#731). */
internal fun contributeDisclosure(name: String) =
    "This phone will take $name's open jobs, such as narrating a chapter, generate each one with an on-device voice model " +
        "and upload the result to FreeAppStore under your account. It only ever generates exactly what $name's publisher " +
        "asked for, never anything you type, and FreeAppStore checks every upload before anyone hears it. By default it " +
        "runs only while charging on Wi-Fi."

/** The labels of [Contribution.status]. */
internal val contributionLabels = mapOf(
    "uploading" to "Uploading", "pending" to "Being checked", "accepted" to "Accepted", "rejected" to "Rejected",
    "superseded" to "Not needed", "skipped" to "Skipped", "failed" to "Failed",
)

/** A per-app switch whose turning on asks first. */
@Composable
internal fun ContributeSwitch(appId: String, name: String, state: CompanionState, contribute: (String, Boolean) -> Unit) {
    var ask by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Contribute from this phone", Modifier.weight(1f))
        Switch(checked = appId in state.contributeApps, onCheckedChange = { on -> if (on) ask = true else contribute(appId, false) })
    }
    if (ask) ContributeDialog(name, { ask = false }) { ask = false; contribute(appId, true) }
}

@Composable
internal fun ContributeDialog(name: String, dismiss: () -> Unit, confirm: () -> Unit) = AlertDialog(onDismissRequest = dismiss,
    title = { Text("Contribute to $name?") },
    text = { Text(contributeDisclosure(name)) },
    confirmButton = { TextButton(onClick = confirm) { Text("Contribute") } },
    dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } })

/** The Contribute tab: voice model, when it runs, the apps opted in and recent results. */
@Composable
internal fun ContributeScreen(state: CompanionState, catalogue: CatalogueState, actions: CompanionActions) {
    val name = { id: String -> catalogue.apps.find { it.id == id }?.name ?: id }
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(8.dp))
        Text("Contribute", style = MaterialTheme.typography.headlineLarge)
        StatusMessages(state)
        Text("Help apps you use by generating their audio on this phone, such as narration for Books. Apps publish the jobs; your phone does the work while it charges.")
        if (!state.signedIn) {
            Button(onClick = actions.connect, enabled = !state.busy) { Text("Sign in to FreeAppStore") }
            return@Column
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Voice model", style = MaterialTheme.typography.titleLarge)
                Labeled("Kokoro ${KokoroModel.ID.version}", when (state.model) {
                    ModelState.INSTALLED -> "Installed · ${KokoroModel.INSTALLED_BYTES / 1_000_000} MB"
                    ModelState.WAITING -> "Downloading"
                    ModelState.NONE -> "${KokoroModel.DOWNLOAD_BYTES / 1_000_000} MB download"
                })
                when (state.model) {
                    ModelState.NONE -> Button(onClick = actions.downloadModel) { Text("Download (${KokoroModel.DOWNLOAD_BYTES / 1_000_000} MB)") }
                    ModelState.WAITING -> {
                        if (state.contributing == null) Text(if (state.contributeAnyTime) "Waits for a connection." else "Waits for Wi-Fi and charging.", style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = actions.deleteModel) { Text("Cancel download") }
                    }
                    ModelState.INSTALLED -> TextButton(onClick = actions.deleteModel) { Text("Delete model") }
                }
            }
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Only while charging on Wi-Fi", Modifier.weight(1f))
                    Switch(checked = !state.contributeAnyTime, onCheckedChange = { actions.contributeAnyTime(!it) })
                }
                Text(state.contributing ?: "Not running", style = MaterialTheme.typography.bodyMedium)
                Row {
                    TextButton(onClick = actions.contributeNow, enabled = state.contributing == null && state.contributeApps.isNotEmpty() && state.model == ModelState.INSTALLED) { Text("Run now") }
                    if (state.contributing != null) TextButton(onClick = actions.stopContributing) { Text("Stop") }
                }
            }
        }
        Text("Apps", style = MaterialTheme.typography.titleLarge)
        if (state.contributeApps.isEmpty()) Text("No apps yet. Turn on Contribute on an app's page in the Store, or from an app that asks for help.")
        state.contributeApps.sorted().forEach { id ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(name(id), style = MaterialTheme.typography.titleMedium)
                    Text("${state.contributedToday[id] ?: 0} today", style = MaterialTheme.typography.bodySmall)
                    ContributeSwitch(id, name(id), state, actions.contribute)
                }
            }
        }
        if (state.contributions.isNotEmpty()) {
            Text("Recent", style = MaterialTheme.typography.titleLarge)
            state.contributions.forEach { c ->
                Column(Modifier.fillMaxWidth()) {
                    Labeled("${name(c.appId)} · ${c.key}", contributionLabels[c.status] ?: c.status)
                    Text(Format.relative(c.at, state.now) + if (c.reason.isNotBlank()) " · ${c.reason}" else "",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}
