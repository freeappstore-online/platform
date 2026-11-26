package online.freeappstore.companion

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteOrder

/** Mono float PCM to AAC-LC in an MP4 (`.m4a`, `audio/mp4`) with the platform codec and muxer (#731). */
object AacEncoder {
    private const val BIT_RATE = 64_000
    private const val TIMEOUT_US = 10_000L
    fun encode(audio: Audio, out: File) {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, audio.sampleRate, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        val muxer = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var track = -1
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val samples = audio.samples
            val info = MediaCodec.BufferInfo()
            var offset = 0; var inputDone = false
            while (true) {
                if (!inputDone) {
                    val index = codec.dequeueInputBuffer(TIMEOUT_US)
                    if (index >= 0) {
                        val buffer = codec.getInputBuffer(index)!!.apply { clear(); order(ByteOrder.LITTLE_ENDIAN) }
                        val count = minOf(buffer.remaining() / 2, samples.size - offset)
                        for (i in 0 until count) buffer.putShort((samples[offset + i].coerceIn(-1f, 1f) * Short.MAX_VALUE).toInt().toShort())
                        val presentationUs = offset * 1_000_000L / audio.sampleRate
                        offset += count
                        inputDone = offset >= samples.size
                        codec.queueInputBuffer(index, 0, count * 2, presentationUs, if (inputDone) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
                    }
                }
                val index = codec.dequeueOutputBuffer(info, TIMEOUT_US)
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
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
            }
            check(track >= 0) { "The encoder produced no audio." }
            muxer.stop()
        } finally {
            runCatching { codec.stop() }; codec.release(); runCatching { muxer.release() }
        }
    }
}
