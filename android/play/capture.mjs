#!/usr/bin/env node
// Read-only native-resolution export after navigating the emulator through CUA.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = dirname(fileURLToPath(import.meta.url));
const [serial, name, alt] = process.argv.slice(2);
if (
  !/^emulator-\d+$/.test(serial ?? '') ||
  !/^0[1-8]-[a-z0-9-]+$/.test(name ?? '') ||
  !alt ||
  alt.length > 140
)
  throw Error(
    'Usage: node android/play/capture.mjs emulator-NNNN 01-screen "Alt text, <=140 characters"',
  );
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], { maxBuffer: 24 * 1024 * 1024 });
if (adb('emu', 'avd', 'name').toString().split('\n')[0].trim() !== 'fas_play_listing')
  throw Error('Capture is restricted to the clean fas_play_listing emulator.');
const bytes = adb('exec-out', 'screencap', '-p');
const image = await sharp(bytes).metadata();
if (
  image.format !== 'png' ||
  image.width !== 1080 ||
  image.height !== 1920 ||
  bytes.length > 8_000_000
)
  throw Error('Expected untouched 1080×1920 PNG below 8 MB.');
const folder = resolve(root, 'en-US/images/phoneScreenshots');
mkdirSync(folder, { recursive: true });
writeFileSync(resolve(folder, `${name}.png`), bytes);
const buildConfig = readFileSync(
  resolve(
    root,
    '../app/build/generated/source/buildConfig/debug/online/freeappstore/companion/BuildConfig.java',
  ),
  'utf8',
);
const shortCommit = buildConfig.match(/FAS_COMMIT = "([a-f0-9]{7})"/)?.[1];
if (!shortCommit) throw Error('Missing built APK source identity');
const apk = readFileSync(resolve(root, '../app/build/outputs/apk/debug/app-debug.apk'));
const recordPath = resolve(root, 'captures.json');
const captures = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath)) : {};
captures[name] = {
  file: `en-US/images/phoneScreenshots/${name}.png`,
  alt,
  width: image.width,
  height: image.height,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  capturedAt: new Date().toISOString(),
  avd: 'fas_play_listing',
  api: 34,
  sourceCommit: execFileSync('git', ['rev-parse', shortCommit]).toString().trim(),
  apkSha256: createHash('sha256').update(apk).digest('hex'),
  method: 'Real app UI; CUA navigation; unmodified adb screencap export',
  account: 'signed-out clean emulator',
};
writeFileSync(recordPath, `${JSON.stringify(captures, null, 2)}\n`);
console.log(`Captured ${name}: ${image.width}×${image.height}, ${bytes.length} bytes`);
