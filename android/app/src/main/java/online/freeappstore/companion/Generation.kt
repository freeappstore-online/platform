package online.freeappstore.companion

import java.io.File
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

/**
 * Community generation (#727, #731): this phone claims an app's open jobs, generates each one on the phone and uploads
 * the result against the job's lease. The server decides what is generated and verifies every upload; the phone only
 * ever generates the exact input it claimed, never text the user chooses, and never uploads twice for one job.
 */
data class ModelId(val model: String, val version: String)

/** A claimed job. [text] is the job's whole input; a job whose input is anything else has a blank [text] and is refused. */
data class GenerationJob(
    val id: String, val setId: String, val key: String, val text: String, val model: ModelId, val params: JSONObject,
    val formats: List<String>, val maxBytes: Long, val leaseToken: String, val leaseExpiresAt: Long,
)

/** One job on this phone's contribution record. `status`: uploading, then the server's pending/accepted/rejected/superseded; or skipped/failed locally. */
data class Contribution(val jobId: String, val appId: String, val key: String, val at: Long, val status: String, val reason: String = "")

/** Where the record lives: [LocalStore] on the phone, a list in tests. */
interface ContributionLog {
    /** Whether this job was ever started on this phone. Such a job is never generated or uploaded again. */
    fun handled(jobId: String): Boolean
    fun record(contribution: Contribution)
    fun updateStatus(jobId: String, status: String, reason: String)
}

/**
 * The `X-Attestation` hook (#732). Returns a Play Integrity token bound to the job, or null. The server treats it as an
 * extra signal only; until #732 lands nothing is sent.
 */
fun interface Attestation {
    fun token(appId: String, job: GenerationJob): String?
    companion object { val NONE = Attestation { _, _ -> null } }
}

class Audio(val samples: FloatArray, val sampleRate: Int)

interface Synthesizer {
    val model: ModelId
    /** Whether this model can honour the job's `params` exactly. */
    fun accepts(params: JSONObject): Boolean
    /** The audio for [text], or null when [keepGoing] turned false part-way. */
    fun synthesize(text: String, params: JSONObject, keepGoing: () -> Boolean): Audio?
}

/** The contributor routes, with the device credential. */
class GenerationClient(private val api: FasApi, private val credential: () -> String?) {
    private fun token() = credential() ?: throw ApiFailure(401, "Sign in first.")
    /** `null` when the app has no open job for these models (`204`). */
    fun claim(appId: String, models: List<ModelId>): GenerationJob? {
        val body = JSONObject().put("models", JSONArray(models.map { JSONObject().put("model", it.model).put("modelVersion", it.version) }))
        return api.request("POST", "/apps/$appId/generation/claim", token(), body).optJSONObject("job")?.let(::parseJob)
    }
    /** Returns the submission id. */
    fun submit(appId: String, job: GenerationJob, file: File, contentType: String, attestation: String?): String {
        val headers = buildMap { put("X-Lease-Token", job.leaseToken); attestation?.let { put("X-Attestation", it) } }
        return api.upload("PUT", "/apps/$appId/generation/jobs/${job.id}/result", token(), headers, file, contentType).getString("submissionId")
    }
    /** Copies the server's verdicts on this account's submissions into [log]. */
    fun refresh(appId: String, log: ContributionLog) {
        val list = api.request("GET", "/apps/$appId/generation/submissions", token()).optJSONArray("submissions") ?: return
        for (i in 0 until list.length()) {
            val s = list.getJSONObject(i)
            val jobId = s.optString("jobId")
            if (jobId.isNotBlank()) log.updateStatus(jobId, s.optString("status"), if (s.isNull("reason")) "" else s.optString("reason").take(120))
        }
    }
    companion object {
        private val ID = Regex("^[A-Za-z0-9_-]{1,128}$")
        internal fun parseJob(j: JSONObject): GenerationJob {
            val id = j.getString("id").also { require(ID.matches(it)) { "Unexpected job id." } }
            val input = j.getJSONObject("input")
            val formats = j.optJSONArray("formats") ?: JSONArray()
            val expires = j.get("leaseExpiresAt")
            return GenerationJob(
                id, j.optString("setId"), j.optString("key"),
                text = if (input.length() == 1) input.optString("text") else "",
                model = ModelId(j.getString("model"), j.getString("modelVersion")),
                params = j.optJSONObject("params") ?: JSONObject(),
                formats = (0 until formats.length()).map { formats.getString(it) },
                maxBytes = j.optLong("maxBytes"), leaseToken = j.getString("leaseToken"),
                leaseExpiresAt = if (expires is Number) expires.toLong() else Instant.parse(expires.toString()).toEpochMilli(),
            )
        }
    }
}

object GenerationPolicy {
    const val CONTENT_TYPE = "audio/mp4"
    /** An upload must start at least this long before the lease runs out. */
    const val LEASE_MARGIN_MS = 30_000L
    /** Why this phone will not generate the job, or null when it will. */
    fun refusal(job: GenerationJob, synth: Synthesizer, handled: Boolean, now: Long): String? = when {
        handled -> "already_handled"
        job.model != synth.model -> "model"
        CONTENT_TYPE !in job.formats -> "format"
        job.text.isBlank() -> "input"
        !synth.accepts(job.params) -> "params"
        job.maxBytes <= 0 -> "max_bytes"
        job.leaseExpiresAt - LEASE_MARGIN_MS <= now -> "lease_expired"
        else -> null
    }
}

/** The claim → generate → encode → submit loop for one app. */
class Contributor(
    private val client: GenerationClient, private val log: ContributionLog, private val synth: Synthesizer,
    private val encode: (Audio, File) -> Unit, private val workDir: File,
    private val attestation: Attestation = Attestation.NONE, private val now: () -> Long = System::currentTimeMillis,
) {
    /**
     * Works through [appId]'s open jobs until none is left, [keepGoing] turns false, or a job is not submitted (it
     * keeps its lease until expiry, so the next run continues). Returns how many were submitted. A `401` is thrown.
     */
    fun run(appId: String, keepGoing: () -> Boolean, progress: (GenerationJob) -> Unit = {}): Int {
        var submitted = 0
        while (keepGoing()) {
            val job = client.claim(appId, listOf(synth.model)) ?: break
            progress(job)
            if (!process(appId, job, keepGoing)) break
            submitted++
        }
        return submitted
    }
    private fun process(appId: String, job: GenerationJob, keepGoing: () -> Boolean): Boolean {
        val handled = log.handled(job.id)
        GenerationPolicy.refusal(job, synth, handled, now())?.let { reason ->
            if (!handled) log.record(Contribution(job.id, appId, job.key, now(), "skipped", reason))
            return false
        }
        val file = File(workDir, "contribution.m4a")
        try {
            // The job's own input, verbatim: the only text this path can generate.
            val audio = synth.synthesize(job.text, job.params) { keepGoing() && now() < job.leaseExpiresAt - GenerationPolicy.LEASE_MARGIN_MS }
            if (audio == null) {
                log.record(Contribution(job.id, appId, job.key, now(), "skipped", if (keepGoing()) "lease_expired" else "stopped"))
                return false
            }
            encode(audio, file)
            val refusal = when {
                file.length() > job.maxBytes -> "too_large"
                now() >= job.leaseExpiresAt - GenerationPolicy.LEASE_MARGIN_MS -> "lease_expired"
                else -> null
            }
            if (refusal != null) { log.record(Contribution(job.id, appId, job.key, now(), "skipped", refusal)); return false }
            // Recorded before the upload starts, so a crash mid-upload can never lead to a second, different file.
            log.record(Contribution(job.id, appId, job.key, now(), "uploading"))
            client.submit(appId, job, file, GenerationPolicy.CONTENT_TYPE, attestation.token(appId, job))
            log.updateStatus(job.id, "pending", "")
            return true
        } catch (e: Exception) {
            if (DeviceConnection.expired(e)) throw e
            val reason = ((e as? ApiFailure)?.let { "${it.status} " } ?: "") + (e.message ?: e.javaClass.simpleName)
            if (log.handled(job.id)) log.updateStatus(job.id, "failed", reason.take(120))
            else log.record(Contribution(job.id, appId, job.key, now(), "failed", reason.take(120)))
            return false
        } finally { file.delete() }
    }
}
