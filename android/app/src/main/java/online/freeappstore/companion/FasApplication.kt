package online.freeappstore.companion

import android.app.Application
import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class FasApplication : Application() {
    val local by lazy { LocalStore(this) }
    val repository by lazy { CompanionRepository(local, SecureStore(this), FasApi()) }
    /** Outside LocalStore, so pairing and disconnect keep the Store tab's cache. */
    val catalogue by lazy { CatalogueStore(java.io.File(noBackupFilesDir, "fas-catalogue")) }
    override fun onCreate() {
        super.onCreate()
        scheduleUploads()
    }
    /** Upload work exists only while paired (#657): no wakeups, which Android vitals counts, without a credential. */
    fun scheduleUploads() = UploadWorker.schedule(this, repository.token() != null)
}
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = applicationContext as FasApplication
        return try { graph.repository.sync(); Result.success() }
        catch (_: Exception) { Result.retry() }
        finally { graph.scheduleUploads() } // a 401 during sync expired the connection: stop the schedule
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
