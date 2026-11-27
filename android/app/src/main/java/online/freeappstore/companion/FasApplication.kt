package online.freeappstore.companion

import android.app.Application
import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class FasApplication : Application() {
    private val api = FasApi()
    val local by lazy { LocalStore(this) }
    val repository by lazy { CompanionRepository(local, SecureStore(this), api) }
    /** Contribute (#731): the voice model in no-backup storage, and the contributor routes with the device credential. */
    val kokoro by lazy { KokoroModel(java.io.File(noBackupFilesDir, "kokoro")) }
    val generation by lazy { GenerationClient(api, repository::token) }
    val kept get() = local.kept
    /** Outside LocalStore, so pairing and disconnect keep the Store tab's cache. */
    val catalogue by lazy { CatalogueStore(java.io.File(noBackupFilesDir, "fas-catalogue")) }
    override fun onCreate() {
        super.onCreate()
        scheduleWork()
    }
    /**
     * Upload and contribute work exist only while paired (#657): no wakeups, which Android vitals counts, without a
     * credential. Contribute work also needs an opted-in app or a model download to do, and Contribute not Off (#830).
     * [now] runs contributions soon; [runNow] once, ignoring the conditions.
     */
    fun scheduleWork(now: Boolean = false, runNow: Boolean = false) {
        val paired = repository.token() != null
        UploadWorker.schedule(this, paired)
        val todo = local.contributeApps().isNotEmpty() || (local.modelWanted && !kokoro.installed)
        ContributeWorker.schedule(this, paired && todo && !local.contributeSettings.off, now, runNow)
    }
}
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = applicationContext as FasApplication
        return try { graph.repository.sync(); Result.success() }
        catch (_: Exception) { Result.retry() }
        finally { graph.scheduleWork() } // a 401 during sync expired the connection: stop the schedule
    }
    companion object {
        const val NAME = "native-upload"
        fun schedule(context: Context, paired: Boolean) {
            val work = WorkManager.getInstance(context)
            if (!paired) { work.cancelUniqueWork(NAME); return }
            work.enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
        }
    }
}
