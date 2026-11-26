package online.freeappstore.companion

import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import java.io.File
import java.io.IOException
import java.net.URL
import java.security.DigestInputStream
import java.security.MessageDigest
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import org.json.JSONObject

/**
 * Kokoro v1.0 (82M, multi-language) as packaged for sherpa-onnx (#731): the weights Books' CI narration uses
 * (`kokoro-v1.0.onnx`). Downloaded on demand from the pinned sherpa-onnx release asset, checked against its pinned
 * SHA-256 before anything is unpacked, and kept in no-backup storage under [dir].
 */
class KokoroModel(private val dir: File) {
    companion object {
        val ID = ModelId("kokoro", "v1.0")
        const val URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2"
        const val SHA256 = "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4"
        const val DOWNLOAD_BYTES = 349_886_476L
        const val INSTALLED_BYTES = 401_239_297L
        private const val ROOT = "kokoro-multi-lang-v1_0"
        /** Speaker ids of this model's `voices.bin`, from the sherpa-onnx model docs. */
        val VOICES = listOf(
            "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah",
            "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
            "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora", "em_alex",
            "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune", "jf_nezumi",
            "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa", "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian",
            "zm_yunxi", "zm_yunxia", "zm_yunyang", "em_santa",
        )
        /**
         * A job's `params` as (speaker id, speed): `{ voice }` (a name above) and optionally `{ speed }` (0.5-2, default
         * 1). Anything else, or a missing voice, returns null and the job is refused: never a guess.
         */
        fun params(params: JSONObject): Pair<Int, Float>? {
            if (params.keys().asSequence().any { it != "voice" && it != "speed" }) return null
            val sid = VOICES.indexOf(params.opt("voice") as? String ?: return null).takeIf { it >= 0 } ?: return null
            val speed = if (params.has("speed")) (params.opt("speed") as? Number)?.toFloat() ?: return null else 1f
            return if (speed in 0.5f..2f) sid to speed else null
        }
        /** Download progress for the screen (#806), such as "120 of 350 MB (34%)". */
        fun progress(bytes: Long, total: Long = DOWNLOAD_BYTES): String =
            "${bytes / 1_000_000} of ${total / 1_000_000} MB (${(bytes * 100 / total).coerceIn(0, 100)}%)"
        /**
         * How a job is spoken (#812). A set naming no language goes by the voice: Mandarin for `zf_`/`zm_`, Spanish for
         * `ef_`/`em_`, otherwise English sentences as before. A set naming one (#810) must be English (`en`, with an
         * `a…`/`b…` voice), Spanish (`es`, `e…`) or Mandarin (`zh`, e.g. `zh-Hans`, `z…`); anything else is null.
         */
        fun language(params: JSONObject, tag: String?): Language? {
            val voice = (params.opt("voice") as? String)?.firstOrNull() ?: return null
            val byVoice = when (voice) { 'z' -> Language.MANDARIN; 'e' -> Language.SPANISH; else -> Language.ENGLISH }
            val named = when (tag?.substringBefore('-')?.lowercase()) {
                null -> return byVoice
                "en" -> Language.ENGLISH.takeIf { voice == 'a' || voice == 'b' }
                "es" -> Language.SPANISH
                "zh" -> Language.MANDARIN
                else -> null
            }
            return named?.takeIf { it == byVoice }
        }
        /** Mandarin text normalisers in the model package: dates, phone numbers, then other numbers read as Chinese. */
        val MANDARIN_RULES = listOf("date-zh.fst", "phone-zh.fst", "number-zh.fst")
    }
    val root = File(dir, ROOT)
    private val marker = File(dir, "installed")
    val installed: Boolean get() = marker.isFile
    /** Downloads, verifies and unpacks. [progress] gets bytes downloaded. Returns false when [keepGoing] stopped it. */
    fun install(progress: (Long) -> Unit = {}, keepGoing: () -> Boolean = { true }, source: URL = URL(URL), sha256: String = SHA256): Boolean {
        if (installed) return true
        dir.deleteRecursively(); check(dir.mkdirs()) { "Could not create the model folder." }
        val archive = File(dir, "download.part")
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            val connection = source.openConnection().apply { connectTimeout = 15_000; readTimeout = 30_000 }
            DigestInputStream(connection.getInputStream(), digest).use { input ->
                archive.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024); var total = 0L; var last = 0L
                    while (true) {
                        if (!keepGoing()) return false
                        val n = input.read(buffer); if (n < 0) break
                        out.write(buffer, 0, n); total += n
                        if (total - last >= 4 * 1024 * 1024) { last = total; progress(total) }
                    }
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (actual != sha256) throw IOException("The voice model download did not match its checksum. Nothing was installed.")
            val base = dir.canonicalPath + File.separator
            TarArchiveInputStream(BZip2CompressorInputStream(archive.inputStream().buffered())).use { tar ->
                while (true) {
                    val entry = tar.nextEntry ?: break
                    val out = File(dir, entry.name).canonicalFile
                    if (!out.path.startsWith(base)) throw IOException("Unexpected path in the voice model.")
                    when {
                        entry.isDirectory -> out.mkdirs()
                        entry.isFile -> { out.parentFile?.mkdirs(); out.outputStream().use { tar.copyTo(it) } }
                        else -> throw IOException("Unexpected entry in the voice model.") // links and devices
                    }
                }
            }
            check(marker.createNewFile())
            return true
        } finally {
            archive.delete()
            if (!installed) dir.deleteRecursively()
        }
    }
    fun delete() { dir.deleteRecursively() }
}

/**
 * Kokoro through sherpa-onnx's offline TTS (JNI, CPU). Loads the model on first use; [close] frees it. Mandarin gets its
 * own engine with the Mandarin number and date rules (which would read digits in English text as Chinese), loaded in
 * place of the other one when the language changes.
 */
class KokoroSynthesizer(private val files: KokoroModel) : Synthesizer, AutoCloseable {
    override val model = KokoroModel.ID
    private var engine: Pair<Boolean, OfflineTts>? = null
    private fun tts(mandarin: Boolean): OfflineTts {
        engine?.let { (m, tts) -> if (m == mandarin) return tts; tts.release(); engine = null }
        return load(mandarin).also { engine = mandarin to it }
    }
    private fun load(mandarin: Boolean): OfflineTts {
        val root = files.root
        val kokoro = OfflineTtsKokoroModelConfig(
            model = File(root, "model.onnx").path, voices = File(root, "voices.bin").path, tokens = File(root, "tokens.txt").path,
            // No dataDir: sherpa-onnx 2.x ignores espeak-ng-data and phonemizes through the lexicons; Mandarin is
            // looked up in lexicon-zh character by character, longest phrase first (its `lang` is ignored too).
            lexicon = listOf("lexicon-us-en.txt", "lexicon-zh.txt").joinToString(",") { File(root, it).path },
            dictDir = File(root, "dict").takeIf { it.isDirectory }?.path ?: "",
        )
        val threads = Runtime.getRuntime().availableProcessors().coerceIn(1, 4)
        val rules = if (mandarin) KokoroModel.MANDARIN_RULES.joinToString(",") { File(root, it).path } else ""
        return OfflineTts(config = OfflineTtsConfig(model = OfflineTtsModelConfig(kokoro = kokoro, numThreads = threads), ruleFsts = rules))
    }
    override fun accepts(params: JSONObject) = KokoroModel.params(params) != null
    override fun language(params: JSONObject, language: String?) = KokoroModel.language(params, language)
    override fun synthesize(text: String, params: JSONObject, language: Language, keepGoing: () -> Boolean): Audio? {
        val (sid, speed) = KokoroModel.params(params) ?: return null
        val callback = TtsCallback(keepGoing)
        val audio = tts(language == Language.MANDARIN).generateWithCallback(text, sid, speed, callback)
        return if (callback.stopped) null else Audio(audio.samples, audio.sampleRate)
    }
    override fun close() { engine?.second?.release(); engine = null }
}

/**
 * Runs per generated chunk; returning 0 stops generation. A class, not a lambda: sherpa-onnx's JNI looks up
 * `invoke([F)Ljava/lang/Integer;`, which an invokedynamic lambda does not have (it aborted the process on a device).
 */
class TtsCallback(private val keepGoing: () -> Boolean) : (FloatArray) -> Int {
    var stopped = false
        private set
    override fun invoke(samples: FloatArray): Int = if (keepGoing()) 1 else { stopped = true; 0 }
}
