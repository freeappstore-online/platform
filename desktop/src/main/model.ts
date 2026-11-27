import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import bz2 from 'unbzip2-stream';

/**
 * Kokoro v1.0 (82M, multi-language) as packaged for sherpa-onnx, the phones' package (android
 * `KokoroModel`, #731): downloaded on request from the pinned sherpa-onnx release asset, checked
 * against its pinned SHA-256 before anything is unpacked, and kept in userData until deleted.
 */
export const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2';
export const MODEL_SHA256 = '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4';
export const MODEL_DOWNLOAD_BYTES = 349_886_476;
export const MODEL_INSTALLED_BYTES = 401_239_297;
/** The folder the archive unpacks into, under the model's directory. */
export const MODEL_ROOT = 'kokoro-multi-lang-v1_0';
/** Mandarin text normalisers in the package: dates, phone numbers, then other numbers read as Chinese. */
export const MANDARIN_RULES = ['date-zh.fst', 'phone-zh.fst', 'number-zh.fst'];

const MARKER = 'installed';

export const modelInstalled = (dir: string) => existsSync(join(dir, MARKER));

/** `download` while it downloads (of its known size), then `unpack` (of the archive read). */
export type InstallProgress = (stage: 'download' | 'unpack', fraction: number) => void;

/** Calls `report` with whole percents only, not for every chunk. */
function counter(total: number, stage: 'download' | 'unpack', report: InstallProgress) {
  let bytes = 0;
  let last = -1;
  return (n: number) => {
    bytes += n;
    const percent = Math.min(100, Math.floor((bytes * 100) / total));
    if (percent !== last) report(stage, percent / 100);
    last = percent;
    return bytes;
  };
}

/**
 * Downloads, verifies and unpacks the model into `dir` unless it is there. Only regular files and
 * directories are unpacked, each inside `dir` (node-tar refuses paths that leave it). Anything
 * that fails leaves nothing behind.
 */
export async function installModel(
  dir: string,
  progress: InstallProgress,
  source = MODEL_URL,
  sha256 = MODEL_SHA256,
): Promise<void> {
  if (modelInstalled(dir)) return;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const archive = join(dir, 'download.part');
  try {
    const response = await fetch(source);
    if (!response.ok || !response.body)
      throw new Error(`The voice model didn't download (HTTP ${response.status}).`);
    const hash = createHash('sha256');
    const downloaded = counter(MODEL_DOWNLOAD_BYTES, 'download', progress);
    let size = 0;
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          size = downloaded(chunk.length);
          done(null, chunk);
        },
      }),
      createWriteStream(archive),
    );
    if (hash.digest('hex') !== sha256)
      throw new Error(
        'The voice model download did not match its checksum. Nothing was installed.',
      );
    const read = counter(size, 'unpack', progress);
    await pipeline(
      createReadStream(archive).on('data', (chunk) => read(chunk.length)),
      bz2(),
      tar.x({
        cwd: dir,
        strict: true,
        filter: (_path, entry) =>
          'type' in entry && (entry.type === 'File' || entry.type === 'Directory'),
      }),
    );
    await writeFile(join(dir, MARKER), '');
  } finally {
    await rm(archive, { force: true });
    if (!modelInstalled(dir)) await rm(dir, { recursive: true, force: true });
  }
}
