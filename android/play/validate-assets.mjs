#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = dirname(fileURLToPath(import.meta.url));
const entries = [];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [name, limit] of [
  ['title', 30],
  ['short-description', 80],
  ['full-description', 4000],
]) {
  const file = resolve(root, `en-US/${name}.txt`),
    bytes = readFileSync(file),
    text = bytes.toString().trim();
  assert.ok(text.length > 0 && [...text].length <= limit, `${name}: exceeded ${limit} characters`);
  entries.push({
    file: relative(root, file),
    kind: 'text',
    characters: [...text].length,
    sha256: digest(bytes),
  });
}
async function graphic(file, kind, width, height, alpha, maxBytes, alt) {
  const bytes = readFileSync(file),
    meta = await sharp(bytes).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
  assert.equal(meta.hasAlpha, alpha);
  assert.ok(bytes.length <= maxBytes);
  entries.push({
    file: relative(root, file),
    kind,
    width,
    height,
    bytes: bytes.length,
    sha256: digest(bytes),
    alt,
  });
}
await graphic(
  resolve(root, '../../brand/native-assets/play-icon-512.png'),
  'icon',
  512,
  512,
  true,
  1024 * 1024,
  'FreeAppStore blue four-tile icon.',
);
await graphic(
  resolve(root, 'en-US/images/featureGraphic.png'),
  'featureGraphic',
  1024,
  500,
  false,
  8_000_000,
  readFileSync(resolve(root, 'en-US/feature-graphic-alt.txt'), 'utf8').trim(),
);
const captures = JSON.parse(readFileSync(resolve(root, 'captures.json')));
const shots = readdirSync(resolve(root, 'en-US/images/phoneScreenshots'))
  .filter((x) => x.endsWith('.png'))
  .sort();
assert.ok(shots.length >= 2 && shots.length <= 8, 'Need 2–8 reviewed phone screenshots');
for (const name of shots) {
  const record = captures[name.slice(0, -4)];
  assert.ok(record && record.alt.length <= 140 && record.method.includes('unmodified'));
  const file = resolve(root, record.file),
    bytes = readFileSync(file),
    meta = await sharp(bytes).metadata();
  assert.equal(digest(bytes), record.sha256, 'Capture pixels changed after export');
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1920);
  assert.equal(meta.format, 'png');
  assert.ok(bytes.length <= 8_000_000);
  entries.push({ ...record, kind: 'rawScreenshot', bytes: bytes.length });
}
const finalDir = resolve(root, 'en-US/images/listingPhoneScreenshots');
const frames = JSON.parse(readFileSync(resolve(finalDir, 'manifest.json'))).screenshots;
assert.deepEqual(
  frames.map((frame) => frame.file),
  shots,
  'Final frames must match the real capture set in order',
);
for (const frame of frames) {
  const record = captures[frame.file.slice(0, -4)];
  assert.equal(frame.raw, record.file);
  assert.equal(frame.rawSha256, record.sha256);
  const bytes = readFileSync(resolve(finalDir, frame.file));
  const meta = await sharp(bytes).metadata();
  assert.equal(digest(bytes), frame.sha256, 'Final frame changed after review');
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1920);
  assert.equal(meta.format, 'png');
  assert.equal(meta.hasAlpha, false);
  assert.ok(bytes.length <= 8_000_000);
  entries.push({
    file: relative(root, resolve(finalDir, frame.file)),
    kind: 'phoneScreenshot',
    width: meta.width,
    height: meta.height,
    bytes: bytes.length,
    sha256: frame.sha256,
    alt: record.alt,
    caption: frame.caption,
    rawFile: record.file,
    rawSha256: record.sha256,
    sourceCommit: record.sourceCommit,
    apkSha256: record.apkSha256,
  });
}
writeFileSync(
  resolve(root, 'export-manifest.json'),
  `${JSON.stringify(
    {
      locales: ['en-GB', 'en-US'],
      package: 'online.freeappstore.companion',
      preparedOnly: true,
      requirements: 'https://support.google.com/googleplay/android-developer/answer/9866151',
      assets: entries,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Validated copy, icon, feature graphic and ${shots.length} real screenshots. No uploads performed.`,
);
