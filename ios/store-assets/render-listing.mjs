// Compose App Store presentation cards around real screenshots; raw captures stay unchanged.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const device = process.argv[2];
if (!['iphone-medium', 'iphone-large'].includes(device))
  throw new Error('Choose a documented capture device');
const shots = [
  ['01-store-overview', 'Find your next\nfavourite app.'],
  ['02-favourites', 'Your favourites.\nAlways close.'],
  ['03-app-details', 'A closer look,\nbefore you open.'],
  ['04-home-screen-guide', 'Make room on\nyour Home Screen.'],
];
const wordmark = await readFile(resolve(root, 'brand/assets/wordmark-light.svg'));
const fontfile = resolve(root, 'android/play/design/fonts/Manrope.ttf');
const output = resolve(here, 'listing', device);
await mkdir(output, { recursive: true });
const records = [];
for (const [name, caption] of shots) {
  const raw = await readFile(resolve(here, device, name + '.png'));
  const { width, height } = await sharp(raw).metadata();
  const margin = Math.round(width * 0.085);
  const top = Math.round(width * 0.323);
  const fit = Math.min(width - margin * 2, Math.floor(((height - top - 50) * width) / height));
  const resized = await sharp(raw).resize({ width: fit }).removeAlpha().png().toBuffer();
  const sm = await sharp(resized).metadata();
  const left = Math.round((width - fit) / 2);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fit}" height="${sm.height}"><rect width="100%" height="100%" rx="24" fill="white"/></svg>`,
  );
  const shot = await sharp(resized)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const bg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="bg" x2="0.7" y2="1"><stop stop-color="#f8fbff"/><stop offset="1" stop-color="#dbeafe"/></linearGradient><filter id="shadow" x="-.2" y="-.2" width="1.4" height="1.4"><feDropShadow dx="0" dy="12" stdDeviation="20" flood-color="#1e40af" flood-opacity=".12"/></filter></defs><rect width="100%" height="100%" fill="url(#bg)"/><rect x="${left - 3}" y="${top - 3}" width="${fit + 6}" height="${sm.height + 6}" rx="28" fill="#ffffff" stroke="#c5d7f6" stroke-width="3" filter="url(#shadow)"/></svg>`,
  );
  const title = await sharp({
    text: {
      text: `<span foreground="#0f172a" weight="800">${caption}</span>`,
      font: `Manrope ${Math.round(width * 0.06)}`,
      fontfile,
      rgba: true,
      dpi: 72,
      spacing: 8,
    },
  })
    .png()
    .toBuffer();
  const tm = await sharp(title).metadata();
  if (tm.width > width - margin * 2) throw new Error('Caption exceeds safe width');
  const image = await sharp(bg)
    .composite([
      {
        input: await sharp(wordmark)
          .resize({ width: Math.round(width * 0.25) })
          .png()
          .toBuffer(),
        left: margin,
        top: Math.round(width * 0.033),
      },
      { input: title, left: margin, top: Math.round(width * 0.112) },
      { input: shot, left, top },
    ])
    .removeAlpha()
    .png()
    .toBuffer();
  const metadata = await sharp(image).metadata();
  if (metadata.hasAlpha || metadata.width !== width || metadata.height !== height)
    throw new Error('Invalid store screenshot');
  await writeFile(resolve(output, name + '.png'), image);
  records.push({
    file: name + '.png',
    caption: caption.replace('\n', ' '),
    raw: `${device}/${name}.png`,
    rawSha256: createHash('sha256').update(raw).digest('hex'),
    sha256: createHash('sha256').update(image).digest('hex'),
    width,
    height,
    alpha: false,
  });
}
await writeFile(
  resolve(output, 'manifest.json'),
  JSON.stringify(
    {
      device,
      kind: 'real app screenshot with editorial caption; raw UI retained',
      screenshots: records,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Rendered ${records.length} App Store screenshots for ${device}.`);
