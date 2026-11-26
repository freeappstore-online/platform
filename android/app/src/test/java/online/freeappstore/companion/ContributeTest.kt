package online.freeappstore.companion

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.MessageDigest
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorOutputStream
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** #731: the contribute loop against a fake API, the job policy, Kokoro params and the model install. */
class ContributeTest {
    private val now = 1_000_000_000_000L
    private lateinit var dir: File
    private val log = FakeLog()
    private val api = FakeApi()
    private val synth = FakeSynth()

    class FakeLog : ContributionLog {
        val rows = LinkedHashMap<String, Contribution>()
        override fun handled(jobId: String) = jobId in rows
        override fun record(contribution: Contribution) { rows[contribution.jobId] = contribution }
        override fun updateStatus(jobId: String, status: String, reason: String) { rows[jobId]?.let { rows[jobId] = it.copy(status = status, reason = reason) } }
    }
    class Upload(val path: String, val token: String, val headers: Map<String, String>, val bytes: ByteArray, val contentType: String, val meta: JSONObject?)
    inner class FakeApi : FasApi() {
        val jobs = ArrayDeque<JSONObject>()
        val claims = mutableListOf<JSONObject>()
        val uploads = mutableListOf<Upload>()
        var uploadFailure: Exception? = null
        var submissions = JSONArray()
        /** Lease extensions asked for (path to `X-Lease-Token`), and what the next one answers: a new expiry or a failure. */
        val extensions = mutableListOf<Pair<String, String?>>()
        var extend: () -> Long = { error("no extension expected") }
        override fun post(path: String, token: String, headers: Map<String, String>): JSONObject {
            assertEquals("ndev_test", token)
            extensions += path to headers["X-Lease-Token"]
            return JSONObject().put("leaseExpiresAt", extend())
        }
        override fun request(method: String, path: String, token: String?, body: JSONObject?): JSONObject {
            assertEquals("ndev_test", token)
            return when {
                method == "POST" && path == "/apps/books/generation/claim" -> { claims += body!!; jobs.removeFirstOrNull()?.let { JSONObject().put("job", it) } ?: JSONObject() }
                method == "GET" && path == "/apps/books/generation/submissions" -> JSONObject().put("submissions", submissions)
                else -> error("unexpected $method $path")
            }
        }
        override fun upload(method: String, path: String, token: String, headers: Map<String, String>, file: File, contentType: String, meta: JSONObject?): JSONObject {
            uploadFailure?.let { throw it }
            assertEquals("PUT", method)
            uploads += Upload(path, token, headers, file.readBytes(), contentType, meta)
            return JSONObject().put("submissionId", "sub-${uploads.size}").put("status", "pending")
        }
    }
    class FakeSynth : Synthesizer {
        override val model = KokoroModel.ID
        val spoken = mutableListOf<String>()
        var stop = false
        override fun accepts(params: JSONObject) = KokoroModel.params(params) != null
        override fun synthesize(text: String, params: JSONObject, keepGoing: () -> Boolean): Audio? {
            spoken += text
            return if (stop || !keepGoing()) null else Audio(FloatArray(text.length), 24_000)
        }
    }
    private fun job(id: String, text: String = "It was a bright cold day in April.", model: String = "kokoro", version: String = "v1.0",
                    params: JSONObject = JSONObject().put("voice", "af_heart"), formats: List<String> = listOf("audio/mp4"),
                    maxBytes: Long = 1_000_000, expires: Any = now + 15 * 60_000, input: JSONObject = JSONObject().put("text", text)) =
        JSONObject().put("id", id).put("setId", "set1").put("key", "book/$id").put("input", input).put("model", model).put("modelVersion", version)
            .put("params", params).put("formats", JSONArray(formats)).put("maxBytes", maxBytes).put("leaseToken", "lease-$id").put("leaseExpiresAt", expires)
    private fun contributor(attestation: Attestation = Attestation.NONE, clock: () -> Long = { now }) =
        Contributor(GenerationClient(api) { "ndev_test" }, log, synth, { audio, file -> file.writeBytes(ByteArray(audio.samples.size) { 7 }) }, dir, attestation, clock)

    @Before fun setUp() { dir = Files.createTempDirectory("contribute").toFile() }

    @Test fun generatesExactlyTheClaimedInputAndSubmitsWithTheLease() {
        api.jobs += job("j1", "First chapter."); api.jobs += job("j2", "Second chapter.")
        assertEquals(2, contributor().run("books", { true }))
        assertEquals(listOf("First chapter.", "Second chapter."), synth.spoken)
        assertEquals(3, api.claims.size) // the third claim found nothing (204)
        assertEquals("kokoro", api.claims[0].getJSONArray("models").getJSONObject(0).getString("model"))
        assertEquals("v1.0", api.claims[0].getJSONArray("models").getJSONObject(0).getString("modelVersion"))
        val upload = api.uploads[0]
        assertEquals("/apps/books/generation/jobs/j1/result", upload.path)
        assertEquals("lease-j1", upload.headers["X-Lease-Token"])
        assertFalse("no attestation until #732", "X-Attestation" in upload.headers)
        assertEquals("audio/mp4", upload.contentType)
        assertEquals("First chapter.".length, upload.bytes.size)
        assertEquals("[[0,14,0,0.001]]", upload.meta!!.getJSONArray("segments").toString())
        assertEquals("pending", log.rows["j1"]!!.status)
        assertEquals("book/j1", log.rows["j1"]!!.key)
        assertFalse("the temp file is removed", File(dir, "contribution.m4a").exists())
    }
    @Test fun attestationHookAddsTheHeader() {
        api.jobs += job("j1")
        contributor(attestation = { app, j -> "token-$app-${j.id}" }).run("books", { true })
        assertEquals("token-books-j1", api.uploads.single().headers["X-Attestation"])
    }
    @Test fun refusesJobsItCannotHonourExactly() {
        val cases = mapOf(
            "model" to job("a", model = "piper"), "version" to job("b", version = "v0.19"), "format" to job("c", formats = listOf("audio/ogg")),
            "params" to job("d", params = JSONObject().put("voice", "af_heart").put("pitch", 2)), "voice" to job("e", params = JSONObject().put("voice", "nobody")),
            "input" to job("f", input = JSONObject().put("text", "x").put("extra", "y")), "blank" to job("g", text = " "),
            "lease" to job("h", expires = now + 1_000), "max" to job("i", maxBytes = 0),
        )
        for ((name, j) in cases) {
            api.jobs.clear(); api.jobs += j
            assertEquals(name, 0, contributor().run("books", { true }))
            assertEquals(name, "skipped", log.rows[j.getString("id")]!!.status)
        }
        assertTrue(synth.spoken.isEmpty())
        assertTrue(api.uploads.isEmpty())
        assertEquals("model", log.rows["a"]!!.reason)
        assertEquals("params", log.rows["e"]!!.reason)
        assertEquals("input", log.rows["f"]!!.reason)
    }
    @Test fun neverUploadsTwiceForOneJob() {
        log.record(Contribution("j1", "books", "book/j1", now, "uploading"))
        api.jobs += job("j1")
        assertEquals(0, contributor().run("books", { true }))
        assertTrue(api.uploads.isEmpty())
        assertTrue(synth.spoken.isEmpty())
        assertEquals("uploading", log.rows["j1"]!!.status) // untouched
    }
    @Test fun tooLargeIsNotSubmitted() {
        api.jobs += job("j1", text = "A long sentence here.", maxBytes = 5)
        assertEquals(0, contributor().run("books", { true }))
        assertTrue(api.uploads.isEmpty())
        assertEquals("too_large", log.rows["j1"]!!.reason)
    }
    @Test fun leaseRunningOutDuringGenerationStops() {
        var t = now
        api.jobs += job("j1")
        // The clock passes the lease margin before generation ends.
        val slow = object : Synthesizer by synth {
            override fun synthesize(text: String, params: JSONObject, keepGoing: () -> Boolean): Audio? { t += 15 * 60_000; return if (keepGoing()) Audio(FloatArray(1), 24_000) else null }
        }
        Contributor(GenerationClient(api) { "ndev_test" }, log, slow, { _, f -> f.writeBytes(ByteArray(1)) }, dir, now = { t }).run("books", { true })
        assertTrue(api.uploads.isEmpty())
        assertEquals("lease_expired", log.rows["j1"]!!.reason)
    }
    @Test fun stoppingEndsTheRunWithoutUploading() {
        api.jobs += job("j1")
        var go = true
        val stopping = object : Synthesizer by synth {
            override fun synthesize(text: String, params: JSONObject, keepGoing: () -> Boolean): Audio? { go = false; return if (keepGoing()) Audio(FloatArray(1), 24_000) else null }
        }
        Contributor(GenerationClient(api) { "ndev_test" }, log, stopping, { _, f -> f.writeBytes(ByteArray(1)) }, dir, now = { now }).run("books", { go })
        assertTrue(api.uploads.isEmpty())
        assertEquals("stopped", log.rows["j1"]!!.reason)
    }
    @Test fun uploadFailureIsRecordedAndEndsTheRun() {
        api.jobs += job("j1"); api.jobs += job("j2")
        api.uploadFailure = ApiFailure(409, "Lease expired.")
        assertEquals(0, contributor().run("books", { true }))
        assertEquals("failed", log.rows["j1"]!!.status)
        assertEquals("409 Lease expired.", log.rows["j1"]!!.reason)
        assertNull(log.rows["j2"])
    }
    @Test fun expiredConnectionIsThrown() {
        api.jobs += job("j1")
        api.uploadFailure = ApiFailure(401, "expired")
        assertThrows(ApiFailure::class.java) { contributor().run("books", { true }) }
    }
    @Test fun splitsSentencesLikeBooks() {
        // Expected: Books' scripts/audio/segments.py (`sentences`, then `utf16`) on the same texts.
        fun s(start: Int, end: Int, paragraph: Boolean) = Sentences.Sentence(start, end, paragraph)
        val en = "Mr. Brown met L. Frank Baum.  “Oh dear!” said the Rabbit. It was I.\n\nA new paragraph… Then more?! Yes 😀 indeed. (Quite.)\n \n* * *\n\nEnd"
        assertEquals(listOf(s(0, 28, false), s(30, 57, false), s(58, 67, true), s(69, 85, false), s(86, 97, false), s(98, 112, false), s(113, 121, true),
            s(124, 129, true), s(131, 134, true)), Sentences.split(en, spanish = false))
        val es = "—¿Quién es? —dijo el Sr. Pérez. Nadie respondió.\n\nD. Juan llegó. —Hola —dijo. ¡Ya!"
        assertEquals(listOf(s(0, 31, false), s(32, 48, true), s(50, 64, false), s(65, 77, false), s(78, 82, true)), Sentences.split(es, spanish = true))
        assertTrue(Sentences.split(" \n\n ", spanish = false).isEmpty())
        assertTrue(KokoroModel.spanish(JSONObject().put("voice", "ef_dora")))
        assertFalse(KokoroModel.spanish(JSONObject().put("voice", "af_heart")))
    }
    @Test fun narratesASentenceAtATimeAndSendsBooksTimings() {
        api.jobs += job("j1", text = "One two. Three!\n\n* * *\n\nFour.")
        val tenthPerChar = object : Synthesizer by synth { // 0.1 s per character, nothing for "* * *"
            override fun synthesize(text: String, params: JSONObject, keepGoing: () -> Boolean): Audio {
                synth.spoken += text; return Audio(FloatArray(if (text == "* * *") 0 else text.length * 2_400), 24_000)
            }
        }
        Contributor(GenerationClient(api) { "ndev_test" }, log, tenthPerChar, { a, f -> f.writeBytes(ByteArray(a.samples.size)) }, dir, now = { now }).run("books", { true })
        assertEquals(listOf("One two.", "Three!", "* * *", "Four."), synth.spoken)
        // 0.8 s, 0.4 s pause, 0.6 s, 0.8 s paragraph pause, "* * *" left out, 0.5 s; no pause at the end.
        val segments = api.uploads.single().meta!!.getJSONArray("segments")
        val expected = listOf(listOf(0, 8, 0.0, 0.8), listOf(9, 15, 1.2, 1.8), listOf(24, 29, 2.6, 3.1))
        assertEquals(expected.size, segments.length())
        for ((i, e) in expected.withIndex()) {
            val got = segments.getJSONArray(i)
            assertEquals(e, listOf(got.getInt(0), got.getInt(1), got.getDouble(2), got.getDouble(3)))
        }
        assertEquals(3.1 * 24_000, api.uploads.single().bytes.size.toDouble(), 0.5)
    }
    @Test fun metaOverTheServerLimitIsNotSubmitted() {
        api.jobs += job("j1", text = "Go. ".repeat(4_000).trim(), maxBytes = Long.MAX_VALUE)
        val tiny = object : Synthesizer by synth { // 10 Hz keeps the audio small; 4,000 segments are about 100 KB of JSON
            override fun synthesize(text: String, params: JSONObject, keepGoing: () -> Boolean) = Audio(FloatArray(1), 10)
        }
        assertEquals(0, Contributor(GenerationClient(api) { "ndev_test" }, log, tiny, { a, f -> f.writeBytes(ByteArray(a.samples.size)) }, dir, now = { now }).run("books", { true }))
        assertTrue(api.uploads.isEmpty())
        assertEquals("too_large", log.rows["j1"]!!.reason)
    }

    private var t = now
    /** A job of [sentences] sentences, each taking [minutes] of the 15-minute lease to say. */
    private fun timedRun(sentences: Int, minutes: Int): Int {
        api.jobs += job("j1", text = (1..sentences).joinToString(" ") { "Sentence $it." })
        val timed = object : Synthesizer by synth {
            override fun synthesize(text: String, params: JSONObject, keepGoing: () -> Boolean): Audio? {
                synth.spoken += text; t += minutes * 60_000L; return if (keepGoing()) Audio(FloatArray(1), 24_000) else null
            }
        }
        return Contributor(GenerationClient(api) { "ndev_test" }, log, timed, { a, f -> f.writeBytes(ByteArray(a.samples.size)) }, dir, now = { t }).run("books", { true })
    }
    @Test fun extendsTheLeaseWithinFiveMinutesOfExpiry() {
        api.extend = { t + 15 * 60_000 }
        // 6 min a sentence: the lease is extended before the third (3 min left) and lasts to the upload.
        assertEquals(1, timedRun(sentences = 3, minutes = 6))
        assertEquals(listOf("/apps/books/generation/jobs/j1/lease" to "lease-j1"), api.extensions)
        assertEquals("pending", log.rows["j1"]!!.status)
    }
    @Test fun aLeaseTheServerRefusesStopsWithoutUploading() {
        api.extend = { throw ApiFailure(403, "Lease expired.") }
        assertEquals(0, timedRun(sentences = 6, minutes = 2))
        assertEquals(1, api.extensions.size)
        assertTrue(api.uploads.isEmpty())
        assertEquals("lease_expired", log.rows["j1"]!!.reason)
    }
    @Test fun aLeaseAtItsCapIsUsedWhileItLasts() {
        api.extend = { throw ApiFailure(409, "Lease cap reached.") }
        assertEquals(1, timedRun(sentences = 6, minutes = 2)) // done at 12 of 15 minutes
        assertEquals("no retry after 409", 1, api.extensions.size)
    }
    @Test fun otherExtensionFailuresAreRetriedAndDoNotStop() {
        api.extend = { throw ApiFailure(500, "Try again.") }
        assertEquals(1, timedRun(sentences = 6, minutes = 2))
        assertEquals("before the last sentence and before the upload", 2, api.extensions.size)
    }
    @Test fun anExpiredConnectionWhileExtendingIsThrown() {
        api.extend = { throw ApiFailure(401, "expired") }
        assertThrows(ApiFailure::class.java) { timedRun(sentences = 6, minutes = 2) }
    }
    @Test fun refreshCopiesVerdicts() {
        log.record(Contribution("j1", "books", "book/j1", now, "pending"))
        log.record(Contribution("j2", "books", "book/j2", now, "pending"))
        api.submissions = JSONArray().put(JSONObject().put("submissionId", "s1").put("jobId", "j1").put("status", "rejected").put("reason", "transcript_mismatch"))
            .put(JSONObject().put("jobId", "other").put("status", "accepted"))
            .put(JSONObject().put("id", "s2").put("jobId", "j2").put("status", "accepted").put("reason", JSONObject.NULL).put("createdAt", now))
        GenerationClient(api) { "ndev_test" }.refresh("books", log)
        assertEquals("rejected", log.rows["j1"]!!.status)
        assertEquals("transcript_mismatch", log.rows["j1"]!!.reason)
        assertNull("only this phone's jobs", log.rows["other"])
        assertEquals(Contribution("j2", "books", "book/j2", now, "accepted", ""), log.rows["j2"]) // reason null (#727 comment)
    }
    @Test fun parsesIsoLeaseExpiryAndRejectsOddJobIds() {
        val parsed = GenerationClient.parseJob(job("j1", expires = "2026-11-26T12:00:00Z"))
        assertEquals(java.time.Instant.parse("2026-11-26T12:00:00Z").toEpochMilli(), parsed.leaseExpiresAt)
        assertThrows(IllegalArgumentException::class.java) { GenerationClient.parseJob(job("../native/device")) }
    }
    @Test fun apiOnlyLetsTheCredentialReachNativeAndGenerationRoutes() {
        val real = FasApi()
        for (path in listOf("/auth/me", "/apps/books/photos", "/apps/../native/x/generation/claim", "/apps/Books/generation/claim")) {
            assertThrows(path, IllegalArgumentException::class.java) { real.request("GET", path, "t") }
        }
    }
    @Test fun kokoroParams() {
        assertEquals(3 to 1f, KokoroModel.params(JSONObject().put("voice", "af_heart")))
        assertEquals(53 to 1.25f, KokoroModel.params(JSONObject().put("voice", "em_santa").put("speed", 1.25)))
        assertNull(KokoroModel.params(JSONObject()))
        assertNull(KokoroModel.params(JSONObject().put("voice", "af_heart").put("speed", 3)))
        assertNull(KokoroModel.params(JSONObject().put("voice", "af_heart").put("speed", "fast")))
        assertNull(KokoroModel.params(JSONObject().put("voice", 3)))
        assertEquals(54, KokoroModel.VOICES.size)
    }

    private fun archive(vararg entries: Pair<String, String>): File = File(dir, "model.tar.bz2").also { f ->
        TarArchiveOutputStream(BZip2CompressorOutputStream(f.outputStream())).use { tar ->
            for ((name, body) in entries) {
                val bytes = body.toByteArray()
                tar.putArchiveEntry(TarArchiveEntry(name).apply { size = bytes.size.toLong() }); tar.write(bytes); tar.closeArchiveEntry()
            }
        }
    }
    private fun sha(f: File) = MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) }

    @Test fun modelInstallsOnlyWhenTheChecksumMatches() {
        val source = archive("kokoro-multi-lang-v1_0/model.onnx" to "weights", "kokoro-multi-lang-v1_0/tokens.txt" to "a 1")
        val model = KokoroModel(File(dir, "kokoro"))
        assertThrows(IOException::class.java) { model.install(source = source.toURI().toURL(), sha256 = "0".repeat(64)) }
        assertFalse(model.installed)
        assertFalse(File(dir, "kokoro").exists())
        assertTrue(model.install(source = source.toURI().toURL(), sha256 = sha(source)))
        assertTrue(model.installed)
        assertEquals("weights", File(model.root, "model.onnx").readText())
        model.delete()
        assertFalse(model.installed)
    }
    @Test fun modelInstallRefusesPathsOutsideItsFolder() {
        val source = archive("../escape.txt" to "x")
        val model = KokoroModel(File(dir, "kokoro"))
        assertThrows(IOException::class.java) { model.install(source = source.toURI().toURL(), sha256 = sha(source)) }
        assertFalse(File(dir, "escape.txt").exists())
        assertFalse(model.installed)
    }
    @Test fun modelInstallCanBeStopped() {
        val source = archive("kokoro-multi-lang-v1_0/model.onnx" to "weights")
        val model = KokoroModel(File(dir, "kokoro"))
        assertFalse(model.install(source = source.toURI().toURL(), sha256 = sha(source), keepGoing = { false }))
        assertFalse(model.installed)
    }
    @Test fun pinnedModel() {
        assertTrue(KokoroModel.URL.startsWith("https://github.com/k2-fsa/sherpa-onnx/releases/download/"))
        assertTrue(Regex("^[0-9a-f]{64}$").matches(KokoroModel.SHA256))
    }
}
