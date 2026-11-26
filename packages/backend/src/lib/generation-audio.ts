/**
 * Container checks for community generation (#729): parse the bytes a device
 * uploaded, reject truncated or mislabelled files and measure the duration.
 * Structure only, not a full decoder.
 */
export type AudioType = 'audio/mp4' | 'audio/ogg' | 'audio/wav';

export interface ParsedAudio {
  type: AudioType;
  durationMs: number;
}

const str = (b: Uint8Array, p: number, n: number) => String.fromCharCode(...b.subarray(p, p + n));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export function parseAudio(b: Uint8Array): ParsedAudio {
  if (b.length >= 12 && str(b, 0, 4) === 'RIFF' && str(b, 8, 4) === 'WAVE') return wav(b);
  if (b.length >= 4 && str(b, 0, 4) === 'OggS') return ogg(b);
  if (b.length >= 8 && str(b, 4, 4) === 'ftyp') return mp4(b);
  throw new Error('not WAV, Ogg or MP4 audio');
}

function wav(b: Uint8Array): ParsedAudio {
  const v = view(b);
  if (v.getUint32(4, true) + 8 !== b.length) throw new Error('truncated WAV');
  let p = 12,
    fmt = -1,
    data = -1,
    dataSize = 0;
  while (p + 8 <= b.length) {
    const id = str(b, p, 4),
      size = v.getUint32(p + 4, true);
    if (p + 8 + size > b.length) throw new Error('truncated WAV');
    if (id === 'fmt ' && size >= 16) fmt = p + 8;
    if (id === 'data') {
      data = p;
      dataSize = size;
    }
    p += 8 + size + (size % 2);
  }
  if (fmt < 0 || data < 0) throw new Error('WAV without format or data');
  const format = v.getUint16(fmt, true),
    sampleRate = v.getUint32(fmt + 4, true),
    byteRate = v.getUint32(fmt + 8, true),
    blockAlign = v.getUint16(fmt + 12, true);
  if (
    ![1, 3, 0xfffe].includes(format) ||
    !sampleRate ||
    !blockAlign ||
    byteRate !== sampleRate * blockAlign
  )
    throw new Error('unsupported WAV format');
  return { type: 'audio/wav', durationMs: (dataSize / byteRate) * 1000 };
}

function ogg(b: Uint8Array): ParsedAudio {
  const v = view(b);
  const pages: { start: number; end: number; granule: number; flags: number }[] = [];
  let p = 0;
  while (p < b.length) {
    if (p + 27 > b.length || str(b, p, 4) !== 'OggS' || b[p + 4] !== 0)
      throw new Error('truncated or invalid Ogg');
    const segments = b[p + 26]!;
    if (p + 27 + segments > b.length) throw new Error('truncated Ogg');
    let body = 0;
    for (let i = 0; i < segments; i++) body += b[p + 27 + i]!;
    const end = p + 27 + segments + body;
    if (end > b.length) throw new Error('truncated Ogg');
    if (v.getUint32(p + 14, true) !== v.getUint32(14, true))
      throw new Error('multiplexed Ogg is not supported');
    pages.push({ start: p, end, granule: Number(v.getBigInt64(p + 6, true)), flags: b[p + 5]! });
    p = end;
  }
  const head = 27 + b[26]!;
  if (str(b, head, 8) !== 'OpusHead') throw new Error('only Opus audio in Ogg is supported');
  const preSkip = v.getUint16(head + 10, true);
  const last = pages.at(-1)!;
  if (!(last.flags & 4)) throw new Error('truncated Ogg (no end of stream)');
  // Header pages (OpusHead, OpusTags) carry granule 0; audio pages follow.
  const headers = pages.findIndex((page, i) => i > 0 && page.granule > 0);
  if (headers < 0) throw new Error('Ogg without audio');
  return { type: 'audio/ogg', durationMs: Math.max(0, last.granule - preSkip) / 48 };
}

interface Box {
  type: string;
  start: number;
  content: number;
  end: number;
}

/** The boxes directly inside [start, end), which they must tile exactly. */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const v = view(b);
  const out: Box[] = [];
  let p = start;
  while (p < end) {
    if (p + 8 > end) throw new Error('truncated MP4');
    let size = v.getUint32(p),
      header = 8;
    if (size === 1) {
      if (p + 16 > end) throw new Error('truncated MP4');
      size = Number(v.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) throw new Error('truncated MP4');
    out.push({ type: str(b, p + 4, 4), start: p, content: p + header, end: p + size });
    p += size;
  }
  return out;
}

function child(b: Uint8Array, box: Box | undefined, path: string[]): Box | undefined {
  let current = box;
  for (const type of path) {
    if (!current) return undefined;
    current = boxes(b, current.content, current.end).find((x) => x.type === type);
  }
  return current;
}

function mp4(b: Uint8Array): ParsedAudio {
  const v = view(b);
  const top = boxes(b, 0, b.length);
  const moov = top.find((x) => x.type === 'moov');
  if (top[0]?.type !== 'ftyp' || !moov || !top.some((x) => x.type === 'mdat'))
    throw new Error('MP4 without movie or media data');
  const mvhd = child(b, moov, ['mvhd']);
  if (!mvhd) throw new Error('MP4 without movie header');
  const v1 = b[mvhd.content] === 1;
  const timescale = v.getUint32(mvhd.content + (v1 ? 20 : 12));
  const duration = v1 ? Number(v.getBigUint64(mvhd.content + 24)) : v.getUint32(mvhd.content + 16);
  if (!timescale) throw new Error('MP4 without timescale');
  const trak = boxes(b, moov.content, moov.end).find((t) => {
    const hdlr = child(b, t, ['mdia', 'hdlr']);
    return t.type === 'trak' && hdlr && str(b, hdlr.content + 8, 4) === 'soun';
  });
  const stbl = child(b, trak, ['mdia', 'minf', 'stbl']);
  if (!trak || !stbl) throw new Error('MP4 without an audio track');
  const table = (type: string) => child(b, stbl, [type]);
  const mdhd = child(b, trak, ['mdia', 'mdhd'])!;
  const trackScale = v.getUint32(mdhd.content + (b[mdhd.content] === 1 ? 20 : 12));
  // Sample sizes, chunk layout and durations: every sample must lie inside the file.
  const stsz = table('stsz'),
    stsc = table('stsc'),
    stts = table('stts');
  const stco = table('stco') ?? table('co64');
  if (!stsz || !stsc || !stts || !stco || !trackScale)
    throw new Error('MP4 without a sample table');
  const count = v.getUint32(stsz.content + 8),
    fixed = v.getUint32(stsz.content + 4);
  const sizes = Array.from(
    { length: count },
    (_, i) => fixed || v.getUint32(stsz.content + 12 + 4 * i),
  );
  const chunks = v.getUint32(stco.content + 4);
  const runs = Array.from({ length: v.getUint32(stsc.content + 4) }, (_, i) => ({
    first: v.getUint32(stsc.content + 8 + 12 * i),
    samples: v.getUint32(stsc.content + 12 + 12 * i),
  }));
  const offsets: number[] = [];
  for (let c = 1, s = 0; c <= chunks && s < count; c++) {
    let at =
      stco.type === 'co64'
        ? Number(v.getBigUint64(stco.content + 8 * c))
        : v.getUint32(stco.content + 4 + 4 * c);
    const perChunk = runs.filter((r) => r.first <= c).at(-1)?.samples ?? 0;
    for (let i = 0; i < perChunk && s < count; i++, s++) {
      offsets.push(at);
      at += sizes[s]!;
    }
  }
  if (offsets.length !== count || offsets.some((o, i) => o + sizes[i]! > b.length))
    throw new Error('truncated MP4 media data');
  return { type: 'audio/mp4', durationMs: (duration / timescale) * 1000 };
}
