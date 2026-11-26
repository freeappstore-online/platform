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
    class Upload(val path: String, val token: String, val headers: Map<String, String>, val bytes: ByteArray, val contentType: String)
    inner class FakeApi : FasApi() {
        val jobs = ArrayDeque<JSONObject>()
        val claims = mutableListOf<JSONObject>()
        val uploads = mutableListOf<Upload>()
        var uploadFailure: Exception? = null
        var submissions = JSONArray()
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
            uploads += Upload(path, token, headers, file.readBytes(), contentType)
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
