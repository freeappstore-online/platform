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
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("native-upload", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
}
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        (applicationContext as FasApplication).repository.sync(); Result.success()
    } catch (_: Exception) { Result.retry() }
}
