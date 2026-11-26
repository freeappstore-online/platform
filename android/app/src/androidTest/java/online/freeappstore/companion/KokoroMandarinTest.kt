package online.freeappstore.companion

import android.media.MediaExtractor
import android.media.MediaFormat
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * #812: Dialogue's Mandarin lines through the real Kokoro model, sentence splitter and AAC encoder, as the contribute
 * loop runs them. Needs the unpacked model, which CI doesn't have, so it is skipped there. To run it, with the debug app
 * installed: `adb push kokoro-multi-lang-v1_0 /data/local/tmp/` (espeak-ng-data is not needed), then
 * `adb shell "run-as online.freeappstore.companion sh -c 'mkdir -p files/kokoro-test && cp -r /data/local/tmp/kokoro-multi-lang-v1_0 files/kokoro-test/'"`
 * and `./gradlew connectedDebugAndroidTest`. The audio is left in `files/kokoro-test/out/` to listen to or transcribe.
 */
class KokoroMandarinTest {
    private val files = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "kokoro-test")
    private val out = File(files, "out")
    private val jobs = ArrayDeque<JSONObject>()
    private val api = object : FasApi() {
        override fun request(method: String, path: String, token: String?, body: JSONObject?) =
            jobs.removeFirstOrNull()?.let { JSONObject().put("job", it) } ?: JSONObject()
        override fun upload(method: String, path: String, token: String, headers: Map<String, String>, file: File, contentType: String, meta: JSONObject?): JSONObject {
            val id = path.split("/")[5]
            file.copyTo(File(out, "$id.m4a"), overwrite = true)
            File(out, "$id.json").writeText(meta.toString())
            return JSONObject().put("submissionId", id)
        }
    }
    private val log = object : ContributionLog {
        override fun handled(jobId: String) = false
        override fun record(contribution: Contribution) { assertEquals(contribution.reason, "uploading", contribution.status) }
        override fun updateStatus(jobId: String, status: String, reason: String, server: ServerVerdict?) {}
    }
    private fun job(id: String, text: String, voice: String, language: String?) = JSONObject().put("id", id).put("setId", "s").put("key", id)
        .put("input", JSONObject().put("text", text)).put("model", "kokoro").put("modelVersion", "v1.0").put("params", JSONObject().put("voice", voice))
        .put("formats", JSONArray().put("audio/mp4")).put("maxBytes", 1_000_000).put("language", language ?: JSONObject.NULL)
        .put("leaseToken", "l").put("leaseExpiresAt", System.currentTimeMillis() + 15 * 60_000)
    private fun durationMs(file: File): Long = MediaExtractor().run {
        setDataSource(file.path); val ms = getTrackFormat(0).getLong(MediaFormat.KEY_DURATION) / 1000; release(); ms
    }

    @Test fun speaksDialogueLinesInMandarin() {
        val model = KokoroModel(files)
        assumeTrue("the model is not on this device", File(model.root, "model.onnx").isFile)
        out.mkdirs()
        val lines = listOf(
            Triple("dui", "对。", "zf_xiaobei"), Triple("thanks", "好的，谢谢。", "zm_yunxi"),
            Triple("toilet", "请问，洗手间在哪里？", "zf_xiaobei"), Triple("full", "今天已经满了，最早是明天。要帮您约吗？", "zf_xiaobei"),
            Triple("line8", "八号线。八，八。", "zm_yunxi"), Triple("times", "可以约的时间有三个：明天两点、明天四点半、后天十点。", "zf_xiaobei"),
        )
        for ((id, text, voice) in lines) jobs += job(id, text, voice, "zh")
        jobs += job("digits", "我要3杯咖啡，2026年11月26日。", "zf_xiaobei", "zh-Hans")
        jobs += job("english", "It was a bright cold day in April.", "af_heart", null) // the engine switches back
        val done = KokoroSynthesizer(model).use { synth ->
            Contributor(GenerationClient(api) { "t" }, log, synth, ::AacEncoder, InstrumentationRegistry.getInstrumentation().targetContext.cacheDir)
                .run({ setOf("dialogue") }, { true })
        }
        assertEquals(lines.size + 2, done)
        for ((id, text) in lines.map { it.first to it.second } + ("digits" to "我要3杯咖啡，2026年11月26日。")) {
            val ms = durationMs(File(out, "$id.m4a"))
            // generation-verify.ts for zh: 2-9 characters a second, and audio up to 3 s is never too long.
            assertTrue("$id: $ms ms", text.length / (ms / 1000.0) <= 9 && (ms <= 3000 || text.length / (ms / 1000.0) >= 2))
        }
        assertEquals(2, JSONObject(File(out, "line8.json").readText()).getJSONArray("segments").length())
    }
}
