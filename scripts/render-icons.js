// Renders public/icons/icon.svg to the PNG sizes the PWA manifest needs
// (uses the Playwright Chromium; run: node scripts/render-icons.js).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
for (const [name, size, padding, bg] of [
  ['icon-192.png', 192, 0, 'transparent'],
  ['icon-512.png', 512, 0, 'transparent'],
  ['icon-maskable-512.png', 512, 51, '#0b1726'],
  ['apple-touch-icon.png', 180, 0, '#0b1726'],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:${bg}"><div style="padding:${padding}px;width:${size - 2 * padding}px;height:${size - 2 * padding}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`,
  );
  await page.screenshot({ path: join(dir, name), omitBackground: bg === 'transparent' });
}
await browser.close();
console.log('icons rendered');
