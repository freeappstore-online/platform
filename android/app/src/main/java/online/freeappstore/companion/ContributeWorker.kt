package online.freeappstore.companion

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.*
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Contribute (#731): downloads the voice model when asked, then takes open jobs from the opted-in apps in turn. Runs as
 * WorkManager work with a foreground notification. Its Stop action cancels the work until FreeAppStore is opened again;
 * Stop in the app ends only the current run, and Off (#830) cancels every schedule until it is turned on again.
 *
 * When it runs is the user's [ContributeSettings] (#830), checked by [ContributeConditions.hold] on the phone itself
 * rather than through WorkManager constraints, which stop running work, foreground or not, the moment one lapses (#806):
 * Android's charging constraint goes unsatisfied once the battery is full, and a change to a metered network stopped a
 * job part-way. The conditions are checked before starting, before each claim and between sentences (at most once a
 * second). When one fails, a job at least [ContributeConditions.NEARLY_DONE] through is finished; otherwise it stops, and
 * its attempt record says why ([Hold.reason]: `unplugged`, `thermal`, `network`, `user_stop`), which gives the job back
 * on the server (#841). Run now ignores the conditions for one run. The one network constraint is "connected" (#828):
 * Android 17 blocks the network of an app in the background (`blocked=APP_BACKGROUND`) except for a job that asked for
 * one, so without it every background run found no network and ended at once.
 *
 * Android may refuse the foreground service to work started from the background (#828). The run then goes on as a plain
 * job, which the system stops after about ten minutes (on the Pixel 10a, Android 17, the refusal is
 * `ForegroundServiceStartNotAllowedException`), so it claims only within [ContributeWorker.PLAIN_CLAIM_MS] of its start and
 * ends itself at [ContributeWorker.PLAIN_RUN_MS], before the system times it out; the job in hand is then recorded
 * `stopped` (`background_expired`) and its lease lapses. The server refuses a claim once the app's daily generation
 * budget is used up or the user holds 4 open leases (`429`); the run then ends until the next one. Each run logs how it
 * ended.
 *
 * On power (#836) it does not wait for the hourly work: a one-time work with a charging constraint ([arm]) starts a run
 * as soon as the phone is plugged in. It only queues the run, so the constraint never stops a run part-way. A run that
 * ends at its time limit still plugged in and able to claim queues the next one at once (JobScheduler's quotas do not
 * apply while charging); one held by the phone being in use or hot looks again in [SOON_MINUTES]; one that ends for any
 * other reason (no jobs, a Stop) re-arms the trigger, an hour later while still plugged in so it never spins, and the
 * hourly work stays as the fallback.
 */
class ContributeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val graph = applicationContext as FasApplication
        val local = graph.local
        if (local.contributeSettings.off) return@withContext Result.success() // Off (#830): nothing starts, nothing is re-armed
        if (inputData.getBoolean(TRIGGER, false)) {
            // Android's "charging" and EXTRA_PLUGGED can disagree for a moment; never a loop of trigger and run over it.
            if (plugged() == 0) { Log.i(TAG, "Charging but not plugged in: trigger again in an hour"); arm(applicationContext, ExistingWorkPolicy.REPLACE, delayed = true) }
            else { Log.i(TAG, "Plugged in: queueing a run"); queueRun(applicationContext, ExistingWorkPolicy.KEEP) }
            return@withContext Result.success()
        }
        if (graph.repository.token() == null || !lock.tryLock()) {
            Log.i(TAG, "Run ended: " + if (lock.isLocked) "already_running" else "not_connected")
            return@withContext Result.success()
        }
        stopRequested = false
        // Run now (#830): this one run ignores the conditions, then Contribute is back on Auto.
        val runNow = inputData.getBoolean(RUN_NOW, false)
        running = if (runNow) "Run now" else "Auto"
        // No other run is live (the lock), so a job still `generating` was left by a run that was killed (#835).
        local.closeInterrupted().takeIf { it > 0 }?.let { Log.i(TAG, "Closed $it interrupted job(s)") }
        val started = SystemClock.elapsedRealtime()
        var settings = local.contributeSettings
        var device = contributeDevice(applicationContext, local)
        var checkedAt = -1_000L
        /** The condition that failed (#830), or null; never set for Run now. */
        var hold: Hold? = null
        /** How far the job in hand is (0 to 1), so one nearly done finishes when a condition fails. */
        var done = 0.0
        var foreground = false
        var end = "no_work"
        // A sticky-broadcast read and the settings at most once a second: this runs per downloaded buffer and per chunk.
        val recheck = { claiming: Boolean ->
            val t = SystemClock.elapsedRealtime()
            if (claiming || t - checkedAt >= 1_000) {
                checkedAt = t; settings = local.contributeSettings; device = contributeDevice(applicationContext, local, t - started)
                hold = if (runNow) null else ContributeConditions.hold(settings, device, claiming)
            }
        }
        val keepGoing = {
            recheck(false)
            !isStopped && !stopRequested && (hold == null || ContributeConditions.finishes(done)) &&
                (foreground || SystemClock.elapsedRealtime() - started < PLAIN_RUN_MS)
        }
        val mayClaim = {
            recheck(true)
            hold == null && (!runNow || device.connected) && withinBudget(foreground, SystemClock.elapsedRealtime() - started)
        }
        /** Why keepGoing is false, for the log line. */
        val stopped = { if (isStopped) "system_stop" else if (stopRequested) "user_stop" else hold?.code ?: "time_budget" }
        /** Counts [bytes] against the month's mobile data when the phone is on a metered network now. */
        val count = { bytes: Long -> if (bytes > 0 && !contributeDevice(applicationContext, local).unmetered) local.addMobileBytes(bytes) }
        try {
            if (!keepGoing()) { end = stopped(); return@withContext Result.success() } // the next run tries again
            if (!mayClaim()) { end = hold?.code ?: "offline"; return@withContext Result.success() }
            if (local.modelWanted && !graph.kokoro.installed) {
                if (!runNow && !ContributeConditions.modelFits(settings, device)) { end = "model_waits_for_wifi"; return@withContext Result.success() }
                downloaded = 0
                var counted = 0L
                foreground = show("Downloading the voice model")
                graph.kokoro.install(progress = {
                    downloaded = it; status = "Downloading the voice model · ${KokoroModel.progress(it)}"
                    count(it - counted); counted = it
                }, keepGoing = keepGoing)
            }
            Log.i(TAG, "Capabilities: ${runCatching { capabilityReport(applicationContext, graph.kokoro, settings.cpu) }.getOrElse { "unreadable: $it" }}")
            if (!graph.kokoro.installed) { end = "no_model"; return@withContext Result.success() }
            if (local.contributeApps().isEmpty()) { end = "no_apps"; return@withContext Result.success() }
            foreground = show("Looking for jobs")
            KokoroSynthesizer(graph.kokoro, settings.cpu.threads).use { synth ->
                // Why keepGoing turned false, for the attempt record (#827): the notification's Stop cancels the work.
                val whyStopped = {
                    stopReason(cancelled = stopRequested || isStopped && Build.VERSION.SDK_INT >= 31 && stopReason == WorkInfo.STOP_REASON_CANCELLED_BY_APP,
                        systemStop = isStopped, hold = hold, outOfTime = !foreground && SystemClock.elapsedRealtime() - started >= PLAIN_RUN_MS)
                }
                val contributor = Contributor(graph.generation, local, synth, ::AacEncoder, applicationContext.cacheDir,
                    probes = androidProbes(applicationContext, whyStopped), kept = graph.kept,
                    rest = { ContributeConditions.restMs(it, settings.cpu, slower = !runNow && settings.slowerInUse && device.inUse) },
                    uploading = { done = 1.0; count(it) })
                for (app in local.contributeApps()) {
                    if (!keepGoing()) break
                    runCatching { contributor.refresh(app, keepGoing) }.onFailure {
                        if (DeviceConnection.expired(it)) throw it
                        Log.w(TAG, "Verdicts for $app not refreshed", it) // the run goes on; Activity refreshes them again
                    }
                }
                // One job from each app in turn (#819), not one app drained before the next.
                var job = ""
                var jobStarted = 0L
                val submitted = contributor.run(local::contributeApps, keepGoing, mayClaim = mayClaim, progress = { app, claimed ->
                    job = "Generating ${graph.catalogue.apps.find { it.id == app }?.name ?: app} · ${claimed.key}"
                    jobStarted = SystemClock.elapsedRealtime(); status = job; done = 0.0
                }, sentence = { n, total, seconds ->
                    done = (n - 1).toDouble() / total
                    status = contributeProgress(job, n, total, seconds, (SystemClock.elapsedRealtime() - jobStarted) / 1000.0)
                })
                end = when {
                    !keepGoing() -> stopped()
                    !mayClaim() -> hold?.code ?: if (runNow && !device.connected) "offline" else "time_budget"
                    else -> "no_work"
                } + " · $submitted submitted"
            }
            Result.success()
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) { end = "system_stop"; throw e }
            end = ((e as? ApiFailure)?.let { "${it.status} " } ?: "") + (e.message ?: e.javaClass.simpleName)
            // An expired connection stops (the next sync says so); the daily limit waits for the next run.
            if (DeviceConnection.expired(e) || (e as? ApiFailure)?.status == 429) Result.success() else Result.retry()
        } finally {
            // Android stops work whose constraints lapse (a network change) unless it is in the foreground, and ends a
            // dataSync foreground service after its daily limit (Android 15+); either way keepGoing turned false above.
            val stop = if (isStopped && Build.VERSION.SDK_INT >= 31) ", system stop reason $stopReason" else ""
            val elapsed = SystemClock.elapsedRealtime() - started
            local.addRunMs(elapsed); local.contributeLastEnd = end
            val plugged = plugged() != 0
            recheck(true)
            val after = after(end.substringBefore(" ·"), plugged, hold == null, off = local.contributeSettings.off)
            Log.i(TAG, "Run ended: $end (${if (foreground) "foreground" else "plain job"}, ${elapsed / 1000} s$stop), next: $after")
            status = null; downloaded = null; running = null; lock.unlock()
            when (after) {
                After.NEXT -> queueRun(applicationContext, ExistingWorkPolicy.APPEND_OR_REPLACE) // after this one, never instead of it
                After.SOON -> queueRun(applicationContext, ExistingWorkPolicy.APPEND_OR_REPLACE, delayMinutes = SOON_MINUTES)
                After.TRIGGER -> arm(applicationContext, ExistingWorkPolicy.REPLACE)
                After.TRIGGER_LATER -> arm(applicationContext, ExistingWorkPolicy.REPLACE, delayed = true)
                After.NONE -> {}
            }
            if (!runNow && after != After.NONE) runCatching { summarize(graph) }.onFailure { Log.w(TAG, "No summary", it) }
        }
    }
    /** `BatteryManager.EXTRA_PLUGGED` from the sticky battery broadcast: 0 on battery. */
    private fun plugged(): Int =
        applicationContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
    /** Foreground while working; false when Android refused (from the background), so the work runs within a job's limits. */
    private suspend fun show(text: String): Boolean {
        status = text
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Contribute", NotificationManager.IMPORTANCE_LOW))
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL).setSmallIcon(R.drawable.ic_store)
            .setContentTitle("FreeAppStore is contributing").setContentText(text).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(0, "Stop", WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)).build()
        return try { setForeground(ForegroundInfo(2, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)); true }
        catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; Log.w(TAG, "Could not run in the foreground", e); false }
    }
    companion object {
        private const val NAME = "contribute"
        private const val NOW = "contribute-now"
        /** The next run while plugged in (#836), queued by the trigger or by a run that ran out of time. */
        private const val NEXT = "contribute-next"
        /** The plugged-in trigger (#836), and its input flag. */
        private const val PLUGGED = "contribute-plugged"
        private const val TRIGGER = "trigger"
        /** Run now (#830): one run that ignores the conditions. */
        private const val RUN_NOW = "run-now"
        private const val CHANNEL = "fas-contribute"
        private const val SUMMARY_CHANNEL = "fas-contribute-summary"
        private const val TAG = "ContributeWorker"
        /** A run held by a passing condition (in use, hot) while plugged in looks again this soon (#830). */
        internal const val SOON_MINUTES = 10L
        /**
         * A run Android kept out of the foreground claims only this long after it starts, and stops itself (the job in hand
         * recorded `stopped`) at [PLAIN_RUN_MS]: a plain job gets about 10 minutes, and one the system times out counts
         * against the app's job-timeout quota (3 a day, `timeout-reg`), after which its jobs are held back.
         */
        internal const val PLAIN_CLAIM_MS = 5 * 60_000L
        internal const val PLAIN_RUN_MS = 9 * 60_000L
        /** Whether a run may claim another job [elapsedMs] after it started (#828). */
        internal fun withinBudget(foreground: Boolean, elapsedMs: Long) = foreground || elapsedMs < PLAIN_CLAIM_MS
        /**
         * The #813 reason a run stopped the job in hand: [outOfTime] is a plain job past [PLAIN_RUN_MS] (#827), and a
         * failed condition (#830) gives its own ([Hold.reason]). All of them give the job back on the server (#841).
         */
        internal fun stopReason(cancelled: Boolean, systemStop: Boolean, hold: Hold?, outOfTime: Boolean) = when {
            cancelled -> "user_stop"
            systemStop || outOfTime -> "background_expired"
            hold != null -> hold.reason
            else -> "user_stop" // the app was turned off
        }
        private val lock = Mutex()
        /** What the running work is doing, in memory only; null while idle. */
        @Volatile var status: String? = null
            private set
        /** The running run's mode, "Auto" or "Run now" (#830); null while idle. */
        @Volatile var running: String? = null
            private set
        /** Bytes of the voice model downloaded so far, null while not downloading. */
        @Volatile var downloaded: Long? = null
            private set
        /**
         * Hourly while paired with something to do and not Off (#830), and the plugged-in trigger (#836); [now] also queues
         * a run as soon as the constraints allow, [runNow] one that ignores the conditions. Inactive, every schedule is
         * cancelled. The hourly work takes the current constraints whenever nothing is running (so an update's new
         * constraints apply, #828), keeping its schedule. A run in progress is never replaced or updated (#806): WorkManager
         * stops running work it reschedules, which lost the job in hand. The trigger is kept as it is: this runs on every
         * app open and upload, and a delayed trigger must stay delayed.
         */
        fun schedule(context: Context, active: Boolean, now: Boolean = false, runNow: Boolean = false) {
            val work = WorkManager.getInstance(context)
            if (!active) { listOf(NAME, NOW, NEXT, PLUGGED).forEach(work::cancelUniqueWork); return }
            val (periodic, once) = policies(running = lock.isLocked)
            work.enqueueUniquePeriodicWork(NAME, periodic, PeriodicWorkRequestBuilder<ContributeWorker>(1, TimeUnit.HOURS).setConstraints(constraints(false)).build())
            if (now || runNow) work.enqueueUniqueWork(NOW, once, OneTimeWorkRequestBuilder<ContributeWorker>().setConstraints(constraints(runNow))
                .setInputData(workDataOf(RUN_NOW to runNow)).build())
            arm(context, ExistingWorkPolicy.KEEP)
        }
        /** Connected only, never unmetered or charging: see the class comment. Run now skips battery-not-low too. */
        private fun constraints(runNow: Boolean) =
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresBatteryNotLow(!runNow).build()
        /** Queues a run on the plugged-in chain (#836), with the current constraints, [delayMinutes] from now. */
        private fun queueRun(context: Context, policy: ExistingWorkPolicy, delayMinutes: Long = 0) {
            WorkManager.getInstance(context).enqueueUniqueWork(NEXT, policy, OneTimeWorkRequestBuilder<ContributeWorker>()
                .setConstraints(constraints(false)).setInitialDelay(delayMinutes, TimeUnit.MINUTES).build())
        }
        /** The plugged-in trigger (#836): charging and connected; [delayed] by an hour when the phone is plugged in already. */
        private fun arm(context: Context, policy: ExistingWorkPolicy, delayed: Boolean = false) {
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresCharging(true).build()
            val request = OneTimeWorkRequestBuilder<ContributeWorker>().setConstraints(constraints).setInputData(workDataOf(TRIGGER to true))
            if (delayed) request.setInitialDelay(1, TimeUnit.HOURS)
            WorkManager.getInstance(context).enqueueUniqueWork(PLUGGED, policy, request.build())
        }
        /** What a run queues once it ends (#836, #830). */
        internal enum class After { NEXT, SOON, TRIGGER, TRIGGER_LATER, NONE }
        /**
         * After a run that ended with [end] (its log reason): nothing once Contribute is [off] (#830); the next run at once
         * when it ran out of time ([withinBudget] or [PLAIN_RUN_MS]) while [plugged] in and able to claim; in
         * [SOON_MINUTES] when the phone was in use or hot while plugged in (#830); otherwise the trigger, an hour later
         * while plugged in so that no jobs, no Wi‑Fi, the daily limit or a Stop never turn into a loop of runs.
         */
        internal fun after(end: String, plugged: Boolean, mayClaim: Boolean, off: Boolean = false): After = when {
            off -> After.NONE
            end == "time_budget" && plugged && mayClaim -> After.NEXT
            plugged && end in setOf("in_use", "thermal") -> After.SOON
            plugged -> After.TRIGGER_LATER
            else -> After.TRIGGER
        }
        /** How [schedule] enqueues: new constraints only while nothing is running; never a replacement for a running run. */
        internal fun policies(running: Boolean): Pair<ExistingPeriodicWorkPolicy, ExistingWorkPolicy> =
            (if (running) ExistingPeriodicWorkPolicy.KEEP else ExistingPeriodicWorkPolicy.UPDATE) to
                (if (running) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.REPLACE)
        @Volatile private var stopRequested = false
        /** Ends the current run after the job in hand stops; the hourly schedule stays. */
        fun stop(context: Context) { stopRequested = true; WorkManager.getInstance(context).run { cancelUniqueWork(NOW); cancelUniqueWork(NEXT) } }

        /**
         * The overnight summary (#844): one quiet notification about the background work since the last one, once a
         * morning or after a long stretch ([ContributeSummary.due]); tapping it opens Activity. Only when it is on in
         * Contribute settings and the app may post notifications. The verdicts are refreshed first so "accepted" is current.
         */
        private fun summarize(graph: FasApplication) {
            val local = graph.local
            val context: Context = graph
            if (!local.contributeSettings.summary || !NotificationManagerCompat.from(context).areNotificationsEnabled()) return
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            val now = System.currentTimeMillis()
            val today = java.time.LocalDate.now().toString()
            val since = maxOf(local.summaryAt, now - 24 * 3_600_000L)
            if (!ContributeSummary.due(ContributeSummary.of(local.contributions(), since), java.time.LocalTime.now().hour, local.summaryDay == today)) return
            (local.contributeApps() + local.contributedApps()).forEach { app ->
                runCatching { graph.generation.refresh(app, local) }.onFailure { Log.w(TAG, "Verdicts for $app not refreshed", it) }
            }
            val summary = ContributeSummary.of(local.contributions(), since)
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(SUMMARY_CHANNEL, "Contribute summary", NotificationManager.IMPORTANCE_LOW))
            val open = PendingIntent.getActivity(context, 0,
                Intent(Intent.ACTION_VIEW, Uri.parse(ContributeSummary.LINK), context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            manager.notify(3, NotificationCompat.Builder(context, SUMMARY_CHANNEL).setSmallIcon(R.drawable.ic_store)
                .setContentTitle("FreeAppStore contributed").setContentText(summary.text()).setContentIntent(open).setAutoCancel(true)
                .setSilent(true).build())
            local.summaryAt = now; local.summaryDay = today
        }
    }
}

/** What background work did since the last overnight summary (#844): uploads, accepted ones and CPU time on the record. */
internal data class ContributeSummary(val generated: Int, val accepted: Int, val cpuMs: Long) {
    /** "Generated 42 clips, 38 accepted, 1 h 10 min CPU". */
    fun text(): String {
        val minutes = (cpuMs + 30_000) / 60_000
        val cpu = if (minutes >= 60) "${minutes / 60} h ${minutes % 60} min" else "$minutes min"
        return "Generated $generated clip${if (generated == 1) "" else "s"}, $accepted accepted, $cpu CPU"
    }
    companion object {
        /** Opens Contribute's Activity (MainActivity, #844). */
        const val LINK = "freeappstore://native/contribute-activity"
        /** CPU time after which a summary is due at any hour: a long run. */
        const val LONG_RUN_MS = 60 * 60_000L
        private val UPLOADED = setOf("uploading", "pending", "accepted", "rejected", "superseded")
        fun of(contributions: List<Contribution>, since: Long): ContributeSummary {
            val recent = contributions.filter { it.at >= since && it.status != "generating" }
            return ContributeSummary(recent.count { it.status in UPLOADED }, recent.count { it.status == "accepted" },
                recent.sumOf { c -> c.record?.let { runCatching { JSONObject(it).optLong("cpuMs") }.getOrNull() } ?: 0L })
        }
        /** Due when something was generated, and it is morning (6 to noon) with none shown today, or after a long run. */
        fun due(s: ContributeSummary, hour: Int, shownToday: Boolean) =
            s.generated > 0 && (hour in 6..11 && !shownToday || s.cpuMs >= LONG_RUN_MS)
    }
}

/**
 * The running job for the status card (#820): "Generating Books · key · sentence 3 of 40 · 1.6× real time", the speed
 * being seconds of audio per second of work, once there is some of each.
 */
internal fun contributeProgress(job: String, sentence: Int, sentences: Int, audioSeconds: Double, elapsedSeconds: Double): String {
    val speed = if (audioSeconds > 0 && elapsedSeconds > 0) " · ${"%.1f".format(java.util.Locale.ROOT, audioSeconds / elapsedSeconds)}× real time" else ""
    return "$job · sentence $sentence of $sentences$speed"
}
