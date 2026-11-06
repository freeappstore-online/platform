// Writes the install icons a legacy app's manifest declares but never shipped
// (/icons/icon-192.png, /icons/icon-512.png), so the keyless build job's
// `build-target --artifact` icon check passes (#523).
//
//   node scripts/fleet-app-icons.mjs <repo-dir> <app-id>
//
// Never overwrites an existing icon. Source art, in order: the app's own
// web/public/favicon.svg or icon.svg, else a personalised lettermark derived
// from the app id (initials on a colour fixed by a hash of the id), the same
// idea as the PAS lettermark icons. Never the template "F".

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

/** One or two capital letters: the first letters of the first two words of the id. */
export function lettermark(appId) {
  const words = appId.split(/[^a-z0-9]+/i).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]) : [(words[0] ?? '?')[0]];
  return letters.join('').toUpperCase();
}

/** A hue from the id, saturated and dark enough for white text (WCAG AA). */
export function lettermarkSvg(appId) {
  const hue = createHash('sha256').update(appId).digest().readUInt16BE(0) % 360;
  const text = lettermark(appId);
  const size = text.length > 1 ? 200 : 280;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="hsl(${hue} 62% 36%)"/><text x="256" y="256" dy="0.35em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}" fill="#fff">${text}</text></svg>`;
}

export async function writeIcons(dir, appId) {
  const pub = join(dir, 'web/public');
  const own = ['favicon.svg', 'icon.svg'].map((f) => join(pub, f)).find((f) => existsSync(f));
  const svg = own ? readFileSync(own) : Buffer.from(lettermarkSvg(appId));
  mkdirSync(join(pub, 'icons'), { recursive: true });
  const written = [];
  for (const size of [192, 512]) {
    const path = join(pub, 'icons', `icon-${size}.png`);
    if (existsSync(path)) continue;
    writeFileSync(path, await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer());
    written.push(path);
  }
  return { source: own ? 'app svg' : `lettermark ${lettermark(appId)}`, written };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, appId] = process.argv.slice(2);
  if (!dir || !appId) throw new Error('usage: fleet-app-icons.mjs <repo-dir> <app-id>');
  const { source, written } = await writeIcons(dir, appId);
  console.log(`${appId}: ${written.length} icon(s) from ${source}`);
}
