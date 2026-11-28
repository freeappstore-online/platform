// Listing artwork, not an app screenshot. Keep the canonical outlined wordmark intact.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const fontfile = resolve(root, 'android/play/design/fonts/Manrope.ttf');
const wordmark = await readFile(resolve(root, 'brand/assets/wordmark-dark.svg'));
async function lettering(value, size, weight, colour) {
  return sharp({
    text: {
      text: `<span foreground="${colour}" weight="${weight}">${value}</span>`,
      font: `Manrope ${size}`,
      fontfile,
      rgba: true,
      dpi: 72,
    },
  })
    .png()
    .toBuffer();
}
const width = 3840,
  height = 1646;
const background = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#0d2c74"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs><rect width="3840" height="1646" fill="url(#bg)"/><circle cx="3800" cy="0" r="1150" fill="#60a5fa" opacity=".10"/><circle cx="3900" cy="0" r="790" fill="#93c5fd" opacity=".08"/><g fill="none" stroke="#93c5fd" stroke-width="4" opacity=".16"><rect x="-100" y="800" width="520" height="520" rx="140"/><rect x="480" y="1360" width="520" height="520" rx="140"/><rect x="3380" y="1080" width="520" height="520" rx="140"/></g></svg>`,
);
const layers = [];
async function centered(input, top) {
  const m = await sharp(input).metadata();
  layers.push({ input, left: Math.round((width - m.width) / 2), top });
}
await centered(await sharp(wordmark).resize({ width: 900 }).png().toBuffer(), 330);
await centered(await lettering('Your apps, within reach.', 180, 800, '#ffffff'), 750);
await centered(
  await lettering('Browse  ·  Save favourites  ·  Contribute', 66, 600, '#dbeafe'),
  1050,
);
const output = await sharp(background).composite(layers).removeAlpha().png().toBuffer();
await mkdir(here, { recursive: true });
await writeFile(resolve(here, 'app-store-header.png'), output);
await writeFile(
  resolve(here, 'manifest.json'),
  JSON.stringify(
    {
      kind: 'brand creative, not app screenshot',
      width,
      height,
      colourSpace: 'sRGB',
      alpha: false,
      sha256: createHash('sha256').update(output).digest('hex'),
      source: 'render.mjs + brand/assets/wordmark-dark.svg',
      font: 'Manrope, SIL OFL in android/play/design/fonts/OFL.txt',
    },
    null,
    2,
  ) + '\n',
);
console.log('Rendered opaque 3840×1646 App Store header.');
