package online.freeappstore.companion

import android.media.MediaExtractor
import android.media.MediaFormat
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** #798: speech is encoded as 32 kbps mono AAC-LC at Kokoro's 24 kHz, so a long chapter fits 25 MB. */
class AacEncoderTest {
    @Test fun encodesMono24kHzAt32Kbps() {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "aac-test.m4a")
        val seconds = 20
        AacEncoder(file, 24_000).use { sink ->
            repeat(seconds) { s -> sink.write(FloatArray(24_000) { i -> 0.5f * sin(2 * Math.PI * 220 * (s * 24_000 + i) / 24_000).toFloat() }) }
            sink.finish()
        }
        val format = MediaExtractor().run { setDataSource(file.path); getTrackFormat(0).also { release() } }
        assertEquals(MediaFormat.MIMETYPE_AUDIO_AAC, format.getString(MediaFormat.KEY_MIME))
        assertEquals(24_000, format.getInteger(MediaFormat.KEY_SAMPLE_RATE))
        assertEquals(1, format.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
        assertEquals(seconds * 1000.0, format.getLong(MediaFormat.KEY_DURATION) / 1000.0, 100.0)
        val kbps = file.length() * 8 / 1000.0 / seconds
        assertTrue("$kbps kbps", kbps in 24.0..40.0)
        file.delete()
    }
}
