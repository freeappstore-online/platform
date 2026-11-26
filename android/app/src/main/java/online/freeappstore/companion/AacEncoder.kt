package online.freeappstore.companion

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteOrder

/**
 * Mono float PCM to AAC-LC in an MP4 (`.m4a`, `audio/mp4`) with the platform codec and muxer (#731), fed as the audio is
 * synthesized (#793) so a chapter is never held in memory whole.
 */
class AacEncoder(out: File, private val sampleRate: Int) : AudioSink {
    private companion object {
        /** Speech at 32 kbps mono (#798), so a long chapter fits a set's 25 MB. */
        const val BIT_RATE = 32_000
        const val TIMEOUT_US = 10_000L
    }
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    private val muxer = try { MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4) } catch (e: Exception) { codec.release(); throw e }
    private val info = MediaCodec.BufferInfo()
    private var track = -1
    private var written = 0L

    init {
        try {
            codec.configure(MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
            }, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
        } catch (e: Exception) { close(); throw e }
    }

    override fun write(samples: FloatArray) {
        var offset = 0
        while (offset < samples.size) {
            val index = codec.dequeueInputBuffer(TIMEOUT_US)
            if (index >= 0) {
                val buffer = codec.getInputBuffer(index)!!.apply { clear(); order(ByteOrder.LITTLE_ENDIAN) }
                val count = minOf(buffer.remaining() / 2, samples.size - offset)
                for (i in 0 until count) buffer.putShort((samples[offset + i].coerceIn(-1f, 1f) * Short.MAX_VALUE).toInt().toShort())
                codec.queueInputBuffer(index, 0, count * 2, presentationUs(), 0)
                offset += count; written += count
            }
            drain(0)
        }
    }

    override fun finish() {
        while (true) {
            val index = codec.dequeueInputBuffer(TIMEOUT_US)
            if (index >= 0) { codec.queueInputBuffer(index, 0, 0, presentationUs(), MediaCodec.BUFFER_FLAG_END_OF_STREAM); break }
            drain(0)
        }
        while (!drain(TIMEOUT_US)) { /* until the end of the stream comes out */ }
        check(track >= 0) { "The encoder produced no audio." }
        muxer.stop()
    }

    override fun close() { runCatching { codec.stop() }; codec.release(); runCatching { muxer.release() } }

    private fun presentationUs() = written * 1_000_000L / sampleRate

    /** Moves the encoded output that is ready into the muxer. True once the end of the stream has come out. */
    private fun drain(timeoutUs: Long): Boolean {
        while (true) {
            val index = codec.dequeueOutputBuffer(info, timeoutUs)
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) return false
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                track = muxer.addTrack(codec.outputFormat); muxer.start()
            } else if (index >= 0) {
                val data = codec.getOutputBuffer(index)!!
                if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0 // already in the track's format
                if (info.size > 0 && track >= 0) {
                    data.position(info.offset); data.limit(info.offset + info.size)
                    muxer.writeSampleData(track, data, info)
                }
                codec.releaseOutputBuffer(index, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return true
            }
        }
    }
}
