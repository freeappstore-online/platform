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
        val languages = mutableListOf<Language>()
        override fun accepts(params: JSONObject) = KokoroModel.params(params) != null
        override fun language(params: JSONObject, language: String?) = KokoroModel.language(params, language)
        override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio? {
            spoken += text; languages += language
            return if (stop || !keepGoing()) null else Audio(FloatArray(text.length), 24_000)
        }
    }
    /** Writes a byte per sample, so a file's size is its length in samples. */
    class FakeSink(file: File, val rate: Int) : AudioSink {
        private val out = file.outputStream()
        val writes = mutableListOf<Int>()
        var finished = false
        var closed = false
        override fun write(samples: FloatArray) { writes += samples.size; out.write(ByteArray(samples.size) { 7 }) }
        override fun finish() { finished = true }
        override fun close() { closed = true; out.close() }
    }
    private val sinks = mutableListOf<FakeSink>()
    private val encoder = { file: File, rate: Int -> FakeSink(file, rate).also { sinks += it } }
    private fun job(id: String, text: String = "It was a bright cold day in April.", model: String = "kokoro", version: String = "v1.0",
                    params: JSONObject = JSONObject().put("voice", "af_heart"), formats: List<String> = listOf("audio/mp4"),
                    maxBytes: Long = 1_000_000, expires: Any = now + 15 * 60_000, input: JSONObject = JSONObject().put("text", text), language: String? = null) =
        JSONObject().put("id", id).put("setId", "set1").put("key", "book/$id").put("input", input).put("model", model).put("modelVersion", version)
            .put("params", params).put("formats", JSONArray(formats)).put("maxBytes", maxBytes).put("language", language ?: JSONObject.NULL)
            .put("leaseToken", "lease-$id").put("leaseExpiresAt", expires)
    private fun contributor(attestation: Attestation = Attestation.NONE, clock: () -> Long = { now }) =
        Contributor(GenerationClient(api) { "ndev_test" }, log, synth, encoder, dir, attestation, clock)

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
        assertEquals("padded with silence to MIN_SECONDS", 24_000, upload.bytes.size)
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
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio? { t += 15 * 60_000; return if (keepGoing()) Audio(FloatArray(1), 24_000) else null }
        }
        Contributor(GenerationClient(api) { "ndev_test" }, log, slow, encoder, dir, now = { t }).run("books", { true })
        assertTrue(api.uploads.isEmpty())
        assertEquals("lease_expired", log.rows["j1"]!!.reason)
    }
    @Test fun stoppingEndsTheRunWithoutUploading() {
        api.jobs += job("j1")
        var go = true
        val stopping = object : Synthesizer by synth {
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio? { go = false; return if (keepGoing()) Audio(FloatArray(1), 24_000) else null }
        }
        Contributor(GenerationClient(api) { "ndev_test" }, log, stopping, encoder, dir, now = { now }).run("books", { go })
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
            s(124, 129, true), s(131, 134, true)), Sentences.split(en, Language.ENGLISH))
        val es = "—¿Quién es? —dijo el Sr. Pérez. Nadie respondió.\n\nD. Juan llegó. —Hola —dijo. ¡Ya!"
        assertEquals(listOf(s(0, 31, false), s(32, 48, true), s(50, 64, false), s(65, 77, false), s(78, 82, true)), Sentences.split(es, Language.SPANISH))
        assertTrue(Sentences.split(" \n\n ", Language.ENGLISH).isEmpty())
    }
    /** #812: Dialogue's lines (web/src/dialogue/phrases.json and scenarios); offsets are UTF-16 code units. */
    @Test fun splitsMandarinSentences() {
        fun s(start: Int, end: Int, paragraph: Boolean = false) = Sentences.Sentence(start, end, paragraph)
        fun split(text: String) = Sentences.split(text, Language.MANDARIN)
        assertEquals(listOf(s(0, 2, true)), split("对。"))
        assertEquals(listOf(s(0, 4), s(4, 8, true)), split("八号线。八，八。"))
        assertEquals(listOf(s(0, 6), s(6, 13, true)), split("三点以后……四点半可以吗？"))
        assertEquals(listOf(s(0, 15), s(15, 23, true)), split("不好意思，明天上午已经约满了。下午两点可以吗？"))
        assertEquals(listOf(s(0, 9), s(9, 12, true)), split("二号口，出去左转。谢谢！"))
        assertEquals("no comma or colon ends one", listOf(s(0, 26, true)), split("可以约的时间有三个：明天两点、明天四点半、后天十点。"))
        assertEquals(listOf(s(0, 3), s(3, 6, true)), split("好的；谢谢。"))
        assertEquals("closing quotes stay; ASCII marks; a decimal point", listOf(s(0, 7), s(7, 10), s(10, 13), s(13, 18, true)),
            split("他说：“好。”好的!谢谢?3.5元。"))
        assertEquals("spaces and paragraphs", listOf(s(0, 3), s(4, 7, true), s(9, 12, true)), split("你好！ 谢谢。\n\n再见。"))
        assertEquals("a character outside the BMP is two code units", listOf(s(0, 4), s(4, 7, true)), split("𠀀好。你好！"))
    }
    @Test fun kokoroLanguageFromTheSetOrTheVoice() {
        fun lang(voice: String, tag: String?) = KokoroModel.language(JSONObject().put("voice", voice), tag)
        assertEquals(Language.MANDARIN, lang("zf_xiaobei", "zh"))
        assertEquals(Language.MANDARIN, lang("zm_yunxi", "zh-Hans"))
        assertEquals(Language.MANDARIN, lang("zm_yunxi", "ZH-cn"))
        assertEquals("no language: by voice", Language.MANDARIN, lang("zf_xiaobei", null))
        assertEquals(Language.SPANISH, lang("ef_dora", null))
        assertEquals(Language.SPANISH, lang("em_alex", "es-MX"))
        assertEquals(Language.ENGLISH, lang("af_heart", null))
        assertEquals(Language.ENGLISH, lang("bm_george", "en-GB"))
        assertEquals("unchanged for sets naming no language", Language.ENGLISH, lang("ff_siwis", null))
        for ((voice, tag) in listOf("af_heart" to "zh", "zf_xiaobei" to "en", "zf_xiaobei" to "yue", "jf_alpha" to "ja", "ff_siwis" to "fr",
            "ff_siwis" to "en", "ef_dora" to "en", "af_heart" to "es")) assertNull("$voice $tag", lang(voice, tag))
        assertNull(KokoroModel.language(JSONObject(), null))
        assertEquals("zh-Hans", GenerationClient.parseJob(job("j1", language = "zh-Hans")).language)
        assertNull(GenerationClient.parseJob(job("j1")).language)
        assertNull("absent, as before #810", GenerationClient.parseJob(job("j1").apply { remove("language") }).language)
    }
    @Test fun mandarinSetsAreSpokenAMandarinSentenceAtATime() {
        api.jobs += job("j1", "一号线，三站。明白了，谢谢！", params = JSONObject().put("voice", "zm_yunxi"), language = "zh")
        api.jobs += job("j2", "请问，洗手间在哪里？", params = JSONObject().put("voice", "zf_xiaobei")) // no language: the voice says
        assertEquals(2, contributor().run("books", { true }))
        assertEquals(listOf("一号线，三站。", "明白了，谢谢！", "请问，洗手间在哪里？"), synth.spoken)
        assertEquals(List(3) { Language.MANDARIN }, synth.languages)
        val segments = api.uploads[0].meta!!.getJSONArray("segments")
        assertEquals(listOf(0 to 7, 7 to 14), (0 until segments.length()).map { segments.getJSONArray(it).let { s -> s.getInt(0) to s.getInt(1) } })
    }
    @Test fun skipsSetsInALanguageItCannotSpeak() {
        val cases = listOf(job("a", "你好！", language = "zh"), job("b", "こんにちは。", params = JSONObject().put("voice", "jf_alpha"), language = "ja"),
            job("c", "你好！", params = JSONObject().put("voice", "zf_xiaobei"), language = "yue"),
            job("d", "Hello.", params = JSONObject().put("voice", "zf_xiaobei"), language = "en"))
        for (j in cases) {
            api.jobs.clear(); api.jobs += j
            assertEquals(0, contributor().run("books", { true }))
            assertEquals(j.getString("id"), "language", log.rows[j.getString("id")]!!.reason)
        }
        assertTrue(synth.spoken.isEmpty())
        assertTrue(api.uploads.isEmpty())
    }
    @Test fun aTwoCharacterPhrasePassesTheServerDurationChecks() {
        api.jobs += job("j1", "对。", params = JSONObject().put("voice", "zf_xiaobei"), language = "zh")
        val short = object : Synthesizer by synth { // Kokoro says 对。 in about a quarter of a second
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean) = Audio(FloatArray(6_000), 24_000)
        }
        assertEquals(1, Contributor(GenerationClient(api) { "ndev_test" }, log, short, encoder, dir, now = { now }).run("books", { true }))
        val upload = api.uploads.single()
        val seconds = upload.bytes.size / 24_000.0
        assertEquals("the speech, then silence to a second", 1.0, seconds, 0.0)
        assertEquals(listOf(6_000, 18_000), sinks.single().writes)
        // generation-verify.ts: at most 9 characters a second for zh, and audio up to 3 s is never too long.
        assertTrue("对。".length / seconds <= 9 && seconds <= 3)
        assertEquals("[[0,2,0,0.25]]", upload.meta!!.getJSONArray("segments").toString())
    }
    @Test fun narratesASentenceAtATimeAndSendsBooksTimings() {
        api.jobs += job("j1", text = "One two. Three!\n\n* * *\n\nFour.")
        val tenthPerChar = object : Synthesizer by synth { // 0.1 s per character, nothing for "* * *"
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio {
                synth.spoken += text; return Audio(FloatArray(if (text == "* * *") 0 else text.length * 2_400), 24_000)
            }
        }
        Contributor(GenerationClient(api) { "ndev_test" }, log, tenthPerChar, encoder, dir, now = { now }).run("books", { true })
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
        // Each sentence and pause goes to the encoder as it comes (#793), never the chapter joined in memory.
        val sink = sinks.single()
        assertEquals(24_000, sink.rate)
        assertEquals(listOf(19_200, 9_600, 14_400, 19_200, 12_000), sink.writes)
        assertTrue(sink.finished && sink.closed)
    }
    @Test fun metaOverTheServerLimitIsNotSubmitted() {
        api.jobs += job("j1", text = "Go. ".repeat(4_000).trim(), maxBytes = Long.MAX_VALUE)
        val tiny = object : Synthesizer by synth { // 10 Hz keeps the audio small; 4,000 segments are about 100 KB of JSON
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean) = Audio(FloatArray(1), 10)
        }
        assertEquals(0, Contributor(GenerationClient(api) { "ndev_test" }, log, tiny, encoder, dir, now = { now }).run("books", { true }))
        assertTrue(api.uploads.isEmpty())
        assertEquals("too_large", log.rows["j1"]!!.reason)
    }

    private var t = now
    /** A job of [sentences] sentences, each taking [minutes] of the 15-minute lease to say. */
    private fun timedRun(sentences: Int, minutes: Int): Int {
        api.jobs += job("j1", text = (1..sentences).joinToString(" ") { "Sentence $it." })
        val timed = object : Synthesizer by synth {
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio? {
                synth.spoken += text; t += minutes * 60_000L; return if (keepGoing()) Audio(FloatArray(1), 24_000) else null
            }
        }
        return Contributor(GenerationClient(api) { "ndev_test" }, log, timed, encoder, dir, now = { t }).run("books", { true })
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
        val sink = sinks.single() // stopped part-way: the encoder is closed unfinished and its file removed
        assertTrue(sink.closed && !sink.finished)
        assertFalse(File(dir, "contribution.m4a").exists())
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
    /** #806: plugged in, not charging, so a full battery on the charger keeps going; unplugged stops unless any time is allowed. */
    @Test fun runsWhilePluggedInEvenWhenFull() {
        val ac = android.os.BatteryManager.BATTERY_PLUGGED_AC
        for (plugged in listOf(ac, android.os.BatteryManager.BATTERY_PLUGGED_USB, android.os.BatteryManager.BATTERY_PLUGGED_WIRELESS, 8)) {
            assertTrue("plugged $plugged", ContributePower.mayRun(anyTime = false, plugged = plugged))
        }
        assertFalse("on battery", ContributePower.mayRun(anyTime = false, plugged = 0))
        assertTrue("any time", ContributePower.mayRun(anyTime = true, plugged = 0))
    }
    /** #806: Run now or a settings change while a run is working never replaces or reschedules it. */
    @Test fun aRunningContributionIsNeverReplaced() {
        assertEquals(androidx.work.ExistingPeriodicWorkPolicy.KEEP to androidx.work.ExistingWorkPolicy.KEEP, ContributeWorker.policies(now = true, running = true))
        assertEquals(androidx.work.ExistingPeriodicWorkPolicy.KEEP to androidx.work.ExistingWorkPolicy.KEEP, ContributeWorker.policies(now = false, running = true))
        assertEquals(androidx.work.ExistingPeriodicWorkPolicy.UPDATE to androidx.work.ExistingWorkPolicy.REPLACE, ContributeWorker.policies(now = true, running = false))
        assertEquals(androidx.work.ExistingPeriodicWorkPolicy.KEEP, ContributeWorker.policies(now = false, running = false).first)
    }
    /** #806: the network is checked before each claim, not as a WorkManager constraint that stops a job part-way. */
    @Test fun networkIsCheckedBeforeEachClaimOnly() {
        assertTrue(ContributePower.mayClaim(anyTime = false, connected = true, unmetered = true))
        assertFalse("metered", ContributePower.mayClaim(anyTime = false, connected = true, unmetered = false))
        assertTrue("metered, any time", ContributePower.mayClaim(anyTime = true, connected = true, unmetered = false))
        assertFalse("offline", ContributePower.mayClaim(anyTime = true, connected = false, unmetered = false))
        api.jobs += job("j1"); api.jobs += job("j2")
        var online = true
        val dropsDuringTheJob = object : Synthesizer by synth {
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio? { online = false; return synth.synthesize(text, params, language, keepGoing) }
        }
        val n = Contributor(GenerationClient(api) { "ndev_test" }, log, dropsDuringTheJob, encoder, dir, now = { now }).run("books", { true }, mayClaim = { online })
        assertEquals("the job in hand finishes and uploads; no second claim", 1, n)
        assertEquals(1, api.claims.size)
    }
    @Test fun downloadProgressShowsBytesAndPercent() {
        assertEquals("0 of 349 MB (0%)", KokoroModel.progress(0))
        assertEquals("120 of 349 MB (34%)", KokoroModel.progress(120_000_000))
        assertEquals("349 of 349 MB (100%)", KokoroModel.progress(KokoroModel.DOWNLOAD_BYTES))
    }
    @Test fun recentResultsSayAStoppedJobIsNotRetried() {
        fun c(status: String, reason: String = "") = contributionDetail(Contribution("j", "books", "k", now, status, reason))
        assertEquals("stopped · not retried on this phone", c("skipped", "stopped"))
        assertEquals("409 Lease expired. · not retried on this phone", c("failed", "409 Lease expired."))
        assertEquals("transcript_mismatch", c("rejected", "transcript_mismatch"))
        assertEquals("", c("accepted"))
        assertFalse("no possessive on the app name", contributeDisclosure("Books").contains("Books's"))
        assertTrue(contributeDisclosure("Books").contains("jobs from Books"))
    }
    @Test fun pinnedModel() {
        assertTrue(KokoroModel.URL.startsWith("https://github.com/k2-fsa/sherpa-onnx/releases/download/"))
        assertTrue(Regex("^[0-9a-f]{64}$").matches(KokoroModel.SHA256))
    }
}
