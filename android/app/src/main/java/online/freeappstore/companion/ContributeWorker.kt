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
 * The worker checks power and network itself (#806) rather than through WorkManager constraints, which stop running
 * work, foreground or not, the moment one lapses: Android's charging constraint goes unsatisfied once the battery is full
 * (a phone left on its charger overnight stopped mid-job), and a network change stopped a job part-way. So the work is
 * scheduled with battery-not-low only, checks [ContributePower.mayRun] (plugged in) before starting and as it goes, and
 * [ContributePower.mayClaim] (the network) before starting and before each job; unplugged, it stops without uploading.
 * A network that drops mid-job only matters to the calls that need it.
 */
class ContributeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val graph = applicationContext as FasApplication
        val local = graph.local
        if (graph.repository.token() == null || !lock.tryLock()) return@withContext Result.success()
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
        val keepGoing = {
            // A sticky-broadcast read at most once a second: this runs per downloaded buffer and per synthesized chunk.
            val t = SystemClock.elapsedRealtime()
            if (t - checkedAt >= 1_000) { checkedAt = t; power = ContributePower.mayRun(anyTime, plugged()) }
            !isStopped && !stopRequested && power
        }
        try {
            if (!keepGoing() || !network()) return@withContext Result.success() // the next run tries again
            if (local.modelWanted && !graph.kokoro.installed) {
                downloaded = 0
                show("Downloading the voice model")
                graph.kokoro.install(progress = { downloaded = it; status = "Downloading the voice model · ${KokoroModel.progress(it)}" }, keepGoing = keepGoing)
            }
            if (!graph.kokoro.installed) return@withContext Result.success()
            if (local.contributeApps().isEmpty()) return@withContext Result.success()
            show("Looking for jobs")
            KokoroSynthesizer(graph.kokoro).use { synth ->
                val contributor = Contributor(graph.generation, local, synth, ::AacEncoder, applicationContext.cacheDir)
                for (app in local.contributeApps()) {
                    if (!keepGoing()) break
                    runCatching { contributor.refresh(app, keepGoing) }.onFailure { if (DeviceConnection.expired(it)) throw it }
                }
                // One job from each app in turn (#819), not one app drained before the next.
                contributor.run(local::contributeApps, keepGoing, mayClaim = network) { app, job ->
                    status = "Generating ${graph.catalogue.apps.find { it.id == app }?.name ?: app} · ${job.key}"
                }
            }
            Result.success()
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (DeviceConnection.expired(e)) Result.success() else Result.retry() // an expired connection stops; the next sync says so
        } finally {
            // Android stops work whose constraints lapse (a network change) unless it is in the foreground, and ends a
            // dataSync foreground service after its daily limit (Android 15+); either way keepGoing turned false above.
            if (isStopped) Log.w(TAG, "Stopped by the system" + if (Build.VERSION.SDK_INT >= 31) ", reason $stopReason" else "")
            status = null; downloaded = null; lock.unlock()
        }
    }
    /** `BatteryManager.EXTRA_PLUGGED` from the sticky battery broadcast: 0 on battery. */
    private fun plugged(): Int =
        applicationContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
    /** Foreground while working. Android may refuse from the background; the work then runs within the normal limits. */
    private suspend fun show(text: String) {
        status = text
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Contribute", NotificationManager.IMPORTANCE_LOW))
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL).setSmallIcon(R.drawable.ic_store)
            .setContentTitle("FreeAppStore is contributing").setContentText(text).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(0, "Stop", WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)).build()
        try { setForeground(ForegroundInfo(2, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)) }
        catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; Log.w(TAG, "Could not run in the foreground", e) }
    }
    companion object {
        private const val NAME = "contribute"
        private const val NOW = "contribute-now"
        private const val CHANNEL = "fas-contribute"
        private const val TAG = "ContributeWorker"
        private val lock = Mutex()
        /** What the running work is doing, in memory only; null while idle. */
        @Volatile var status: String? = null
            private set
        /** Bytes of the voice model downloaded so far, null while not downloading. */
        @Volatile var downloaded: Long? = null
            private set
        /**
         * Hourly while paired with something to do; [now] also queues a run as soon as the constraints allow. The hourly
         * work is kept as it is unless [now] (a settings change or Run now) replaces its constraints. A run in progress is
         * never replaced or updated (#806): WorkManager stops running work it reschedules, which lost the job in hand.
         */
        fun schedule(context: Context, active: Boolean, anyTime: Boolean, now: Boolean = false) {
            val work = WorkManager.getInstance(context)
            if (!active) { work.cancelUniqueWork(NAME); work.cancelUniqueWork(NOW); return }
            // No network constraint: see the class comment. Without one, a run that finds no network ends at once.
            val constraints = Constraints.Builder().setRequiresBatteryNotLow(!anyTime).build()
            val (periodic, once) = policies(now, running = lock.isLocked)
            work.enqueueUniquePeriodicWork(NAME, periodic, PeriodicWorkRequestBuilder<ContributeWorker>(1, TimeUnit.HOURS).setConstraints(constraints).build())
            if (now) work.enqueueUniqueWork(NOW, once, OneTimeWorkRequestBuilder<ContributeWorker>().setConstraints(constraints).build())
        }
        /** How [schedule] enqueues: new constraints only while nothing is running; never a replacement for a running run. */
        internal fun policies(now: Boolean, running: Boolean): Pair<ExistingPeriodicWorkPolicy, ExistingWorkPolicy> =
            (if (now && !running) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP) to
                (if (running) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.REPLACE)
        @Volatile private var stopRequested = false
        /** Ends the current run after the job in hand stops; the hourly schedule stays. */
        fun stop(context: Context) { stopRequested = true; WorkManager.getInstance(context).cancelUniqueWork(NOW) }
    }
}

/** Contribute's "Only while plugged in on Wi‑Fi" (#806). */
object ContributePower {
    /** Whether the work may go on: any time if the user allowed it, otherwise only while [plugged] (`EXTRA_PLUGGED`) is not 0. */
    fun mayRun(anyTime: Boolean, plugged: Int): Boolean = anyTime || plugged != 0
    /** Whether a job may be claimed (or the model downloaded): online, and on an unmetered network unless any time is allowed. */
    fun mayClaim(anyTime: Boolean, connected: Boolean, unmetered: Boolean): Boolean = connected && (anyTime || unmetered)
}
