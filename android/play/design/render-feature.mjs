#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Render a marketing graphic, never a fabricated app screenshot.
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const fontfile = resolve(here, 'fonts/Manrope.ttf');
const wordmark = readFileSync(resolve(here, '../../../brand/assets/wordmark-dark.svg'));
const background =
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#0d2c74"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs>
<rect width="1024" height="500" fill="url(#bg)"/>
<circle cx="1080" cy="70" r="350" fill="#60a5fa" opacity=".13"/>
<circle cx="1090" cy="50" r="235" fill="#93c5fd" opacity=".1"/>
<path d="M760 500V345a38 38 0 0 1 38-38h226" fill="none" stroke="#93c5fd" stroke-width="2" opacity=".28"/>
<path d="M820 500V405a38 38 0 0 1 38-38h166" fill="none" stroke="#93c5fd" stroke-width="2" opacity=".18"/>
</svg>`);
async function text(value, size, colour, weight = 600) {
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
const image = await sharp(background)
  .composite([
    { input: await sharp(wordmark).resize({ width: 290 }).png().toBuffer(), left: 64, top: 42 },
    { input: await text('Your apps,', 68, '#ffffff', 800), left: 70, top: 170 },
    { input: await text('within reach.', 68, '#ffffff', 800), left: 70, top: 255 },
    {
      input: await text('Browse  ·  Save favourites  ·  Contribute', 25, '#dbeafe'),
      left: 73,
      top: 375,
    },
  ])
  .removeAlpha()
  .png()
  .toBuffer();
writeFileSync(resolve(here, '../en-US/images/featureGraphic.png'), image);
console.log('Rendered 1024×500 opaque Play feature graphic.');
