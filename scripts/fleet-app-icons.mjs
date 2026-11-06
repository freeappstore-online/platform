// Writes the icon files a legacy app's manifest or HTML declares but never
// shipped (e.g. /icons/icon-192.png), so the keyless build job's
// `build-target --artifact` icon check passes (#523).
//
//   node scripts/fleet-app-icons.mjs <repo-dir> <app-id>
//
// Local declarations only; never overwrites an existing file. Source art, in order: the app's own
// web/public/favicon.svg or icon.svg, else a personalised lettermark derived
// from the app id (initials on a colour fixed by a hash of the id), the same
// idea as the PAS lettermark icons. Never the template "F".

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/** Local icon files the app's manifest or HTML declares: [web path, declared sizes]. */
export function declaredIcons(dir) {
  const refs = [];
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  try {
    const manifest = JSON.parse(read(join(dir, 'web/public/manifest.json')) || '{}');
    for (const icon of manifest.icons ?? []) refs.push([icon.src, icon.sizes]);
  } catch {}
  const html = read(join(dir, 'web/index.html'));
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attr = (name) => new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag[0])?.[1];
    if (/icon/i.test(attr('rel') ?? '') && attr('href')) refs.push([attr('href'), attr('sizes')]);
  }
  return refs.filter(
    ([src]) => typeof src === 'string' && src.startsWith('/') && !src.startsWith('//'),
  );
}

export async function writeIcons(dir, appId) {
  const pub = join(dir, 'web/public');
  const own = ['favicon.svg', 'icon.svg'].map((f) => join(pub, f)).find((f) => existsSync(f));
  const svg = own ? readFileSync(own) : Buffer.from(lettermarkSvg(appId));
  const written = [];
  for (const [src, sizes] of declaredIcons(dir)) {
    const path = join(pub, decodeURIComponent(src.split(/[?#]/)[0]));
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    if (/\.svg$/i.test(path)) writeFileSync(path, svg);
    else if (/\.png$/i.test(path)) {
      const size = Number(/(\d+)x\d+/.exec(sizes ?? '')?.[1] ?? /(\d+)/.exec(path)?.[1] ?? 192);
      writeFileSync(path, await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer());
    } else continue;
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
