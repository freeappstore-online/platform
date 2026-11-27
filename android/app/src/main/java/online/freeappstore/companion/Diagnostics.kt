package online.freeappstore.companion

import android.content.Context
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.os.PowerManager
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

/**
 * What this phone generates with (#813), logged at the start of each Contribute run and part of Copy diagnostics: the
 * runner and its version, the voice model, the accelerator (sherpa-onnx runs Kokoro on the CPU), the AAC encoder,
 * free storage, and power, thermal state and network now. Nothing about the account.
 */
internal fun capabilityReport(context: Context, kokoro: KokoroModel, cpu: ContributeSettings.Cpu): JSONObject {
    val probes = androidProbes(context) { "user_stop" }
    val reading = probes.reading()
    val aac = MediaCodecList(MediaCodecList.REGULAR_CODECS).findEncoderForFormat(
        MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 24_000, 1).apply { setInteger(MediaFormat.KEY_BIT_RATE, 32_000) })
    val cores = Runtime.getRuntime().availableProcessors()
    return JSONObject().put("runner", "android").put("appVersion", probes.appVersion).put("os", probes.os).put("device", probes.device)
        .put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: JSONObject.NULL)
        .put("model", "${KokoroModel.ID.model} ${KokoroModel.ID.version}").put("modelInstalled", kokoro.installed)
        .put("accelerator", "cpu (sherpa-onnx, ${cpu.threads.coerceIn(1, cores)} of $cores cores)")
        .put("aacEncoder", aac ?: JSONObject.NULL)
        .put("freeStorageMb", context.noBackupFilesDir.usableSpace / 1_000_000)
        .put("battery", reading.battery ?: JSONObject.NULL).put("charging", reading.charging ?: JSONObject.NULL)
        .put("thermal", reading.thermal ?: JSONObject.NULL)
        .put("powerSave", context.getSystemService(PowerManager::class.java).isPowerSaveMode)
        .put("network", probes.network() ?: JSONObject.NULL)
}

/**
 * Copy diagnostics (#813), for a bug report: the capability report, how the last run ended, the Contribute settings and
 * the [DIAGNOSTIC_JOBS] latest jobs with their status, reasons and attempt records. Never the input text, the audio,
 * notes typed into a report, or any credential.
 */
internal fun diagnosticsJson(capabilities: JSONObject, lastEnd: String, settings: ContributeSettings, contributions: List<Contribution>,
                             now: Long): JSONObject {
    fun nullable(v: Any?) = v ?: JSONObject.NULL
    val jobs = contributions.sortedByDescending { it.at }.take(DIAGNOSTIC_JOBS).map { c ->
        JSONObject().put("jobId", c.jobId).put("appId", c.appId).put("key", c.key).put("at", Instant.ofEpochMilli(c.at).toString())
            .put("status", c.status).put("reason", c.reason).put("durationMs", nullable(c.durationMs)).put("bytes", nullable(c.bytes))
            .put("submissionId", nullable(c.submissionId)).put("reportedGood", nullable(c.report?.good))
            .put("attempt", nullable(c.record?.let { runCatching { JSONObject(it) }.getOrNull() }))
    }
    return JSONObject().put("at", Instant.ofEpochMilli(now).toString()).put("capabilities", capabilities)
        .put("lastRunEnd", lastEnd).put("settings", settings.toString()).put("jobs", JSONArray(jobs))
}

/** How many of the latest jobs Copy diagnostics includes. */
internal const val DIAGNOSTIC_JOBS = 50
