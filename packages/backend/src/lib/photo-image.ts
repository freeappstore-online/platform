/** Small, still images only. Strip metadata on the server as well as in the SDK. */
export const PHOTO_MAX_BYTES = 200_000;
export const PHOTO_MAX_EDGE = 640;
export const PHOTO_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface PhotoImage {
  bytes: Uint8Array;
  type: 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
}

function join(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function checked(
  bytes: Uint8Array,
  type: PhotoImage['type'],
  width: number,
  height: number,
): PhotoImage {
  if (!width || !height || Math.max(width, height) > PHOTO_MAX_EDGE) {
    throw new Error(`photos must be at most ${PHOTO_MAX_EDGE} pixels on either edge`);
  }
  return { bytes, type, width, height };
}

export function sanitizePhoto(b: Uint8Array): PhotoImage {
  if (!b.length || b.length > PHOTO_MAX_BYTES)
    throw new Error(`photo exceeds ${PHOTO_MAX_BYTES} bytes`);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0xff && b[1] === 0xd8) {
    const parts = [b.slice(0, 2)];
    let p = 2,
      width = 0,
      height = 0,
      scans = 0;
    while (p < b.length) {
      const start = p;
      if (b[p++] !== 0xff) throw new Error('invalid JPEG marker');
      while (b[p] === 0xff) p++;
      const marker = b[p++];
      if (marker === undefined) throw new Error('truncated JPEG marker');
      if (marker === 0xd9) {
        if (!scans || p !== b.length) throw new Error('invalid JPEG ending');
        parts.push(b.slice(start, p));
        return checked(join(parts), 'image/jpeg', width, height);
      }
      if (p + 2 > b.length) throw new Error('truncated JPEG');
      const size = v.getUint16(p);
      if (size < 2 || p + size > b.length) throw new Error('invalid JPEG segment');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8 || width) throw new Error('invalid JPEG frame');
        height = v.getUint16(p + 3);
        width = v.getUint16(p + 5);
      } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xcc].includes(marker)) {
        throw new Error('unsupported JPEG frame');
      }
      p += size;
      // APP0-15 and comments can contain GPS, EXIF, XMP or arbitrary data.
      if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) parts.push(b.slice(start, p));
      if (marker === 0xda) {
        scans++;
        const scan = p;
        while (p < b.length) {
          if (b[p] !== 0xff) {
            p++;
            continue;
          }
          if (b[p + 1] === 0 || ((b[p + 1] ?? 0) >= 0xd0 && (b[p + 1] ?? 0) <= 0xd7)) {
            p += 2;
            continue;
          }
          break;
        }
        parts.push(b.slice(scan, p));
      }
    }
    throw new Error('incomplete JPEG');
  }
  const str = (p: number, n: number) => String.fromCharCode(...b.slice(p, p + n));
  if (
    b.length >= 12 &&
    str(0, 4) === 'RIFF' &&
    str(8, 4) === 'WEBP' &&
    v.getUint32(4, true) + 8 === b.length
  ) {
    const parts = [b.slice(0, 12)];
    let p = 12,
      width = 0,
      height = 0,
      canvasWidth = 0,
      canvasHeight = 0;
    while (p < b.length) {
      if (p + 8 > b.length) throw new Error('truncated WebP');
      const kind = str(p, 4),
        size = v.getUint32(p + 4, true),
        data = p + 8;
      const end = data + size + (size % 2);
      if (end > b.length) throw new Error('invalid WebP chunk');
      if (kind === 'ANIM' || kind === 'ANMF') throw new Error('animated photos are not supported');
      if (kind === 'VP8X') {
        if (size !== 10 || b[data]! & 2 || canvasWidth) throw new Error('invalid or animated WebP');
        canvasWidth = 1 + b[data + 4]! + (b[data + 5]! << 8) + (b[data + 6]! << 16);
        canvasHeight = 1 + b[data + 7]! + (b[data + 8]! << 8) + (b[data + 9]! << 16);
        const chunk = b.slice(p, end);
        chunk[8] = chunk[8]! & 0x10; // retain alpha flag only
        parts.push(chunk);
      } else if (kind === 'VP8 ' || kind === 'VP8L') {
        if (width) throw new Error('multiple WebP images');
        if (kind === 'VP8 ') {
          if (size < 10 || b[data]! & 1 || str(data + 3, 3) !== '\x9d\x01\x2a')
            throw new Error('invalid WebP frame');
          width = v.getUint16(data + 6, true) & 0x3fff;
          height = v.getUint16(data + 8, true) & 0x3fff;
        } else {
          if (size < 5 || b[data] !== 0x2f) throw new Error('invalid lossless WebP');
          const bits = v.getUint32(data + 1, true);
          if (bits >>> 29) throw new Error('unsupported WebP version');
          width = (bits & 0x3fff) + 1;
          height = ((bits >>> 14) & 0x3fff) + 1;
        }
        parts.push(b.slice(p, end));
      } else if (kind === 'ALPH') {
        parts.push(b.slice(p, end));
      } else if (!['EXIF', 'XMP ', 'ICCP'].includes(kind)) {
        throw new Error('unsupported WebP chunk');
      }
      p = end;
    }
    if (canvasWidth && (canvasWidth !== width || canvasHeight !== height))
      throw new Error('WebP dimensions disagree');
    const clean = join(parts);
    new DataView(clean.buffer).setUint32(4, clean.length - 8, true);
    return checked(clean, 'image/webp', width, height);
  }
  throw new Error('only JPEG and WebP photos are supported');
}
