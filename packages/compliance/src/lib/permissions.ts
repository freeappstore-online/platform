import type { FileSource } from './file-source.js';
import { stripCommentsForExt } from './strip.js';

/**
 * Browser permissions an app can ask the user for, as shown on its storefront
 * listing (#285). Only APIs that make the browser prompt are listed: silent
 * features (fullscreen, wake lock, clipboard write) need no warning.
 *
 * The storefront's labels and icons for these ids live in
 * sites/storefront/build.js PERMISSION_INFO; a test keeps the two in sync.
 */
export const PERMISSION_IDS = [
  'microphone',
  'camera',
  'location',
  'motion',
  'notifications',
  'midi',
  'clipboard',
  'screen',
  'bluetooth',
  'usb',
  'serial',
  'hid',
] as const;

export type PermissionId = (typeof PERMISSION_IDS)[number];

export interface DeclaredPermission {
  name: string;
  reason?: string;
}

/** Where creators declare permissions: a `permissions` member in the web app manifest. */
export const PERMISSIONS_MANIFEST_PATH = 'web/public/manifest.json';

// Patterns run on app SOURCE, not the built bundle: initApp() always
// constructs the SDK's push client, so every SDK bundle contains
// Notification.requestPermission whether or not the app uses it.
const PATTERNS: Record<Exclude<PermissionId, 'microphone' | 'camera'>, RegExp[]> = {
  location: [/\bgeolocation\s*\.\s*(?:getCurrentPosition|watchPosition)\s*\(/],
  motion: [
    /\bDevice(?:Orientation|Motion)Event\b/,
    /['"`]device(?:orientation|orientationabsolute|motion)['"`]/,
    /\bnew\s+(?:Accelerometer|Gyroscope|Magnetometer|AbsoluteOrientationSensor|RelativeOrientationSensor|LinearAccelerationSensor|GravitySensor)\s*\(/,
  ],
  notifications: [
    /\bNotification\s*\.\s*requestPermission\s*\(/,
    /\bnew\s+Notification\s*\(/,
    /\bpushManager\s*\.\s*subscribe\s*\(/,
    // The SDK's push client: fas.push.subscribe() / .schedule().
    /\.push\s*\.\s*(?:subscribe|schedule)\s*\(/,
  ],
  midi: [/\brequestMIDIAccess\s*\(/],
  clipboard: [/\bclipboard\s*\.\s*(?:readText|read)\s*\(/],
  screen: [/\bgetDisplayMedia\s*\(/],
  bluetooth: [/\bnavigator\s*\.\s*bluetooth\b/],
  usb: [/\bnavigator\s*\.\s*usb\b/],
  serial: [/\bnavigator\s*\.\s*serial\b/],
  hid: [/\bnavigator\s*\.\s*hid\b/],
};

const SPEECH = [/\b(?:webkit)?SpeechRecognition\b/, /\buseVoiceInput\s*\(/];
const GET_USER_MEDIA = /\bgetUserMedia\s*\(/g;

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.html', '.vue', '.svelte']);

function isTestFile(path: string): boolean {
  return (
    /(?:^|\/)(?:test|tests|__tests__|e2e)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}

/** The argument text of the call whose "(" ends at `open`, up to its balanced ")". */
function callArgs(content: string, open: number): string {
  let depth = 0;
  for (let i = open; i < content.length && i < open + 2000; i++) {
    if (content[i] === '(') depth++;
    else if (content[i] === ')' && --depth === 0) return content.slice(open + 1, i);
  }
  return content.slice(open + 1, open + 400);
}

// `audio: false` / `video: false` asks for nothing.
const ASKS_AUDIO = /\baudio\b(?!\s*:\s*false\b)/;
const ASKS_VIDEO = /\b(?:video\b(?!\s*:\s*false\b)|facingMode\b)/;

/** getUserMedia → microphone and/or camera, from each call's constraints. */
function mediaPermissions(content: string): PermissionId[] {
  const found = new Set<PermissionId>();
  for (const m of content.matchAll(GET_USER_MEDIA)) {
    const args = callArgs(content, m.index + m[0].length - 1);
    const audio = ASKS_AUDIO.test(args);
    const video = ASKS_VIDEO.test(args);
    if (audio) found.add('microphone');
    if (video) found.add('camera');
    if (!audio && !video) {
      // Constraints built elsewhere (a variable): fall back to the whole file.
      const fileAudio = /\baudio\s*:(?!\s*false\b)/.test(content);
      const fileVideo = /\bvideo\s*:(?!\s*false\b)|\bfacingMode\b/.test(content);
      if (fileAudio) found.add('microphone');
      if (fileVideo) found.add('camera');
      if (!fileAudio && !fileVideo) {
        found.add('microphone');
        found.add('camera');
      }
    }
  }
  return [...found];
}

/** Permissions the app's source uses, each with the first file it was seen in. */
export async function detectPermissions(source: FileSource): Promise<Map<PermissionId, string>> {
  const found = new Map<PermissionId, string>();
  for await (const path of source.list()) {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!SCAN_EXTS.has(ext) || isTestFile(path)) continue;
    const raw = await source.read(path);
    if (!raw) continue;
    const content = stripCommentsForExt(raw, ext);
    const hits: PermissionId[] = mediaPermissions(content);
    if (SPEECH.some((re) => re.test(content))) hits.push('microphone');
    for (const [id, patterns] of Object.entries(PATTERNS) as [PermissionId, RegExp[]][]) {
      if (patterns.some((re) => re.test(content))) hits.push(id);
    }
    for (const id of hits) if (!found.has(id)) found.set(id, path);
  }
  return found;
}

/**
 * Permissions declared in the manifest's `permissions` member. Entries are
 * either "camera" or { "name": "microphone", "reason": "live audio effects" }.
 * Returns null when the manifest is missing or unreadable.
 */
export async function readDeclaredPermissions(
  source: FileSource,
): Promise<DeclaredPermission[] | null> {
  const raw = await source.read(PERMISSIONS_MANIFEST_PATH);
  if (raw === null) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = (manifest as { permissions?: unknown })?.permissions;
  if (!Array.isArray(list)) return [];
  const out: DeclaredPermission[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') out.push({ name: entry });
    else if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
      out.push(
        typeof entry.reason === 'string' && entry.reason.trim()
          ? { name: entry.name, reason: entry.reason.trim() }
          : { name: entry.name },
      );
    }
  }
  return out;
}

export function isPermissionId(name: string): name is PermissionId {
  return (PERMISSION_IDS as readonly string[]).includes(name);
}
