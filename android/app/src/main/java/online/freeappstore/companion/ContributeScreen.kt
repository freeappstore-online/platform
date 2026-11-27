package online.freeappstore.companion

import android.media.AudioAttributes
import android.media.MediaPlayer
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/** The voice model on this phone (#731). */
enum class ModelState { NONE, WAITING, INSTALLED }

/** What opting in means, shown before an app is turned on (#731). */
internal fun contributeDisclosure(name: String) =
    "This phone will take open jobs from $name, such as narrating a chapter, generate each one with an on-device voice " +
        "model and upload the result to FreeAppStore under your account. It only ever generates exactly what the publisher " +
        "of $name asked for, never anything you type, and FreeAppStore checks every upload before anyone hears it. By " +
        "default it runs only while plugged in on Wi‑Fi."

/** The labels of [Contribution.status]. */
internal val contributionLabels = mapOf(
    "generating" to "In progress", "uploading" to "Uploading", "pending" to "Being checked", "accepted" to "Accepted", "rejected" to "Rejected",
    "superseded" to "Not needed", "skipped" to "Skipped", "failed" to "Failed",
)

/**
 * The detail line of an Activity row (#806): the reason, and for a job that was skipped or failed whether this phone tries
 * it again: only an interrupted one, when the server offers it again (#841); never one that ended for good.
 */
internal fun contributionDetail(c: Contribution): String = listOfNotNull(c.reason.ifBlank { null }, retryText(c)).joinToString(" · ")
internal fun retryText(c: Contribution): String? = when {
    c.status != "skipped" && c.status != "failed" -> null
    Contribution.retryable(c.status, c.reason) -> "may be tried again"
    else -> "not retried on this phone"
}

/**
 * Activity's status filters (#820). Each status is under one: superseded ("Not needed") is Not done, and the job being
 * generated now is In progress (#835).
 */
internal enum class ContributionFilter(val label: String) {
    ALL("All"), IN_PROGRESS("In progress"), ACCEPTED("Accepted"), CHECKING("Checking"), REJECTED("Rejected"), NOT_DONE("Not done");
    fun matches(status: String) = this == ALL || of(status) == this
    companion object {
        fun of(status: String) = when (status) {
            "generating" -> IN_PROGRESS
            "accepted" -> ACCEPTED
            "uploading", "pending" -> CHECKING
            "rejected" -> REJECTED
            else -> NOT_DONE
        }
    }
}

/** The status card's headline and why (#820, #830): running, off, or why it is paused or waiting. */
internal fun contributeStatus(state: CompanionState): Pair<String, String> = when {
    state.contributing != null -> (if (state.contributeMode == "Run now") "Running (Run now)" else "Running") to state.contributing
    state.contributeSettings.off -> "Off" to ContributeConditions.OFF
    state.model == ModelState.NONE -> "Paused" to "No voice model. Download it in Settings."
    state.contributeApps.isEmpty() -> "Paused" to "No apps turned on. Choose them in Settings."
    state.contributeHold != null -> "Paused" to state.contributeHold.text
    state.model == ModelState.WAITING -> "Waiting" to "The voice model downloads on the next run."
    state.contributeLastEnd.startsWith("no_work") -> "Waiting" to "No jobs right now. It looks again about every hour."
    else -> "Waiting" to "It starts by itself while the conditions in Settings hold, and looks for jobs about every hour."
}

/** "1:05" for an audio length, "412 KB" or "1.2 MB" for a size (#820). */
internal fun audioLength(ms: Long): String = ((ms + 500) / 1000).let { "%d:%02d".format(Locale.ROOT, it / 60, it % 60) }
internal fun byteSize(bytes: Long): String =
    if (bytes >= 1_000_000) "%.1f MB".format(Locale.getDefault(), bytes / 1_000_000.0) else "${(bytes + 999) / 1000} KB"
internal fun openJobsText(n: Int) = when (n) { 0 -> "No open jobs"; 1 -> "1 open job"; else -> "$n open jobs" }

/** Where the user is inside the Contribute tab (#820). */
internal sealed class ContributePage {
    data object Status : ContributePage()
    data object Settings : ContributePage()
    data class Activity(val filter: ContributionFilter = ContributionFilter.ALL, val appId: String? = null) : ContributePage()
    data class Detail(val jobId: String, val from: Activity) : ContributePage()
    val back: ContributePage get() = if (this is Detail) from else Status
}

/** A per-app switch whose turning on asks first. */
@Composable
internal fun ContributeSwitch(appId: String, name: String, state: CompanionState, contribute: (String, Boolean) -> Unit,
                              label: String = "Contribute from this phone") {
    var ask by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f).padding(end = 12.dp))
        Switch(checked = appId in state.contributeApps, onCheckedChange = { on -> if (on) ask = true else contribute(appId, false) })
    }
    if (ask) ContributeDialog(name, { ask = false }) { ask = false; contribute(appId, true) }
}

@Composable
internal fun ContributeDialog(name: String, dismiss: () -> Unit, confirm: () -> Unit) = AlertDialog(onDismissRequest = dismiss,
    title = { Text("Contribute to $name?") },
    text = { Text(contributeDisclosure(name)) },
    confirmButton = { TextButton(onClick = confirm) { Text("Contribute to $name") } },
    dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } })

/** The Contribute tab (#820): the status, Activity with each job's detail, and Settings. */
@Composable
internal fun ContributeScreen(state: CompanionState, catalogue: CatalogueState, actions: CompanionActions, page: ContributePage, show: (ContributePage) -> Unit) {
    val name = { id: String -> catalogue.apps.find { it.id == id }?.name ?: id }
    when (page) {
        ContributePage.Status -> ContributeStatus(state, actions, show)
        ContributePage.Settings -> ContributeSettings(state, name, actions) { show(ContributePage.Status) }
        is ContributePage.Activity -> ContributeActivity(state, page, name, actions.refreshContributions, show)
        is ContributePage.Detail -> state.contributions.find { it.jobId == page.jobId }?.let { c ->
            ContributionDetail(c, name(c.appId), actions.loadPlayback, actions.keptAudio, actions.sendReport, actions.shareRecord) { show(page.from) }
        } ?: LaunchedEffect(page) { show(page.from) }
    }
}

/** One card: running, paused or idle and why, Run now / Stop; and today's results, each opening Activity filtered. */
@Composable
private fun ContributeStatus(state: CompanionState, actions: CompanionActions, show: (ContributePage) -> Unit) {
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Contribute", Modifier.weight(1f), style = MaterialTheme.typography.headlineLarge)
            if (state.signedIn) IconButton(onClick = { show(ContributePage.Settings) }) {
                Icon(painterResource(R.drawable.ic_settings), contentDescription = "Contribute settings")
            }
        }
        StatusMessages(state)
        Text("Help apps you use by generating their audio on this phone, such as narration for Books. Apps publish the jobs; your phone does the work while it's plugged in.")
        if (!state.signedIn) {
            Button(onClick = actions.connect, enabled = !state.busy) { Text("Sign in to FreeAppStore") }
            PairByCode(state.busy, actions.connectCode)
            return@Column
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ContributeModes(state, actions)
                val (headline, why) = contributeStatus(state)
                Text(headline, style = MaterialTheme.typography.titleLarge)
                Text(why, style = MaterialTheme.typography.bodyMedium)
                state.modelDownloaded?.let { LinearProgressIndicator({ it.toFloat() / KokoroModel.DOWNLOAD_BYTES }, Modifier.fillMaxWidth()) }
                if (state.contributing != null) TextButton(onClick = actions.stopContributing) { Text("Stop") }
            }
        }
        Text("Today", style = MaterialTheme.typography.titleLarge)
        val today = state.contributions.filter { it.at >= SharingTimeline.today(state.now).first }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ContributionFilter.entries.drop(1).forEach { f ->
                val n = today.count { f.matches(it.status) }
                AssistChip(onClick = { show(ContributePage.Activity(f)) }, label = { Text("$n ${f.label.lowercase()}") })
            }
        }
        Row(Modifier.fillMaxWidth().clickable { show(ContributePage.Activity()) }.padding(vertical = 8.dp)) {
            Text("Activity", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Text("›", style = MaterialTheme.typography.titleMedium)
        }
        Spacer(Modifier.height(24.dp))
    }
}

/**
 * Auto / Run now / Off (#830). Auto runs by itself while the conditions hold; Run now is one run ignoring them, then Auto;
 * Off stops the job in hand and every schedule until Auto or Run now is chosen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ContributeModes(state: CompanionState, actions: CompanionActions) {
    val off = state.contributeSettings.off
    val canRun = state.contributing == null && state.contributeApps.isNotEmpty() && state.model == ModelState.INSTALLED
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        SegmentedButton(!off && state.contributeMode != "Run now", { if (off) actions.contributeSettings(state.contributeSettings.copy(off = false)) },
            SegmentedButtonDefaults.itemShape(0, 3), icon = {}) { ModeLabel("Auto") }
        SegmentedButton(state.contributeMode == "Run now", { if (canRun) actions.contributeNow() }, SegmentedButtonDefaults.itemShape(1, 3),
            enabled = canRun || state.contributeMode == "Run now", icon = {}) { ModeLabel("Run now") }
        SegmentedButton(off, { if (!off) actions.contributeSettings(state.contributeSettings.copy(off = true)) },
            SegmentedButtonDefaults.itemShape(2, 3), icon = {}) { ModeLabel("Off") }
    }
}

/** One line at any font size, shrinking to fit (#806), like the tab labels. */
@Composable
private fun ModeLabel(text: String) = Text(text, maxLines = 1, softWrap = false,
    autoSize = TextAutoSize.StepBased(minFontSize = 8.sp, maxFontSize = LocalTextStyle.current.fontSize))

/** Every job this phone tried, newest first and by day, filtered by status and app; pull to refresh the verdicts. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ContributeActivity(state: CompanionState, page: ContributePage.Activity, name: (String) -> String,
                               refresh: suspend () -> Unit, show: (ContributePage) -> Unit) {
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val apps = state.contributions.map { it.appId }.distinct().sortedBy(name)
    val rows = state.contributions.filter { page.filter.matches(it.status) && (page.appId == null || it.appId == page.appId) }
    PullToRefreshBox(refreshing, { scope.launch { refreshing = true; try { refresh() } finally { refreshing = false } } }, Modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            BackRow("Contribute") { show(ContributePage.Status) }
            Text("Activity", style = MaterialTheme.typography.headlineMedium)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ContributionFilter.entries.forEach { f -> FilterChip(page.filter == f, { show(page.copy(filter = f)) }, { Text(f.label) }) }
            }
            if (apps.size > 1) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(page.appId == null, { show(page.copy(appId = null)) }, { Text("All apps") })
                apps.forEach { id -> FilterChip(page.appId == id, { show(page.copy(appId = id)) }, { Text(name(id)) }) }
            }
            if (rows.isEmpty()) Text("Nothing on this phone for this filter.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            rows.groupBy { Format.day(it.at) }.forEach { (day, list) ->
                Text(day, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                list.forEach { c ->
                    Column(Modifier.fillMaxWidth().clickable { show(ContributePage.Detail(c.jobId, page)) }.padding(vertical = 4.dp)) {
                        Labeled("${name(c.appId)} · ${c.key}", contributionLabels[c.status] ?: c.status)
                        Text(listOf(Format.time(c.at), contributionDetail(c)).filter { it.isNotBlank() }.joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/**
 * The attempt record's numbers for the job detail (#827), in reading order; fields it does not have are left out. Times
 * are wall time per stage, CPU the process CPU time over the attempt, real-time factor synthesis time over audio length.
 * While the job runs (#835) the record so far adds the model, the sentence being spoken and the lease's expiry.
 */
internal fun attemptLines(record: JSONObject): List<Pair<String, String>> {
    fun text(key: String) = if (record.has(key)) record.get(key).toString() else null
    fun ms(key: String) = if (record.has(key)) record.getLong(key).let { if (it < 1_000) "$it ms" else "%.1f s".format(Locale.ROOT, it / 1000.0) } else null
    fun device(at: String): String? {
        val battery = text("battery$at")?.let { "$it%" }
        val charging = if (record.has("charging$at")) if (record.getBoolean("charging$at")) "charging" else "on battery" else null
        return listOfNotNull(battery, charging, text("thermal$at")?.let { "thermal $it" }).joinToString(" · ").ifBlank { null }
    }
    val sentences = record.optInt("sentences")
    return listOf(
        "Model" to text("model"),
        "Progress" to if (sentences > 0) record.getInt("sentence").let { "Sentence $it of $sentences · ${(it - 1) * 100 / sentences}%" } else null,
        "Lease expires" to if (record.has("leaseExpiresAt")) Format.time(record.getLong("leaseExpiresAt")) else null,
        "Runner" to text("runner"), "App version" to text("appVersion"), "OS" to text("os"), "Device" to text("device"),
        "Network" to text("network"),
        "Ran" to if (record.has("background")) if (record.getBoolean("background")) "In the background at times" else "In the foreground" else null,
        "End reason" to text("reason"), "Error" to text("error"),
        "Wall time" to ms("wallMs"), "Model load" to ms("loadMs"), "Synthesis" to ms("synthMs"), "Encoding" to ms("encodeMs"),
        "Upload" to ms("uploadMs"), "CPU time" to ms("cpuMs"),
        "Real-time factor" to if (record.has("rtf")) "%.2f".format(Locale.ROOT, record.getDouble("rtf")) else null,
        "Peak memory" to text("peakMemMb")?.let { "$it MB" }, "At start" to device("Start"), "At end" to device("End"),
    ).mapNotNull { (label, value) -> value?.let { label to it } }
}

/**
 * One job: what it was, what happened to it (or while it runs, how far it is, #835: the screen refreshes every 2 s), how
 * the attempt went, its audio (kept on this phone, or once accepted) and,
 * for an upload, this phone's report on it (#831).
 */
@Composable
private fun ContributionDetail(c: Contribution, appName: String, loadPlayback: suspend (Contribution) -> Pair<String, List<Segment>>,
                               keptAudio: (Contribution) -> String?, sendReport: suspend (Contribution, Boolean, String) -> Unit,
                               shareRecord: (Contribution) -> Unit, back: () -> Unit) {
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        BackRow("Activity", back)
        Text(appName, style = MaterialTheme.typography.headlineMedium)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Labeled("Job", c.key)
                Labeled("Status", contributionLabels[c.status] ?: c.status)
                Labeled("When", Format.dateTime(c.at))
                c.durationMs?.let { Labeled("Length", audioLength(it)) }
                c.bytes?.let { Labeled("Size", byteSize(it)) }
                val onPhone = c.status == "skipped" || c.status == "failed"
                if (c.reason.isNotBlank()) Labeled(if (onPhone) "Reason on this phone" else "Server's reason", c.reason)
                retryText(c)?.let { Text(it.replaceFirstChar(Char::uppercase) + ".", style = MaterialTheme.typography.bodySmall) }
            }
        }
        c.record?.let { runCatching { attemptLines(JSONObject(it)) }.getOrNull() }?.takeIf { it.isNotEmpty() }?.let { lines ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("On this phone", style = MaterialTheme.typography.titleLarge)
                    lines.forEach { (label, value) -> Labeled(label, value) }
                }
            }
        }
        val url = remember(c.jobId, c.status) { keptAudio(c) } ?: c.artifactUrl?.takeIf { c.status == "accepted" }
        if (url != null) Playback(c, url, loadPlayback)
        else if (c.inputPreview.isNotBlank()) InputText(c.inputPreview, null)
        if (c.submissionId != null) ReportCard(c, sendReport)
        // The full record as JSON with the audio (#843), for a bug report.
        OutlinedButton(onClick = { shareRecord(c) }) { Text("Share record") }
        Spacer(Modifier.height(24.dp))
    }
}

/** Good / Not good on this phone's own upload, with an optional note (#831): people judge quality. Sending again changes it. */
@Composable
private fun ReportCard(c: Contribution, send: suspend (Contribution, Boolean, String) -> Unit) {
    var good by remember(c.jobId) { mutableStateOf(c.report?.good) }
    var note by remember(c.jobId) { mutableStateOf(c.report?.note.orEmpty()) }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Your report", style = MaterialTheme.typography.titleLarge)
            Text("Listen, then say whether it was good. The app's owner sees your report.", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(good == true, { good = true }, { Text("Good") })
                FilterChip(good == false, { good = false }, { Text("Not good") })
            }
            OutlinedTextField(note, { note = it.take(Report.NOTE_CHARS) }, Modifier.fillMaxWidth(), label = { Text("Note (optional)") },
                supportingText = { Text("${note.length}/${Report.NOTE_CHARS}") })
            Button(onClick = {
                val g = good ?: return@Button
                scope.launch {
                    sending = true; error = ""
                    try { send(c, g, note) } catch (e: Exception) { error = e.message ?: "Could not send it." } finally { sending = false }
                }
            }, enabled = good != null && !sending) { Text(if (c.report == null) "Send" else "Change") }
            c.report?.let {
                Text("Sent ${Format.dateTime(it.at)}: ${if (it.good) "Good" else "Not good"}", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        }
    }
}

/** The input (the stored preview, or the whole text), with [highlight] (a sentence's characters) marked where it falls inside it. */
@Composable
private fun InputText(text: String, highlight: IntRange?) {
    val more = if (text.length == Contribution.PREVIEW) "…" else ""
    val mark = MaterialTheme.colorScheme.primary.copy(alpha = 0.25f)
    Text(buildAnnotatedString {
        val range = highlight?.let { it.first.coerceIn(0, text.length)..it.last.coerceIn(-1, text.length - 1) }
        if (range == null || range.isEmpty()) append(text) else {
            append(text.substring(0, range.first))
            withStyle(SpanStyle(background = mark)) { append(text.substring(range.first, range.last + 1)) }
            append(text.substring(range.last + 1))
        }
        append(more)
    }, style = MaterialTheme.typography.bodyLarge)
}

/** Plays [url] (this phone's kept file, or the public artifact), highlighting the sentence being spoken in the whole input from its `meta` timings. */
@Composable
private fun Playback(c: Contribution, url: String, loadPlayback: suspend (Contribution) -> Pair<String, List<Segment>>) {
    val player = remember(c.jobId) { MediaPlayer() }
    var phase by remember { mutableStateOf("idle") } // idle, loading, playing, paused, error
    var position by remember { mutableLongStateOf(-1L) }
    var text by remember { mutableStateOf(c.inputPreview) }
    var segments by remember { mutableStateOf(emptyList<Segment>()) }
    DisposableEffect(player) { onDispose { player.release() } }
    LaunchedEffect(c.jobId) { loadPlayback(c).let { text = it.first; segments = it.second } }
    LaunchedEffect(phase) { while (phase == "playing") { position = player.currentPosition.toLong(); delay(100) } }
    val current = segments.indexOfFirst { position >= it.startMs && position < it.endMs }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Button(onClick = {
            when (phase) {
                "playing" -> { player.pause(); phase = "paused" }
                "paused" -> { player.start(); phase = "playing" }
                "loading" -> {}
                else -> {
                    player.reset()
                    player.setAudioAttributes(AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    player.setOnPreparedListener { it.start(); phase = "playing" }
                    player.setOnCompletionListener { phase = "paused"; position = -1 }
                    player.setOnErrorListener { _, _, _ -> phase = "error"; true }
                    player.setDataSource(url)
                    player.prepareAsync(); phase = "loading"
                }
            }
        }, enabled = phase != "loading") { Text(if (phase == "playing") "Pause" else "Play") }
        Text(when {
            phase == "loading" -> "Loading…"
            phase == "error" -> "Could not play it."
            current >= 0 -> "Sentence ${current + 1} of ${segments.size}"
            else -> ""
        }, style = MaterialTheme.typography.bodyMedium)
    }
    if (text.isNotBlank()) InputText(text, segments.getOrNull(current)?.let { it.start until it.end })
}

/** The apps (opted in, or with open jobs for this phone), the voice model, when it runs and the storage it uses. */
@Composable
private fun ContributeSettings(state: CompanionState, name: (String) -> String, actions: CompanionActions, back: () -> Unit) {
    var open by remember { mutableStateOf<Map<String, Int>?>(null) }
    var storage by remember { mutableStateOf<Pair<Long, Long>?>(null) }
    LaunchedEffect(Unit) { open = actions.openJobs() }
    LaunchedEffect(state.model) { storage = actions.contributeStorage() }
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        BackRow("Contribute", back)
        Text("Contribute settings", style = MaterialTheme.typography.headlineMedium)
        StatusMessages(state)
        Text("Apps", style = MaterialTheme.typography.titleLarge)
        val ids = (state.contributeApps + open.orEmpty().filterValues { it > 0 }.keys).sortedBy(name)
        if (ids.isEmpty()) Text("No apps yet. Turn on Contribute on an app's page in the Store, or from an app that asks for help.")
        ids.forEach { id ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ContributeSwitch(id, name(id), state, actions.contribute, label = name(id))
                    val detail = listOfNotNull(open?.let { openJobsText(it[id] ?: 0) }, state.contributedToday[id]?.let { "$it today" })
                    if (detail.isNotEmpty()) Text(detail.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Voice model", style = MaterialTheme.typography.titleLarge)
                Labeled("Kokoro ${KokoroModel.ID.version}", when (state.model) {
                    ModelState.INSTALLED -> "Installed · ${KokoroModel.INSTALLED_BYTES / 1_000_000} MB"
                    ModelState.WAITING -> state.modelDownloaded?.let { "Downloading · ${KokoroModel.progress(it)}" } ?: "Waiting to download"
                    ModelState.NONE -> "${KokoroModel.DOWNLOAD_BYTES / 1_000_000} MB download"
                })
                when (state.model) {
                    ModelState.NONE -> Button(onClick = actions.downloadModel) { Text("Download (${KokoroModel.DOWNLOAD_BYTES / 1_000_000} MB)") }
                    ModelState.WAITING -> {
                        state.modelDownloaded?.let { LinearProgressIndicator({ it.toFloat() / KokoroModel.DOWNLOAD_BYTES }, Modifier.fillMaxWidth()) }
                        if (state.contributing == null) Text(if (state.contributeSettings.mobileData) "Waits for a connection, within the mobile data allowance." else "Waits for Wi‑Fi.", style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = actions.deleteModel) { Text("Cancel download") }
                    }
                    ModelState.INSTALLED -> TextButton(onClick = actions.deleteModel) { Text("Delete model") }
                }
            }
        }
        WhenItRuns(state.contributeSettings, state.mobileBytes, actions.contributeSettings)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Storage used", style = MaterialTheme.typography.titleLarge)
                Labeled("Voice model", storage?.let { byteSize(it.first) } ?: "…")
                Labeled("Activity record", storage?.let { byteSize(it.second) } ?: "…")
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

/** When Contribute runs (#830), each condition with its default, and the overnight summary (#844). All on this phone. */
@Composable
private fun WhenItRuns(s: ContributeSettings, mobileBytes: Long, set: (ContributeSettings) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("When it runs", style = MaterialTheme.typography.titleLarge)
            Text("On Auto it runs by itself while all of these hold, pauses when one fails and resumes by itself.", style = MaterialTheme.typography.bodySmall)
            Choice("Connection", listOf("Wi‑Fi only" to false, "Wi‑Fi + mobile data" to true), s.mobileData) { set(s.copy(mobileData = it)) }
            if (s.mobileData) Stepper("Mobile data a month", "${s.mobileCapMb} MB · ${mobileBytes / 1_000_000} MB used",
                { set(s.copy(mobileCapMb = (s.mobileCapMb - 100).coerceAtLeast(100))) }, { set(s.copy(mobileCapMb = s.mobileCapMb + 100)) })
            Choice("Power", listOf("Charging only" to false, "Also on battery" to true), s.onBattery) { set(s.copy(onBattery = it)) }
            if (s.onBattery) Stepper("Minimum battery", "${s.minBattery}%",
                { set(s.copy(minBattery = (s.minBattery - 10).coerceAtLeast(10))) }, { set(s.copy(minBattery = (s.minBattery + 10).coerceAtMost(90))) })
            Toggle("Pause when the phone is hot", s.thermalPause) { set(s.copy(thermalPause = it)) }
            Choice("While the phone is in use", listOf("Pause" to false, "Run slower" to true), s.slowerInUse) { set(s.copy(slowerInUse = it)) }
            Choice("CPU", ContributeSettings.Cpu.entries.map { it.label to it }, s.cpu) { set(s.copy(cpu = it)) }
            Text(when (s.cpu) {
                ContributeSettings.Cpu.LIGHT -> "One core, resting as long as each sentence took."
                ContributeSettings.Cpu.BALANCED -> "Two cores, with short rests between sentences."
                ContributeSettings.Cpu.FULL -> "Up to four cores, no rests."
            }, style = MaterialTheme.typography.bodySmall)
            Stepper("Daily maximum, jobs", if (s.dailyJobs == 0) "No maximum" else "${s.dailyJobs}",
                { set(s.copy(dailyJobs = (s.dailyJobs - 10).coerceAtLeast(0))) }, { set(s.copy(dailyJobs = s.dailyJobs + 10)) })
            Stepper("Daily maximum, time", if (s.dailyMinutes == 0) "No maximum" else "${s.dailyMinutes} min",
                { set(s.copy(dailyMinutes = (s.dailyMinutes - 30).coerceAtLeast(0))) }, { set(s.copy(dailyMinutes = s.dailyMinutes + 30)) })
            Toggle("Quiet hours", s.quietHours) { set(s.copy(quietHours = it)) }
            if (s.quietHours) {
                val hour = { m: Int, d: Int -> Math.floorMod(m + d * 60, 24 * 60) }
                Stepper("From", ContributeConditions.clock(s.quietFrom), { set(s.copy(quietFrom = hour(s.quietFrom, -1))) }, { set(s.copy(quietFrom = hour(s.quietFrom, 1))) })
                Stepper("To", ContributeConditions.clock(s.quietTo), { set(s.copy(quietTo = hour(s.quietTo, -1))) }, { set(s.copy(quietTo = hour(s.quietTo, 1))) })
            }
            Toggle("Overnight summary", s.summary) { set(s.copy(summary = it)) }
            Text("One quiet notification after background work, once a morning or after a long run.", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun <T> Choice(label: String, options: List<Pair<String, T>>, selected: T, pick: (T) -> Unit) {
    Text(label, style = MaterialTheme.typography.titleSmall)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (text, value) -> FilterChip(selected == value, { pick(value) }, { Text(text) }) }
    }
}

@Composable
private fun Toggle(label: String, on: Boolean, set: (Boolean) -> Unit) = Row(verticalAlignment = Alignment.CenterVertically) {
    Text(label, Modifier.weight(1f).padding(end = 12.dp))
    Switch(checked = on, onCheckedChange = set)
}

/** The label on its own line, so it never shares the width with the buttons at large font sizes (#806). */
@Composable
private fun Stepper(label: String, value: String, less: () -> Unit, more: () -> Unit) = Column {
    Text(label)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = less) { Text("−") }
        TextButton(onClick = more) { Text("+") }
    }
}
