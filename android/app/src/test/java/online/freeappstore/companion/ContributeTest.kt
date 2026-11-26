package online.freeappstore.companion

import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
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
        val attempts = LinkedHashMap<String, JSONObject>()
        override fun attempt(jobId: String, record: JSONObject) { attempts[jobId] = record }
        override fun handled(jobId: String) = jobId in rows
        override fun record(contribution: Contribution) { rows[contribution.jobId] = contribution }
        override fun updateStatus(jobId: String, status: String, reason: String, server: ServerVerdict?) {
            rows[jobId]?.let { rows[jobId] = it.copy(status = status, reason = reason, wer = server?.wer ?: it.wer, durationMs = server?.durationMs ?: it.durationMs,
                artifactUrl = server?.artifactUrl ?: it.artifactUrl, metaUrl = server?.metaUrl ?: it.metaUrl) }
        }
    }
    class Upload(val path: String, val token: String, val headers: Map<String, String>, val bytes: ByteArray, val contentType: String, val meta: JSONObject?)
    inner class FakeApi : FasApi() {
        /** Books' open jobs; [appJobs] holds other apps'. */
        val jobs = ArrayDeque<JSONObject>()
        val appJobs = mutableMapOf<String, ArrayDeque<JSONObject>>()
        val claims = mutableListOf<JSONObject>()
        /** Each claim's app and the job it got, or null (204). */
        val claimed = mutableListOf<Pair<String, String?>>()
        val uploads = mutableListOf<Upload>()
        var uploadFailure: Exception? = null
        /** Failures thrown, one per attempt, before the calls go through (#819). */
        val uploadFailures = ArrayDeque<Exception>()
        val claimFailures = ArrayDeque<Exception>()
        var uploadAttempts = 0
        var submissions = JSONArray()
        /** Attempt records sent (#827), and what each upload does to the clock first. */
        val events = mutableListOf<JSONObject>()
        var onUpload: () -> Unit = {}
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
            val claim = Regex("^/apps/([a-z]+)/generation/claim$").find(path)?.groupValues?.get(1)
            return when {
                method == "POST" && claim != null -> {
                    claimFailures.removeFirstOrNull()?.let { throw it }
                    claims += body!!
                    val job = (if (claim == "books") jobs else appJobs.getOrPut(claim) { ArrayDeque() }).removeFirstOrNull()
                    claimed += claim to job?.getString("id")
                    job?.let { JSONObject().put("job", it) } ?: JSONObject()
                }
                method == "GET" && path == "/apps/books/generation/submissions" -> JSONObject().put("submissions", submissions)
                method == "POST" && path.matches(Regex("^/apps/[a-z]+/generation/events$")) -> {
                    val list = body!!.getJSONArray("events")
                    (0 until list.length()).forEach { events += list.getJSONObject(it) }
                    JSONObject().put("recorded", list.length())
                }
                else -> error("unexpected $method $path")
            }
        }
        override fun upload(method: String, path: String, token: String, headers: Map<String, String>, file: File, contentType: String, meta: JSONObject?): JSONObject {
            uploadAttempts++
            onUpload()
            uploadFailures.removeFirstOrNull()?.let { throw it }
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
    private val books = { setOf("books") }
    /** The test clock; a retry's wait moves it on, and is recorded in [sleeps]. */
    private var t = now
    private val sleeps = mutableListOf<Long>()
    private val sleep = { ms: Long -> sleeps += ms; t += ms }
    private fun contributor(attestation: Attestation = Attestation.NONE) =
        Contributor(GenerationClient(api) { "ndev_test" }, log, synth, encoder, dir, attestation, { t }, sleep)

    @Before fun setUp() { dir = Files.createTempDirectory("contribute").toFile() }

    @Test fun generatesExactlyTheClaimedInputAndSubmitsWithTheLease() {
        api.jobs += job("j1", "First chapter."); api.jobs += job("j2", "Second chapter.")
        assertEquals(2, contributor().run(books, { true }))
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
        contributor(attestation = { app, j -> "token-$app-${j.id}" }).run(books, { true })
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
            assertEquals(name, 0, contributor().run(books, { true }))
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
        assertEquals(0, contributor().run(books, { true }))
        assertTrue(api.uploads.isEmpty())
        assertTrue(synth.spoken.isEmpty())
        assertEquals("uploading", log.rows["j1"]!!.status) // untouched
        assertTrue("an attempt already on the record is not sent again", api.events.isEmpty())
    }
    @Test fun tooLargeIsNotSubmitted() {
        api.jobs += job("j1", text = "A long sentence here.", maxBytes = 5)
        assertEquals(0, contributor().run(books, { true }))
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
        Contributor(GenerationClient(api) { "ndev_test" }, log, slow, encoder, dir, now = { t }).run(books, { true })
        assertTrue(api.uploads.isEmpty())
        assertEquals("lease_expired", log.rows["j1"]!!.reason)
    }
    @Test fun stoppingEndsTheRunWithoutUploading() {
        api.jobs += job("j1")
        var go = true
        val stopping = object : Synthesizer by synth {
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio? { go = false; return if (keepGoing()) Audio(FloatArray(1), 24_000) else null }
        }
        Contributor(GenerationClient(api) { "ndev_test" }, log, stopping, encoder, dir, now = { now }).run(books, { go })
        assertTrue(api.uploads.isEmpty())
        assertEquals("stopped", log.rows["j1"]!!.reason)
    }
    @Test fun uploadFailureIsRecordedAndEndsTheRun() {
        api.jobs += job("j1"); api.jobs += job("j2")
        api.uploadFailure = ApiFailure(409, "Lease expired.")
        assertEquals(0, contributor().run(books, { true }))
        assertEquals("failed", log.rows["j1"]!!.status)
        assertEquals("409 Lease expired.", log.rows["j1"]!!.reason)
        assertNull(log.rows["j2"])
        assertEquals("server_4xx", api.events.single().getString("reason"))
        assertEquals("online.freeappstore.companion.ApiFailure: Lease expired.", api.events.single().getString("error"))
    }
    @Test fun expiredConnectionIsThrown() {
        api.jobs += job("j1")
        api.uploadFailure = ApiFailure(401, "expired")
        assertThrows(ApiFailure::class.java) { contributor().run(books, { true }) }
    }
    /** #819: a network blip after generating no longer loses the work. */
    @Test fun transientUploadFailuresAreRetriedWithTheSameFile() {
        api.jobs += job("j1", "First chapter.")
        api.uploadFailures += listOf(UnknownHostException("Unable to resolve host \"api.freeappstore.online\""), SocketTimeoutException("timeout"),
            SocketException("Connection reset"), ApiFailure(503, "Unavailable."))
        assertEquals(1, contributor().run(books, { true }))
        assertEquals("generated once", listOf("First chapter."), synth.spoken)
        assertEquals(5, api.uploadAttempts)
        assertEquals("bounded backoff", listOf(2_000L, 4_000L, 8_000L, 16_000L), sleeps)
        assertEquals("one upload, the generated file", 24_000, api.uploads.single().bytes.size)
        assertEquals("pending", log.rows["j1"]!!.status)
        assertFalse(File(dir, "contribution.m4a").exists())
    }
    @Test fun anUploadThatNeverGetsThroughStopsBeforeTheLeaseEndsAsNetwork() {
        api.jobs += job("j1")
        api.uploadFailure = UnknownHostException("api.freeappstore.online")
        api.extend = { throw ApiFailure(409, "Lease cap reached.") }
        assertEquals(0, contributor().run(books, { true }))
        assertTrue(api.uploadAttempts > 5)
        assertTrue("never past the lease margin", t < now + 15 * 60_000 - GenerationPolicy.LEASE_MARGIN_MS)
        assertTrue(sleeps.all { it <= NetworkRetry.MAX_MS })
        assertEquals(Contribution("j1", "books", "book/j1", now, "failed", "network", "It was a bright cold day in April.", 1_000, 24_000),
            log.rows["j1"]!!.copy(at = now))
        assertFalse("the file is removed once given up", File(dir, "contribution.m4a").exists())
        assertEquals("network", api.events.single().getString("reason"))
        api.uploadFailure = null; api.jobs += job("j1")
        assertEquals("never generated or uploaded again", 0, contributor().run(books, { true }))
        assertEquals(1, synth.spoken.size)
        assertTrue(api.uploads.isEmpty())
    }
    @Test fun a429IsRetriedOnlyWhenItSaysWhen() {
        api.jobs += job("j1")
        api.uploadFailures += ApiFailure(429, "Slow down.", retryAfterMs = 7_000)
        assertEquals(1, contributor().run(books, { true }))
        assertEquals(listOf(7_000L), sleeps)
        api.jobs += job("j2")
        api.uploadFailure = ApiFailure(429, "daily contribution limit reached; try tomorrow")
        assertEquals(0, contributor().run(books, { true }))
        assertEquals(3, api.uploadAttempts)
        assertEquals("429 daily contribution limit reached; try tomorrow", log.rows["j2"]!!.reason)
        assertEquals(1_000L, FasApi.retryAfterMs("1", 0))
        assertEquals(90_000L, FasApi.retryAfterMs("Thu, 26 Nov 2026 12:01:30 GMT", java.time.Instant.parse("2026-11-26T12:00:00Z").toEpochMilli()))
        assertNull(FasApi.retryAfterMs("soon", 0))
        assertNull(FasApi.retryAfterMs(null, 0))
    }
    @Test fun claimsAreRetriedForAWhileThenTheRunEnds() {
        api.jobs += job("j1")
        api.claimFailures += ConnectException("Connection refused")
        assertEquals(1, contributor().run(books, { true }))
        assertEquals(listOf(2_000L), sleeps)
        repeat(20) { api.claimFailures += UnknownHostException("api.freeappstore.online") }
        val from = t
        assertThrows(UnknownHostException::class.java) { contributor().run(books, { true }) }
        assertTrue(t - from < NetworkRetry.REQUEST_WINDOW_MS)
        assertThrows("a final failure is not retried", ApiFailure::class.java) {
            api.claimFailures.clear(); api.claimFailures += ApiFailure(400, "invalid claim"); contributor().run(books, { true })
        }
    }
    /** #819: one job from each opted-in app in turn, skipping apps with no work, instead of draining one app first. */
    @Test fun takesOneJobFromEachAppInTurn() {
        api.jobs += listOf(job("b1"), job("b2"), job("b3"))
        api.appJobs["dialogue"] = ArrayDeque(listOf(job("d1"), job("d2")))
        var apps = setOf("books", "chess", "dialogue")
        val order = mutableListOf<String>()
        val n = contributor().run({ apps }, { true }, progress = { app, job -> order += "$app/${job.id}"; if (job.id == "d2") apps = apps - "dialogue" })
        assertEquals(listOf("books/b1", "dialogue/d1", "books/b2", "dialogue/d2", "books/b3"), order)
        assertEquals("d2 stopped: dialogue was turned off while it ran", 4, n)
        assertEquals(listOf("books" to "b1", "chess" to null, "dialogue" to "d1", "books" to "b2", "dialogue" to "d2", "books" to "b3", "books" to null), api.claimed)
        assertEquals("stopped", log.rows["d2"]!!.reason)
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
        assertEquals(2, contributor().run(books, { true }))
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
            assertEquals(0, contributor().run(books, { true }))
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
        assertEquals(1, Contributor(GenerationClient(api) { "ndev_test" }, log, short, encoder, dir, now = { now }).run(books, { true }))
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
        Contributor(GenerationClient(api) { "ndev_test" }, log, tenthPerChar, encoder, dir, now = { now }).run(books, { true })
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
        assertEquals(0, Contributor(GenerationClient(api) { "ndev_test" }, log, tiny, encoder, dir, now = { now }).run(books, { true }))
        assertTrue(api.uploads.isEmpty())
        assertEquals("too_large", log.rows["j1"]!!.reason)
    }

    /** A job of [sentences] sentences, each taking [minutes] of the 15-minute lease to say. */
    private fun timedRun(sentences: Int, minutes: Int): Int {
        api.jobs += job("j1", text = (1..sentences).joinToString(" ") { "Sentence $it." })
        val timed = object : Synthesizer by synth {
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio? {
                synth.spoken += text; t += minutes * 60_000L; return if (keepGoing()) Audio(FloatArray(1), 24_000) else null
            }
        }
        return Contributor(GenerationClient(api) { "ndev_test" }, log, timed, encoder, dir, now = { t }, sleep = sleep).run(books, { true })
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
        assertEquals("lease_403", api.events.single().getString("reason"))
        val sink = sinks.single() // stopped part-way: the encoder is closed unfinished and its file removed
        assertTrue(sink.closed && !sink.finished)
        assertFalse(File(dir, "contribution.m4a").exists())
    }
    @Test fun aLeaseAtItsCapIsUsedWhileItLasts() {
        api.extend = { throw ApiFailure(409, "Lease cap reached.") }
        assertEquals(1, timedRun(sentences = 6, minutes = 2)) // done at 12 of 15 minutes
        assertEquals("submitted", api.events.single().getString("reason"))
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
        api.submissions = JSONArray().put(JSONObject().put("submissionId", "s1").put("jobId", "j1").put("status", "rejected").put("reason", "transcript_mismatch").put("wer", 0.42))
            .put(JSONObject().put("jobId", "other").put("status", "accepted"))
            .put(JSONObject().put("id", "s2").put("jobId", "j2").put("status", "accepted").put("reason", JSONObject.NULL).put("createdAt", now)
                .put("wer", JSONObject.NULL).put("durationMs", 2_400).put("input", JSONObject().put("text", "Whole text."))
                .put("artifact", JSONObject().put("url", "https://api.freeappstore.online/v1/apps/books/generation/artifacts/j2?v=ab").put("metaUrl", JSONObject.NULL)))
        GenerationClient(api) { "ndev_test" }.refresh("books", log)
        assertEquals("rejected", log.rows["j1"]!!.status)
        assertEquals("transcript_mismatch", log.rows["j1"]!!.reason)
        assertEquals("the error rate, when the server sends one (#820)", 0.42, log.rows["j1"]!!.wer!!, 0.0)
        assertNull("only this phone's jobs", log.rows["other"])
        assertEquals("reason null (#727 comment); #824's duration and artifact", Contribution("j2", "books", "book/j2", now, "accepted", "", durationMs = 2_400,
            artifactUrl = "https://api.freeappstore.online/v1/apps/books/generation/artifacts/j2?v=ab"), log.rows["j2"])
        assertEquals("Whole text.", GenerationClient(api) { "ndev_test" }.inputText("books", "j2"))
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
        assertEquals(androidx.work.ExistingPeriodicWorkPolicy.KEEP to androidx.work.ExistingWorkPolicy.KEEP, ContributeWorker.policies(running = true))
        // #828: otherwise the hourly work takes the current constraints, so an update's network constraint applies.
        assertEquals(androidx.work.ExistingPeriodicWorkPolicy.UPDATE to androidx.work.ExistingWorkPolicy.REPLACE, ContributeWorker.policies(running = false))
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
        val n = Contributor(GenerationClient(api) { "ndev_test" }, log, dropsDuringTheJob, encoder, dir, now = { now }).run(books, { true }, mayClaim = { online })
        assertEquals("the job in hand finishes and uploads; no second claim", 1, n)
        assertEquals(1, api.claims.size)
    }
    /** #828: a run Android kept out of the foreground stops claiming well before a plain job's ten minutes are up. */
    @Test fun aPlainJobClaimsOnlyEarlyInTheRun() {
        assertTrue(ContributeWorker.withinBudget(foreground = false, elapsedMs = 0))
        assertFalse(ContributeWorker.withinBudget(foreground = false, elapsedMs = ContributeWorker.PLAIN_CLAIM_MS))
        assertTrue("foreground", ContributeWorker.withinBudget(foreground = true, elapsedMs = 60 * 60_000L))
    }
    /** #828: the daily limit's 429 (no Retry-After) at the claim ends the run without generating anything. */
    @Test fun theDailyLimitAtTheClaimEndsTheRun() {
        api.jobs += job("j1")
        api.claimFailures += ApiFailure(429, "daily contribution limit reached; try tomorrow")
        val failure = runCatching { contributor().run(books, { true }) }.exceptionOrNull()
        assertEquals(429, (failure as ApiFailure).status)
        assertTrue("not retried", sleeps.isEmpty())
        assertTrue(synth.spoken.isEmpty()); assertEquals(0, api.uploadAttempts)
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
    /** #820: what the Activity detail and the status card show. */
    @Test fun theRecordKeepsThePreviewLengthAndSizeAndTheRunReportsSentences() {
        val text = "First sentence. Second one here. " + "X".repeat(300)
        api.jobs += job("j1", text)
        val heard = mutableListOf<Pair<Int, Int>>()
        assertEquals(1, contributor().run(books, { true }, sentence = { n, total, _ -> heard += n to total }))
        val row = log.rows["j1"]!!
        assertEquals(text.take(Contribution.PREVIEW), row.inputPreview)
        assertEquals(24_000L, row.bytes) // a byte per sample, padded to a second
        assertEquals(1_000L, row.durationMs)
        assertEquals(listOf(1 to 3, 2 to 3, 3 to 3), heard)
        api.jobs += job("j2", params = JSONObject().put("voice", "nobody"))
        contributor().run(books, { true })
        assertEquals("a skipped job keeps its preview too", "It was a bright cold day in April.", log.rows["j2"]!!.inputPreview)
        assertNull(log.rows["j2"]!!.bytes)
        assertEquals("Generating Books · b/1 · sentence 3 of 40 · 1.5× real time", contributeProgress("Generating Books · b/1", 3, 40, 6.0, 4.0))
        assertEquals("Generating Books · b/1 · sentence 1 of 40", contributeProgress("Generating Books · b/1", 1, 40, 0.0, 0.0))
    }
    @Test fun openJobsCountOnlySetsThisPhoneRuns() {
        fun set(open: Int, model: String = "kokoro", version: String = "v1.0", formats: List<String> = listOf("audio/mp4")) =
            JSONObject().put("setId", "s").put("model", model).put("modelVersion", version).put("formats", JSONArray(formats)).put("open", open)
        val body = JSONObject().put("apps", JSONArray()
            .put(JSONObject().put("appId", "books").put("sets", JSONArray().put(set(3)).put(set(4)).put(set(9, model = "piper"))))
            .put(JSONObject().put("appId", "dialogue").put("sets", JSONArray().put(set(5, version = "v1.1")).put(set(6, formats = listOf("audio/ogg"))))))
        assertEquals(mapOf("books" to 7, "dialogue" to 0), GenerationClient.parseOpen(body, KokoroModel.ID))
    }
    @Test fun segmentsComeFromThePublicMetaUrlOnly() {
        val paths = mutableListOf<Pair<String, String?>>()
        val meta = object : FasApi() {
            override fun request(method: String, path: String, token: String?, body: JSONObject?): JSONObject {
                paths += path to token
                return JSONObject().put("segments", JSONArray().put(JSONArray("[0,14,0,1.25]")).put(JSONArray("[15,30,1.65,3]")))
            }
        }
        val client = GenerationClient(meta) { "ndev_test" }
        assertEquals(listOf(Segment(0, 14, 0, 1_250), Segment(15, 30, 1_650, 3_000)),
            client.segments("https://api.freeappstore.online/v1/apps/books/generation/artifacts/j1/meta?v=ab"))
        assertEquals("public: no credential", listOf("/apps/books/generation/artifacts/j1/meta?v=ab" to null), paths)
        assertEquals("never another origin", emptyList<Segment>(), client.segments("https://example.com/v1/apps/books/generation/artifacts/j1/meta"))
    }
    @Test fun activityFiltersPutEachStatusUnderOne() {
        val of = listOf("accepted", "uploading", "pending", "rejected", "superseded", "skipped", "failed").associateWith { ContributionFilter.of(it) }
        assertEquals(mapOf("accepted" to ContributionFilter.ACCEPTED, "uploading" to ContributionFilter.CHECKING, "pending" to ContributionFilter.CHECKING,
            "rejected" to ContributionFilter.REJECTED, "superseded" to ContributionFilter.NOT_DONE, "skipped" to ContributionFilter.NOT_DONE,
            "failed" to ContributionFilter.NOT_DONE), of)
        assertTrue(of.keys.all { ContributionFilter.ALL.matches(it) })
        assertEquals("1:05", audioLength(65_000))
        assertEquals("0:01", audioLength(1_000))
        assertEquals("412 KB", byteSize(411_200))
        assertEquals("No open jobs", openJobsText(0))
        assertEquals("1 open job", openJobsText(1))
    }
    @Test fun theStatusCardSaysWhyItIsNotRunning() {
        val ready = CompanionState(signedIn = true, model = ModelState.INSTALLED, contributeApps = setOf("books"))
        fun why(s: CompanionState) = contributeStatus(s).second
        assertEquals("Running" to "Generating Books", contributeStatus(ready.copy(contributing = "Generating Books")))
        assertEquals("No voice model. Download it in Settings.", why(ready.copy(model = ModelState.NONE)))
        assertEquals("No apps turned on. Choose them in Settings.", why(ready.copy(contributeApps = emptySet())))
        assertEquals("Not plugged in. It runs while plugged in on Wi‑Fi.", why(ready.copy(plugged = false)))
        assertEquals("Not on Wi‑Fi. It runs while plugged in on Wi‑Fi.", why(ready.copy(unmetered = false)))
        assertEquals("No connection.", why(ready.copy(online = false, unmetered = false)))
        assertEquals("Idle", contributeStatus(ready.copy(contributeAnyTime = true, plugged = false, unmetered = false)).first)
    }
    @Test fun pinnedModel() {
        assertTrue(KokoroModel.URL.startsWith("https://github.com/k2-fsa/sherpa-onnx/releases/download/"))
        assertTrue(Regex("^[0-9a-f]{64}$").matches(KokoroModel.SHA256))
    }

    /** #827: each attempt's record, kept with the job's row and sent, with the time each stage took and the device's state. */
    @Test fun eachAttemptIsRecordedWithItsStageTimesAndSent() {
        api.jobs += job("j1", "One. Two.")
        var load = 300L
        val timed = object : Synthesizer by synth { // a second a sentence, the first loading the model for 0.3 s more
            override var loadedMs = 0L
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio {
                loadedMs = load; load = 0; t += 1_000 + loadedMs; return Audio(FloatArray(12_000), 24_000)
            }
        }
        val slow = { f: File, rate: Int -> val sink = encoder(f, rate); object : AudioSink by sink { override fun write(samples: FloatArray) { t += 50; sink.write(samples) } } }
        api.onUpload = { t += 700 }
        val cpu = ArrayDeque(listOf(100L, 2_600L))
        val readings = ArrayDeque(listOf(DeviceReading(80, true, "none"), DeviceReading(78, false, "light")))
        val memory = ArrayDeque(listOf(100L, 150L, 120L, 110L))
        val foreground = ArrayDeque(listOf(false, true))
        val probes = DeviceProbes(appVersion = "1.4 (40)", os = "Android 15 (API 35)", device = "Google Pixel 8", reading = { readings.removeFirst() },
            network = { "wifi" }, background = { foreground.removeFirstOrNull() ?: false }, cpuMs = { cpu.removeFirst() }, memMb = { memory.removeFirstOrNull() ?: 0 })
        val kept = KeptAudio(File(dir, "kept"))
        assertEquals(1, Contributor(GenerationClient(api) { "ndev_test" }, log, timed, slow, dir, now = { t }, sleep = sleep, probes = probes, kept = kept).run(books, { true }))
        val sent = api.events.single()
        assertEquals(mapOf("jobId" to "j1", "runner" to "android", "reason" to "submitted", "appVersion" to "1.4 (40)", "os" to "Android 15 (API 35)",
            "device" to "Google Pixel 8", "network" to "wifi", "thermalStart" to "none", "thermalEnd" to "light", "background" to true,
            "chargingStart" to true, "chargingEnd" to false, "batteryStart" to 80, "batteryEnd" to 78, "startedAt" to now,
            // 0.3 s load, 2 s synthesis, 3 encoder writes of 50 ms, 0.7 s upload; 0.5 s + 0.4 s pause + 0.5 s of audio
            "wallMs" to 3_150L, "loadMs" to 300L, "synthMs" to 2_000L, "encodeMs" to 150L, "uploadMs" to 700L, "cpuMs" to 2_500L, "peakMemMb" to 150L,
            "rtf" to 1.429, "bytes" to 33_600L, "durationMs" to 1_400L), sent.keys().asSequence().associateWith { sent.get(it) })
        assertSame("kept with the job's row", sent, log.attempts["j1"])
        assertEquals("the audio stays on the phone for playback", 33_600L, kept.audio("j1")!!.length())
        assertEquals("One. Two." to listOf(Segment(0, 4, 0, 500), Segment(5, 9, 900, 1_400)), kept.playback("j1"))
        assertFalse(File(dir, "contribution.m4a").exists())
    }
    @Test fun attemptEndsUseTheDiagnosticVocabulary() {
        assertEquals("too_large", AttemptReason.refusal("too_large"))
        assertEquals("lease_cap", AttemptReason.refusal("lease_expired"))
        for (code in listOf("model", "format", "input", "params", "language", "max_bytes")) assertEquals(code, "unsupported", AttemptReason.refusal(code))
        assertEquals("model_error", AttemptReason.failure(IllegalStateException("onnx"), Attempt.SYNTH))
        assertEquals("encode_error", AttemptReason.failure(IOException("codec"), Attempt.ENCODE))
        assertEquals("network", AttemptReason.failure(SocketTimeoutException("timeout"), Attempt.UPLOAD))
        assertEquals("lease_403", AttemptReason.failure(ApiFailure(403, "Lease expired."), Attempt.UPLOAD))
        assertEquals("server_4xx", AttemptReason.failure(ApiFailure(429, "Slow down."), Attempt.UPLOAD))
        assertEquals("server_5xx", AttemptReason.failure(ApiFailure(503, "Unavailable."), Attempt.UPLOAD))
        assertEquals("other", AttemptReason.failure(IllegalArgumentException("x"), Attempt.UPLOAD))
        // A refused job is sent as unsupported; a stop says why the worker stopped.
        api.jobs += job("a", model = "piper")
        contributor().run(books, { true })
        assertEquals("unsupported", api.events.single().getString("reason"))
        api.jobs += job("b")
        var go = true
        val stopping = object : Synthesizer by synth {
            override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio? { go = false; return if (keepGoing()) Audio(FloatArray(1), 24_000) else null }
        }
        Contributor(GenerationClient(api) { "ndev_test" }, log, stopping, encoder, dir, now = { now }, probes = DeviceProbes(stopReason = { "unplugged" })).run(books, { go })
        assertEquals("unplugged", api.events.last().getString("reason"))
        val broken = object : Synthesizer by synth { override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio? = error("model crashed") }
        api.jobs += job("c")
        Contributor(GenerationClient(api) { "ndev_test" }, log, broken, encoder, dir, now = { now }).run(books, { true })
        assertEquals("model_error", api.events.last().getString("reason"))
        assertEquals("java.lang.IllegalStateException: model crashed", api.events.last().getString("error"))
    }
    @Test fun aFailedSendNeverFailsTheJob() {
        api.jobs += job("j1")
        val noEvents = object : FasApi() {
            override fun request(method: String, path: String, token: String?, body: JSONObject?) =
                if (path.endsWith("/events")) throw ApiFailure(429, "Too many records.") else api.request(method, path, token, body)
            override fun upload(method: String, path: String, token: String, headers: Map<String, String>, file: File, contentType: String, meta: JSONObject?) =
                api.upload(method, path, token, headers, file, contentType, meta)
        }
        assertEquals(1, Contributor(GenerationClient(noEvents) { "ndev_test" }, log, synth, encoder, dir, now = { now }).run(books, { true }))
        assertEquals("pending", log.rows["j1"]!!.status)
        assertEquals("still kept on the phone", "submitted", log.attempts["j1"]!!.getString("reason"))
    }
    @Test fun keepsTheLatestAttemptsAudioOnly() {
        val kept = KeptAudio(File(dir, "kept"))
        for (i in 1..KeptAudio.KEEP + 2) {
            val f = File(dir, "a.m4a").apply { writeText("audio $i") }
            kept.save("j$i", f, "Text $i.", JSONArray().put(JSONArray("[0,7,0,0.5]")))
            File(dir, "kept/j$i.m4a").setLastModified(now + i * 1_000L)
        }
        assertNull(kept.audio("j1")); assertNull(kept.audio("j2")); assertNull(kept.playback("j2"))
        assertFalse(File(dir, "kept/j1.json").exists())
        assertEquals("audio 22", kept.audio("j22")!!.readText())
        assertEquals(KeptAudio.KEEP, File(dir, "kept").listFiles { f -> f.name.endsWith(".m4a") }!!.size)
    }
    @Test fun theDetailShowsTheAttemptNumbers() {
        val record = JSONObject().put("jobId", "j1").put("runner", "android").put("reason", "submitted").put("appVersion", "1.4 (40)")
            .put("network", "wifi").put("background", false).put("wallMs", 3_400).put("loadMs", 300).put("cpuMs", 950).put("rtf", 1.4286)
            .put("peakMemMb", 150).put("batteryStart", 80).put("chargingStart", true).put("thermalStart", "none").put("chargingEnd", false)
        assertEquals(listOf("Runner" to "android", "App version" to "1.4 (40)", "Network" to "wifi", "Ran" to "In the foreground",
            "End reason" to "submitted", "Wall time" to "3.4 s", "Model load" to "300 ms", "CPU time" to "950 ms", "Real-time factor" to "1.43",
            "Peak memory" to "150 MB", "At start" to "80% · charging · thermal none", "At end" to "on battery"), attemptLines(record))
    }
}
