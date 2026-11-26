package online.freeappstore.companion

import java.io.File
import java.io.IOException
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

/**
 * Community generation (#727, #731): this phone claims an app's open jobs, generates each one on the phone and uploads
 * the result against the job's lease. The server decides what is generated and verifies every upload; the phone only
 * ever generates the exact input it claimed, never text the user chooses, and never uploads twice for one job.
 */
data class ModelId(val model: String, val version: String)

/**
 * A claimed job. [text] is the job's whole input; a job whose input is anything else has a blank [text] and is refused.
 * [language] is its set's BCP 47 tag (#810), or null when the set names none.
 */
data class GenerationJob(
    val id: String, val setId: String, val key: String, val text: String, val model: ModelId, val params: JSONObject,
    val formats: List<String>, val maxBytes: Long, val language: String?, val leaseToken: String, val leaseExpiresAt: Long,
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

/** How a job's text is split into sentences and spoken (#812). */
enum class Language { ENGLISH, SPANISH, MANDARIN }

/** Where narration goes as it is synthesized (#793): [AacEncoder] on the phone, writing to a file. */
interface AudioSink : AutoCloseable {
    /** Appends mono samples in -1..1. */
    fun write(samples: FloatArray)
    /** Ends the audio and completes the file. */
    fun finish()
}

interface Synthesizer {
    val model: ModelId
    /** Whether this model can honour the job's `params` exactly. */
    fun accepts(params: JSONObject): Boolean
    /** How it speaks a job with these `params` from a set naming [language], or null when it can't speak that (#812). */
    fun language(params: JSONObject, language: String?): Language?
    /** The audio for [text], or null when [keepGoing] turned false part-way. */
    fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio?
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
    fun submit(appId: String, job: GenerationJob, file: File, contentType: String, meta: JSONObject, attestation: String?): String {
        val headers = buildMap { put("X-Lease-Token", job.leaseToken); attestation?.let { put("X-Attestation", it) } }
        return api.upload("PUT", "/apps/$appId/generation/jobs/${job.id}/result", token(), headers, file, contentType, meta).getString("submissionId")
    }
    /** Extends the job's lease (#783) and returns its new expiry. `403`: the lease is gone; `409`: it is at its cap. */
    fun extend(appId: String, job: GenerationJob): Long =
        epochMs(api.post("/apps/$appId/generation/jobs/${job.id}/lease", token(), mapOf("X-Lease-Token" to job.leaseToken)).get("leaseExpiresAt"))
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
            return GenerationJob(
                id, j.optString("setId"), j.optString("key"),
                text = if (input.length() == 1) input.optString("text") else "",
                model = ModelId(j.getString("model"), j.getString("modelVersion")),
                params = j.optJSONObject("params") ?: JSONObject(),
                formats = (0 until formats.length()).map { formats.getString(it) },
                maxBytes = j.optLong("maxBytes"), language = if (j.isNull("language")) null else j.getString("language"),
                leaseToken = j.getString("leaseToken"),
                leaseExpiresAt = epochMs(j.get("leaseExpiresAt")),
            )
        }
        private fun epochMs(value: Any) = if (value is Number) value.toLong() else Instant.parse(value.toString()).toEpochMilli()
    }
}

object GenerationPolicy {
    const val CONTENT_TYPE = "audio/mp4"
    /** An upload must start at least this long before the lease runs out. */
    const val LEASE_MARGIN_MS = 30_000L
    /** While generating, the lease is extended once it is this close to expiry (#783). */
    const val EXTEND_WITHIN_MS = 5 * 60_000L
    /** The largest `meta` part the server takes. */
    const val MAX_META_BYTES = 64 * 1024
    /** Silence after a sentence and after a paragraph, in seconds: Books' `SENTENCE_PAUSE` and `PARAGRAPH_PAUSE`. */
    const val SENTENCE_PAUSE = 0.4
    const val PARAGRAPH_PAUSE = 0.8
    /**
     * Audio shorter than this gets silence at the end (#812), so a two-character phrase such as 对。 is well within the
     * server's characters-per-second floor and Whisper hears it whole. Audio up to 3 s is never too long for its text.
     */
    const val MIN_SECONDS = 1.0
    /** Why this phone will not generate the job, or null when it will. */
    fun refusal(job: GenerationJob, synth: Synthesizer, handled: Boolean, now: Long): String? = when {
        handled -> "already_handled"
        job.model != synth.model -> "model"
        CONTENT_TYPE !in job.formats -> "format"
        job.text.isBlank() -> "input"
        !synth.accepts(job.params) -> "params"
        synth.language(job.params, job.language) == null -> "language"
        job.maxBytes <= 0 -> "max_bytes"
        job.leaseExpiresAt - LEASE_MARGIN_MS <= now -> "lease_expired"
        else -> null
    }
}

/**
 * Transient network failures (#819): a lost connection, DNS failure, timeout or reset (any [IOException]), a `5xx`, or a
 * `429` that says when to come back (`Retry-After`). Their calls are tried again after a bounded backoff while there is
 * time; any other failure is final.
 */
object NetworkRetry {
    const val FIRST_MS = 2_000L
    const val MAX_MS = 60_000L
    /** How long a claim or the verdict refresh keeps trying; an upload keeps trying while its lease allows. */
    const val REQUEST_WINDOW_MS = 60_000L
    /** The reason recorded for a job whose upload never got through. */
    const val REASON = "network"
    /** The wait before trying again a call that failed with [e] on attempt [attempt] (from 0), or null when [e] is final. */
    fun delayMs(e: Throwable, attempt: Int): Long? = when {
        e is IOException -> backoff(attempt)
        e is ApiFailure && e.status == 429 -> e.retryAfterMs
        e is ApiFailure && e.status in 500..599 -> e.retryAfterMs ?: backoff(attempt)
        else -> null
    }
    private fun backoff(attempt: Int) = minOf(MAX_MS, FIRST_MS shl minOf(attempt, 5))
}

/**
 * The sentences Books narrates one at a time (#785), ported from its `scripts/audio/segments.py` with the `END` and
 * `ABBREVIATION` of its English and Spanish profiles: a sentence ends at . ! ? or … (with any closing quotes or
 * brackets) followed by space and not by a lowercase word, but not after an abbreviation such as Mr. or an initial;
 * blank lines end paragraphs. Mandarin (#812) has no spaces: a sentence ends at 。！？；… or their ASCII forms (with
 * any closing quotes or brackets) whatever follows, except a full stop before a digit (3.5). Offsets are string
 * indices, so UTF-16 code units like Books' timings.
 */
object Sentences {
    data class Sentence(val start: Int, val end: Int, val endsParagraph: Boolean)
    /** Python's `\s`, spelled out so the JVM and Android's ICU regex engine agree. */
    private const val S = """\t\n\u000b\f\r\u001c-\u001f \u0085   -     　"""
    private val PARAGRAPH = Regex("""[^$S].*?(?=[$S]*\n[$S]*\n|[$S]*$)""", RegexOption.DOT_MATCHES_ALL)
    private val SPACE = Regex("[$S]*").toPattern()
    /** Python's `\b` before a word. */
    private const val B = """(?<![\p{L}\p{N}_])"""
    private val EN = Regex("""[.!?…]+[”’"')\]]*(?=[$S]+(?![a-z]))""").toPattern() to
        Regex("""$B(Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Rev|Capt|Col|Gen|Lt|Mt|[A-HJ-Z])$""").toPattern()
    private const val LOWER = "a-záéíóúüñ"
    private val ES = Regex("""[.!?…]+[”’"')\]»]*(?=[$S]+(?![$LOWER]|[—-]+[$S]?[$LOWER]))""").toPattern() to
        Regex("""$B(Sr|Sra|Srta|Sres|Srs|Dr|Dra|Dña|Ud|Uds|Vd|Vds|Vmd|Excmo|Excma|Ilmo|Ilma|Rvdo|Sto|Sta|Fr|Pbro|[A-ZÁÉÍÓÚÑ])$""").toPattern()
    private val ZH = Regex("""(?:[。！？；…!?;]|\.(?!\d))+[”’"')\]）」』】》]*""").toPattern() to null

    fun split(text: String, language: Language): List<Sentence> {
        val (end, abbreviation) = when (language) { Language.ENGLISH -> EN; Language.SPANISH -> ES; Language.MANDARIN -> ZH }
        val out = mutableListOf<Sentence>()
        for (para in PARAGRAPH.findAll(text)) {
            val paraEnd = para.range.last + 1
            var start = para.range.first
            val m = end.matcher(text).region(start, paraEnd)
            while (m.find()) {
                if (m.group() == "." && abbreviation != null && abbreviation.matcher(text).region(start, m.start()).useTransparentBounds(true).find()) continue
                out += Sentence(start, m.end(), false)
                start = SPACE.matcher(text).region(m.end(), paraEnd).apply { lookingAt() }.end()
            }
            if (start < paraEnd) out += Sentence(start, paraEnd, false)
            out[out.lastIndex] = out.last().copy(endsParagraph = true)
        }
        return out
    }
}

/** The claim → generate → encode → submit loop over the opted-in apps. */
class Contributor(
    private val client: GenerationClient, private val log: ContributionLog, private val synth: Synthesizer,
    private val encoder: (File, Int) -> AudioSink, private val workDir: File,
    private val attestation: Attestation = Attestation.NONE, private val now: () -> Long = System::currentTimeMillis,
    private val sleep: (Long) -> Unit = Thread::sleep,
) {
    /**
     * Takes one job from each of [apps] in turn (#819), until none has work left, [keepGoing] turns false or [mayClaim]
     * (checked before each claim) turns false. [apps] is read again before each claim, so an app turned off mid-run is
     * left out. An app leaves the run once it has no open job or one of its jobs is not submitted (that job keeps its
     * lease until expiry, so the next run continues). Returns how many were submitted. A `401` is thrown, and so is a
     * claim that still fails after [NetworkRetry]'s retries.
     */
    fun run(apps: () -> Set<String>, keepGoing: () -> Boolean, mayClaim: () -> Boolean = { true }, progress: (String, GenerationJob) -> Unit = { _, _ -> }): Int {
        val done = HashSet<String>()
        var submitted = 0
        while (true) {
            val round = apps().filter { it !in done }.sorted()
            if (round.isEmpty()) return submitted
            for (appId in round) {
                if (!keepGoing() || !mayClaim()) return submitted
                if (appId !in apps()) continue
                val window = now() + NetworkRetry.REQUEST_WINDOW_MS
                val job = retrying({ window }, keepGoing) { client.claim(appId, listOf(synth.model)) }
                if (job == null) { done += appId; continue }
                progress(appId, job)
                if (process(appId, job) { keepGoing() && appId in apps() }) submitted++ else done += appId
            }
        }
    }
    /** Copies the server's verdicts on [appId]'s submissions into the log, retrying a transient failure for a while. */
    fun refresh(appId: String, keepGoing: () -> Boolean) {
        val window = now() + NetworkRetry.REQUEST_WINDOW_MS
        retrying({ window }, keepGoing) { client.refresh(appId, log) }
    }
    /**
     * [call], tried again after [NetworkRetry]'s wait (then [beforeRetry]) while [keepGoing] and the wait ends before
     * [until]; otherwise its failure is thrown.
     */
    private fun <T> retrying(until: () -> Long, keepGoing: () -> Boolean, beforeRetry: () -> Unit = {}, call: () -> T): T {
        var attempt = 0
        while (true) {
            try { return call() } catch (e: Exception) {
                val wait = NetworkRetry.delayMs(e, attempt++) ?: throw e
                if (!keepGoing() || now() + wait >= until()) throw e
                sleep(wait)
                beforeRetry()
            }
        }
    }
    private fun process(appId: String, job: GenerationJob, keepGoing: () -> Boolean): Boolean {
        val handled = log.handled(job.id)
        GenerationPolicy.refusal(job, synth, handled, now())?.let { reason ->
            if (!handled) log.record(Contribution(job.id, appId, job.key, now(), "skipped", reason))
            return false
        }
        val file = File(workDir, "contribution.m4a")
        val lease = Lease(appId, job)
        try {
            val segments = narrate(job, file, lease, keepGoing)
            if (segments == null) {
                log.record(Contribution(job.id, appId, job.key, now(), "skipped", if (keepGoing()) "lease_expired" else "stopped"))
                return false
            }
            val meta = JSONObject().put("segments", segments)
            lease.renew()
            val refusal = when {
                file.length() > job.maxBytes || meta.toString().toByteArray().size > GenerationPolicy.MAX_META_BYTES -> "too_large"
                !lease.held -> "lease_expired"
                else -> null
            }
            if (refusal != null) { log.record(Contribution(job.id, appId, job.key, now(), "skipped", refusal)); return false }
            // Recorded before the upload starts, so a crash mid-upload can never lead to a second, different file.
            log.record(Contribution(job.id, appId, job.key, now(), "uploading"))
            // The same file, again, while the lease (extended as it runs low) still leaves time to upload (#819).
            retrying({ lease.deadline }, keepGoing, beforeRetry = lease::renew) {
                client.submit(appId, job, file, GenerationPolicy.CONTENT_TYPE, meta, attestation.token(appId, job))
            }
            log.updateStatus(job.id, "pending", "")
            return true
        } catch (e: Exception) {
            if (DeviceConnection.expired(e)) throw e
            val uploading = log.handled(job.id) // the only network call after this is recorded is the upload
            val reason = if (uploading && NetworkRetry.delayMs(e, 0) != null) NetworkRetry.REASON
                else ((e as? ApiFailure)?.let { "${it.status} " } ?: "") + (e.message ?: e.javaClass.simpleName)
            if (uploading) log.updateStatus(job.id, "failed", reason.take(120))
            else log.record(Contribution(job.id, appId, job.key, now(), "failed", reason.take(120)))
            return false
        } finally { file.delete() }
    }
    /**
     * The job's own input, verbatim: the only text this path can generate. Narrated a sentence at a time as Books does
     * (#785), the sentences joined by its pauses, each one encoded into [file] as soon as it is synthesized (#793).
     * Returns `[charStart, charEnd, startSec, endSec]` for each sentence, or null when stopped or the lease ran out.
     */
    private fun narrate(job: GenerationJob, file: File, lease: Lease, keepGoing: () -> Boolean): JSONArray? {
        val segments = JSONArray()
        var sink: AudioSink? = null
        var rate = 24_000
        var length = 0
        var pause = 0 // written before the next sentence, so none follows the last
        try {
            val language = checkNotNull(synth.language(job.params, job.language))
            for (s in Sentences.split(job.text, language)) {
                lease.renew()
                val audio = synth.synthesize(job.text.substring(s.start, s.end), job.params, language) { keepGoing() && lease.held } ?: return null
                if (audio.samples.isEmpty()) continue // nothing to say, e.g. "* * *"
                val out = sink ?: encoder(file, audio.sampleRate).also { sink = it; rate = audio.sampleRate }
                if (pause > 0) { out.write(FloatArray(pause)); length += pause }
                segments.put(JSONArray().put(s.start).put(s.end).put(seconds(length, rate)).put(seconds(length + audio.samples.size, rate)))
                out.write(audio.samples)
                length += audio.samples.size
                pause = ((if (s.endsParagraph) GenerationPolicy.PARAGRAPH_PAUSE else GenerationPolicy.SENTENCE_PAUSE) * rate).toInt()
            }
            val short = (GenerationPolicy.MIN_SECONDS * rate).toInt() - length
            if (short > 0) sink?.write(FloatArray(short))
            (sink ?: encoder(file, rate).also { sink = it }).finish()
            return segments
        } finally { sink?.close() }
    }
    private fun seconds(samples: Int, rate: Int) = Math.round(samples * 1000.0 / rate) / 1000.0

    /**
     * The job's lease while this phone works on it (#783): extended between sentences once within
     * [GenerationPolicy.EXTEND_WITHIN_MS] of expiry. `403` means it is gone, so the job stops; `409` means it is at its
     * cap, so the work goes on only while it lasts. Any other failure is tried again after the next sentence.
     */
    private inner class Lease(private val appId: String, private val job: GenerationJob) {
        private var expiresAt = job.leaseExpiresAt
        private var extendable = true
        /** The last moment an upload may start. */
        val deadline get() = expiresAt - GenerationPolicy.LEASE_MARGIN_MS
        /** Whether there is still time to finish and upload. */
        val held get() = now() < deadline
        fun renew() {
            if (!extendable || now() < expiresAt - GenerationPolicy.EXTEND_WITHIN_MS) return
            try { expiresAt = client.extend(appId, job) } catch (e: Exception) {
                if (DeviceConnection.expired(e)) throw e
                when ((e as? ApiFailure)?.status) { 403 -> expiresAt = 0; 409 -> extendable = false }
            }
        }
    }
}
