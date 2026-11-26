import AudioToolbox
import Foundation

/// Mono float PCM to AAC-LC in an MP4 (`.m4a`, `audio/mp4`), 32 kbps (#798, so a long chapter at Kokoro's 24 kHz fits the
/// 25 MB cap), with ExtAudioFile (#733), as the Android companion's AacEncoder does with MediaCodec. Fed as the audio is
/// synthesized, so a chapter is never held in memory whole. Apple's software codec, so encoding never depends on the audio
/// hardware while the app is in the background.
final class AacEncoder: AudioSink {
    static let bitRate: UInt32 = 32_000
    private var file: ExtAudioFileRef?

    init(url: URL, sampleRate: Int) throws {
        var aac = AudioStreamBasicDescription(
            mSampleRate: Double(sampleRate), mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: UInt32(MPEG4ObjectID.AAC_LC.rawValue),
            mBytesPerPacket: 0, mFramesPerPacket: 1024, mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
        try Self.check(ExtAudioFileCreateWithURL(url as CFURL, kAudioFileM4AType, &aac, nil, AudioFileFlags.eraseFile.rawValue, &file))
        do {
            var software = kAppleSoftwareAudioCodecManufacturer
            try Self.check(ExtAudioFileSetProperty(file!, kExtAudioFileProperty_CodecManufacturer, UInt32(MemoryLayout.size(ofValue: software)), &software))
            var pcm = AudioStreamBasicDescription(
                mSampleRate: Double(sampleRate), mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
            try Self.check(ExtAudioFileSetProperty(file!, kExtAudioFileProperty_ClientDataFormat, UInt32(MemoryLayout.size(ofValue: pcm)), &pcm))
            var converter: AudioConverterRef?
            var size = UInt32(MemoryLayout<AudioConverterRef?>.size)
            try Self.check(ExtAudioFileGetProperty(file!, kExtAudioFileProperty_AudioConverter, &size, &converter))
            var rate = Self.bitRate
            try Self.check(AudioConverterSetProperty(converter!, kAudioConverterEncodeBitRate, UInt32(MemoryLayout.size(ofValue: rate)), &rate))
            var config: UnsafeRawPointer? // a NULL CFArrayRef: apply the bit rate set on the converter
            try Self.check(ExtAudioFileSetProperty(file!, kExtAudioFileProperty_ConverterConfig, UInt32(MemoryLayout<UnsafeRawPointer?>.size), &config))
        } catch { close(); throw error }
    }

    func write(_ samples: [Float]) throws {
        guard let file else { throw CompanionError("The audio encoder is closed.") }
        var samples = samples
        var offset = 0
        while offset < samples.count {
            let count = min(4096, samples.count - offset)
            let status = samples.withUnsafeMutableBufferPointer { buffer -> OSStatus in
                var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
                    mNumberChannels: 1, mDataByteSize: UInt32(count * 4), mData: UnsafeMutableRawPointer(buffer.baseAddress! + offset)))
                return ExtAudioFileWrite(file, UInt32(count), &list)
            }
            try Self.check(status)
            offset += count
        }
    }

    /// Flushes the encoder and writes the MP4 index.
    func finish() throws {
        guard let file else { throw CompanionError("The audio encoder is closed.") }
        self.file = nil
        try Self.check(ExtAudioFileDispose(file))
    }

    func close() {
        if let file { ExtAudioFileDispose(file) }
        file = nil
    }

    deinit { close() }

    private static func check(_ status: OSStatus) throws {
        guard status == noErr else { throw CompanionError("Could not encode the audio (\(status)).") }
    }
}
