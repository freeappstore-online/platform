package online.freeappstore.companion

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.work.*
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext

/**
 * Contribute (#731): downloads the voice model when asked, then works through each opted-in app's open jobs. Runs as
 * WorkManager work, by default only while charging on an unmetered network, with a foreground notification. Its Stop
 * action cancels the work until FreeAppStore is opened again; Stop in the app ends only the current run.
 */
class ContributeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val graph = applicationContext as FasApplication
        val local = graph.local
        if (graph.repository.token() == null || !lock.tryLock()) return@withContext Result.success()
        stopRequested = false
        val keepGoing = { !isStopped && !stopRequested }
        try {
            if (local.modelWanted && !graph.kokoro.installed) {
                show("Downloading the voice model")
                graph.kokoro.install(progress = { status = "Downloading the voice model · ${it * 100 / KokoroModel.DOWNLOAD_BYTES}%" }, keepGoing = keepGoing)
            }
            if (!graph.kokoro.installed) return@withContext Result.success()
            val apps = local.contributeApps()
            if (apps.isEmpty()) return@withContext Result.success()
            show("Looking for jobs")
            KokoroSynthesizer(graph.kokoro).use { synth ->
                val contributor = Contributor(graph.generation, local, synth, ::AacEncoder, applicationContext.cacheDir)
                for (app in apps) {
                    if (!keepGoing()) break
                    runCatching { graph.generation.refresh(app, local) }.onFailure { if (DeviceConnection.expired(it)) throw it }
                    contributor.run(app, keepGoing = { keepGoing() && app in local.contributeApps() }) { job -> status = "Generating ${job.key}" }
                }
            }
            Result.success()
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (DeviceConnection.expired(e)) Result.success() else Result.retry() // an expired connection stops; the next sync says so
        } finally { status = null; lock.unlock() }
    }
    /** Foreground while working. Android may refuse from the background; the work then runs within the normal limits. */
    private suspend fun show(text: String) {
        status = text
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Contribute", NotificationManager.IMPORTANCE_LOW))
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL).setSmallIcon(R.drawable.ic_store)
            .setContentTitle("FreeAppStore is contributing").setContentText(text).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(0, "Stop", WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)).build()
        try { setForeground(ForegroundInfo(2, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)) } catch (_: Exception) { }
    }
    companion object {
        private const val NAME = "contribute"
        private const val NOW = "contribute-now"
        private const val CHANNEL = "fas-contribute"
        private val lock = Mutex()
        /** What the running work is doing, in memory only; null while idle. */
        @Volatile var status: String? = null
            private set
        /**
         * Hourly while paired with something to do; [now] also queues a run as soon as the constraints allow. The hourly
         * work is kept as it is unless [now] (a settings change or Run now) replaces its constraints.
         */
        fun schedule(context: Context, active: Boolean, anyTime: Boolean, now: Boolean = false) {
            val work = WorkManager.getInstance(context)
            if (!active) { work.cancelUniqueWork(NAME); work.cancelUniqueWork(NOW); return }
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(if (anyTime) NetworkType.CONNECTED else NetworkType.UNMETERED)
                .setRequiresCharging(!anyTime).build()
            work.enqueueUniquePeriodicWork(NAME, if (now) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<ContributeWorker>(1, TimeUnit.HOURS).setConstraints(constraints).build())
            if (now) work.enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<ContributeWorker>().setConstraints(constraints).build())
        }
        @Volatile private var stopRequested = false
        /** Ends the current run after the job in hand stops; the hourly schedule stays. */
        fun stop(context: Context) { stopRequested = true; WorkManager.getInstance(context).cancelUniqueWork(NOW) }
    }
}
