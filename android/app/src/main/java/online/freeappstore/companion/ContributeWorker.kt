package online.freeappstore.companion

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.*
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext

/**
 * Contribute (#731): downloads the voice model when asked, then takes open jobs from the opted-in apps in turn. Runs as
 * WorkManager work, by default only while plugged in on an unmetered network, with a foreground notification. Its Stop
 * action cancels the work until FreeAppStore is opened again; Stop in the app ends only the current run.
 *
 * The worker checks power and the kind of network itself (#806) rather than through WorkManager constraints, which stop
 * running work, foreground or not, the moment one lapses: Android's charging constraint goes unsatisfied once the battery
 * is full (a phone left on its charger overnight stopped mid-job), and a change to a metered network stopped a job
 * part-way. So it checks [ContributePower.mayRun] (plugged in) before starting and as it goes, and
 * [ContributePower.mayClaim] (online, unmetered unless any time is allowed) before starting and before each job;
 * unplugged, it stops without uploading. The one network constraint is "connected" (#828): Android 17 blocks the network
 * of an app in the background (`blocked=APP_BACKGROUND`) except for a job that asked for one, so without it every
 * background run found no network and ended at once. A switch between Wi-Fi and mobile data keeps it satisfied.
 *
 * Android may refuse the foreground service to work started from the background (#828). The run then goes on as a plain
 * job, which the system stops after about ten minutes (on the Pixel 10a, Android 17, the refusal is
 * `ForegroundServiceStartNotAllowedException`), so it claims only within [ContributeWorker.PLAIN_CLAIM_MS] of its start and
 * ends itself at [ContributeWorker.PLAIN_RUN_MS], before the system times it out; the job in hand is then recorded
 * `stopped` (`background_expired`) and its lease lapses. The server refuses a claim once the app's daily generation
 * budget is used up or the user holds 4 open leases (`429`); the run then ends until the next one. Each run logs how it
 * ended.
 */
class ContributeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val graph = applicationContext as FasApplication
        val local = graph.local
        if (graph.repository.token() == null || !lock.tryLock()) {
            Log.i(TAG, "Run ended: " + if (lock.isLocked) "already_running" else "not_connected")
            return@withContext Result.success()
        }
        stopRequested = false
        val anyTime = local.contributeAnyTime
        var checkedAt = -1_000L
        var power = true
        val network = {
            val connectivity = applicationContext.getSystemService(ConnectivityManager::class.java)
            val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
            ContributePower.mayClaim(anyTime, caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
                caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true)
        }
        val started = SystemClock.elapsedRealtime()
        var foreground = false
        var end = "no_work"
        val keepGoing = {
            // A sticky-broadcast read at most once a second: this runs per downloaded buffer and per synthesized chunk.
            val t = SystemClock.elapsedRealtime()
            if (t - checkedAt >= 1_000) { checkedAt = t; power = ContributePower.mayRun(anyTime, plugged()) }
            !isStopped && !stopRequested && power && (foreground || t - started < PLAIN_RUN_MS)
        }
        val mayClaim = { network() && withinBudget(foreground, SystemClock.elapsedRealtime() - started) }
        /** Why keepGoing is false, for the log line. */
        val stopped = { if (isStopped) "system_stop" else if (stopRequested) "user_stop" else if (power) "time_budget" else "unplugged" }
        try {
            if (!keepGoing()) { end = stopped(); return@withContext Result.success() } // the next run tries again
            if (!network()) { end = "offline"; return@withContext Result.success() }
            if (local.modelWanted && !graph.kokoro.installed) {
                downloaded = 0
                foreground = show("Downloading the voice model")
                graph.kokoro.install(progress = { downloaded = it; status = "Downloading the voice model · ${KokoroModel.progress(it)}" }, keepGoing = keepGoing)
            }
            if (!graph.kokoro.installed) { end = "no_model"; return@withContext Result.success() }
            if (local.contributeApps().isEmpty()) { end = "no_apps"; return@withContext Result.success() }
            foreground = show("Looking for jobs")
            KokoroSynthesizer(graph.kokoro).use { synth ->
                // Why keepGoing turned false, for the attempt record (#827): the notification's Stop cancels the work.
                val whyStopped = {
                    stopReason(cancelled = stopRequested || isStopped && Build.VERSION.SDK_INT >= 31 && stopReason == WorkInfo.STOP_REASON_CANCELLED_BY_APP,
                        systemStop = isStopped, power = power, outOfTime = !foreground && SystemClock.elapsedRealtime() - started >= PLAIN_RUN_MS)
                }
                val contributor = Contributor(graph.generation, local, synth, ::AacEncoder, applicationContext.cacheDir,
                    probes = androidProbes(applicationContext, whyStopped), kept = graph.kept)
                for (app in local.contributeApps()) {
                    if (!keepGoing()) break
                    runCatching { contributor.refresh(app, keepGoing) }.onFailure { if (DeviceConnection.expired(it)) throw it }
                }
                // One job from each app in turn (#819), not one app drained before the next.
                var job = ""
                var jobStarted = 0L
                val submitted = contributor.run(local::contributeApps, keepGoing, mayClaim = mayClaim, progress = { app, claimed ->
                    job = "Generating ${graph.catalogue.apps.find { it.id == app }?.name ?: app} · ${claimed.key}"
                    jobStarted = SystemClock.elapsedRealtime(); status = job
                }, sentence = { n, total, seconds ->
                    status = contributeProgress(job, n, total, seconds, (SystemClock.elapsedRealtime() - jobStarted) / 1000.0)
                })
                end = when {
                    !keepGoing() -> stopped()
                    !network() -> "offline"
                    !mayClaim() -> "time_budget"
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
            Log.i(TAG, "Run ended: $end (${if (foreground) "foreground" else "plain job"}, ${(SystemClock.elapsedRealtime() - started) / 1000} s$stop)")
            status = null; downloaded = null; lock.unlock()
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
        private const val CHANNEL = "fas-contribute"
        private const val TAG = "ContributeWorker"
        /**
         * A run Android kept out of the foreground claims only this long after it starts, and stops itself (the job in hand
         * recorded `stopped`) at [PLAIN_RUN_MS]: a plain job gets about 10 minutes, and one the system times out counts
         * against the app's job-timeout quota (3 a day, `timeout-reg`), after which its jobs are held back.
         */
        internal const val PLAIN_CLAIM_MS = 5 * 60_000L
        internal const val PLAIN_RUN_MS = 9 * 60_000L
        /** Whether a run may claim another job [elapsedMs] after it started (#828). */
        internal fun withinBudget(foreground: Boolean, elapsedMs: Long) = foreground || elapsedMs < PLAIN_CLAIM_MS
        /** The #813 reason a run stopped the job in hand: [outOfTime] is a plain job past [PLAIN_RUN_MS] (#827). */
        internal fun stopReason(cancelled: Boolean, systemStop: Boolean, power: Boolean, outOfTime: Boolean) = when {
            cancelled -> "user_stop"
            systemStop || outOfTime -> "background_expired"
            !power -> "unplugged"
            else -> "user_stop" // the app was turned off
        }
        private val lock = Mutex()
        /** What the running work is doing, in memory only; null while idle. */
        @Volatile var status: String? = null
            private set
        /** Bytes of the voice model downloaded so far, null while not downloading. */
        @Volatile var downloaded: Long? = null
            private set
        /**
         * Hourly while paired with something to do; [now] also queues a run as soon as the constraints allow. The hourly
         * work takes the current constraints whenever nothing is running (so an update's new constraints apply, #828), keeping
         * its schedule. A run in progress is never replaced or updated (#806): WorkManager stops running work it reschedules,
         * which lost the job in hand.
         */
        fun schedule(context: Context, active: Boolean, anyTime: Boolean, now: Boolean = false) {
            val work = WorkManager.getInstance(context)
            if (!active) { work.cancelUniqueWork(NAME); work.cancelUniqueWork(NOW); return }
            // Connected only, never unmetered or charging: see the class comment.
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresBatteryNotLow(!anyTime).build()
            val (periodic, once) = policies(running = lock.isLocked)
            work.enqueueUniquePeriodicWork(NAME, periodic, PeriodicWorkRequestBuilder<ContributeWorker>(1, TimeUnit.HOURS).setConstraints(constraints).build())
            if (now) work.enqueueUniqueWork(NOW, once, OneTimeWorkRequestBuilder<ContributeWorker>().setConstraints(constraints).build())
        }
        /** How [schedule] enqueues: new constraints only while nothing is running; never a replacement for a running run. */
        internal fun policies(running: Boolean): Pair<ExistingPeriodicWorkPolicy, ExistingWorkPolicy> =
            (if (running) ExistingPeriodicWorkPolicy.KEEP else ExistingPeriodicWorkPolicy.UPDATE) to
                (if (running) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.REPLACE)
        @Volatile private var stopRequested = false
        /** Ends the current run after the job in hand stops; the hourly schedule stays. */
        fun stop(context: Context) { stopRequested = true; WorkManager.getInstance(context).cancelUniqueWork(NOW) }
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

/** Contribute's "Only while plugged in on Wi‑Fi" (#806). */
object ContributePower {
    /** Whether the work may go on: any time if the user allowed it, otherwise only while [plugged] (`EXTRA_PLUGGED`) is not 0. */
    fun mayRun(anyTime: Boolean, plugged: Int): Boolean = anyTime || plugged != 0
    /** Whether a job may be claimed (or the model downloaded): online, and on an unmetered network unless any time is allowed. */
    fun mayClaim(anyTime: Boolean, connected: Boolean, unmetered: Boolean): Boolean = connected && (anyTime || unmetered)
}
