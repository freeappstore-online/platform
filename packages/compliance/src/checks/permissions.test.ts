import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { detectPermissions, readDeclaredPermissions } from '../lib/permissions.js';
import { checkPermissions } from './permissions.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
  await mkdir(join(dir, 'web', 'src'), { recursive: true });
  await mkdir(join(dir, 'web', 'public'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (path: string, content: string) => writeFile(join(dir, path), content);
const manifest = (permissions?: unknown) =>
  write(
    'web/public/manifest.json',
    JSON.stringify({
      name: 'X',
      short_name: 'X',
      start_url: '/',
      display: 'standalone',
      permissions,
    }),
  );
const detected = async () => [...(await detectPermissions(fsFileSource(dir))).keys()].sort();

// #285: the listing shows what an app will ask for.
describe('detectPermissions', () => {
  it.each([
    ['microphone', 'await navigator.mediaDevices.getUserMedia({ audio: true });'],
    ['camera', "navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });"],
    ['location', 'navigator.geolocation.getCurrentPosition(ok, err);'],
    ['location', 'const id = navigator.geolocation.watchPosition(cb);'],
    ['motion', "window.addEventListener('deviceorientationabsolute', onHeading);"],
    ['motion', "if (typeof DeviceMotionEvent.requestPermission === 'function') {}"],
    ['notifications', 'await fas.push.subscribe();'],
    ['notifications', 'await Notification.requestPermission();'],
    ['midi', 'const access = await navigator.requestMIDIAccess();'],
    ['clipboard', 'const text = await navigator.clipboard.readText();'],
    ['screen', 'await navigator.mediaDevices.getDisplayMedia({ video: true });'],
    ['bluetooth', 'await navigator.bluetooth.requestDevice({ acceptAllDevices: true });'],
    ['usb', 'await navigator.usb.requestDevice({ filters: [] });'],
    ['serial', 'const port = await navigator.serial.requestPort();'],
    ['hid', 'await navigator.hid.requestDevice({ filters: [] });'],
    ['microphone', 'const voice = useVoiceInput();'],
  ])('detects %s from: %s', async (id, code) => {
    await write('web/src/App.tsx', code);
    expect(await detected()).toContain(id);
  });

  it("ignores audio: false and text after the call's closing paren", async () => {
    await write(
      'web/src/Scan.tsx',
      "const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });\nconst a = { audio: 1 };",
    );
    expect(await detected()).toEqual(['camera']);
    await write(
      'web/src/Scan.tsx',
      "navigator.mediaDevices.getUserMedia({ audio: true });\nconst el = document.querySelector('video');",
    );
    expect(await detected()).toEqual(['microphone']);
  });

  it('detects both from getUserMedia({ audio, video })', async () => {
    await write(
      'web/src/App.tsx',
      'navigator.mediaDevices.getUserMedia({ audio: true, video: true });',
    );
    expect(await detected()).toEqual(['camera', 'microphone']);
  });

  it('finds nothing in an ordinary app, comments or tests', async () => {
    await write(
      'web/src/App.tsx',
      "// we never call getUserMedia({ audio: true })\nconst list = []; list.push(1); navigator.clipboard.writeText('x');",
    );
    await write('web/src/App.test.ts', 'navigator.geolocation.getCurrentPosition(() => {});');
    expect(await detected()).toEqual([]);
  });

  it("doesn't treat the SDK's always-present push client as a request", async () => {
    await write(
      'web/src/main.ts',
      "import { initApp } from '@freeappstore/sdk'; export const fas = initApp({ appId: 'x' });",
    );
    expect(await detected()).toEqual([]);
  });
});

describe('readDeclaredPermissions', () => {
  it('reads names and optional reasons', async () => {
    await manifest([
      'camera',
      { name: 'microphone', reason: ' live audio effects ' },
      { reason: 'no name' },
    ]);
    expect(await readDeclaredPermissions(fsFileSource(dir))).toEqual([
      { name: 'camera' },
      { name: 'microphone', reason: 'live audio effects' },
    ]);
  });

  it('is empty without a permissions member and null without a manifest', async () => {
    expect(await readDeclaredPermissions(fsFileSource(dir))).toBeNull();
    await manifest();
    expect(await readDeclaredPermissions(fsFileSource(dir))).toEqual([]);
  });
});

describe('checkPermissions', () => {
  it('passes an app that asks for nothing', async () => {
    await write('web/src/App.tsx', 'export const x = 1;');
    await manifest();
    expect(await checkPermissions(fsFileSource(dir))).toMatchObject({
      status: 'pass',
      detail: 'asks for no browser permissions',
    });
  });

  it('passes when every detected permission is declared', async () => {
    await write('web/src/App.tsx', 'navigator.mediaDevices.getUserMedia({ audio: true });');
    await manifest([{ name: 'microphone', reason: 'record notes' }]);
    expect(await checkPermissions(fsFileSource(dir))).toMatchObject({
      status: 'pass',
      detail: 'asks for: microphone',
    });
  });

  it('warns (never fails) on an undeclared permission, naming the file', async () => {
    await write('web/src/Rec.tsx', 'navigator.mediaDevices.getUserMedia({ audio: true });');
    await manifest();
    const r = await checkPermissions(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('microphone (web/src/Rec.tsx)');
    expect(r.suggestions?.[0]).toContain('"permissions"');
  });

  it('warns on an unknown permission name', async () => {
    await manifest(['microphone', 'telepathy']);
    const r = await checkPermissions(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('telepathy');
  });
});
