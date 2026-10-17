// End-to-end check in a real browser (Playwright + Chromium):
//  - builds fake camera and microphone input (synthetic road video, cabin
//    sound with a turn signal and a siren), a moving GPS position and a
//    harsh brake from the motion sensors,
//  - drives with the mobile app, ends the drive, opens the summary and the
//    AI coach, then checks the website and the dashboard.
// Usage: npm run build && npm run test:e2e
//   E2E_ROAD_VIDEO=dashcam.mp4  use a real road video instead (needs ffmpeg)
//   CHROMIUM_PATH=/path/chrome  use an already installed Chromium
//   E2E_OUT=dir                 where screenshots go (default: test-results/)
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { renderRoad } from '../helpers/road-sim.js';
import { addClicks, blinkerTimes, mix, roadNoise, tone, wail } from '../helpers/audio-sim.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.E2E_OUT ?? join(ROOT, 'test-results');
const PORT = Number(process.env.E2E_PORT ?? 3199);
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? '✔' : '✖'} ${message}`);
  if (!ok) failures.push(message);
};

function writeRoadY4m(file, { width = 640, height = 360, fps = 15, seconds = 12 } = {}) {
  const fd = openSync(file, 'w');
  writeSync(fd, `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  for (let i = 0; i < fps * seconds; i++) {
    const { gray } = renderRoad({ width, height, horizon: 0.5, hood: 0.94, traveled: (i * 15) / fps, seed: i + 1 });
    writeSync(fd, 'FRAME\n');
    writeSync(fd, Buffer.from(gray.buffer, gray.byteOffset, gray.byteLength));
    writeSync(fd, chroma);
  }
  closeSync(fd);
}

function writeCabinWav(file, sr = 48000) {
  const seconds = 30;
  const n = sr * seconds;
  const noise = roadNoise(n, { seed: 5 });
  const { ticks, tocks } = blinkerTimes(4, 11, 0.667);
  addClicks(noise, sr, ticks, 'relay');
  addClicks(noise, sr, tocks, 'tock');
  const siren = tone(n, sr, wail(), { amp: 0.06, gain: (t) => (t > 14 && t < 22 ? 1 : 0) });
  const pcm = mix(noise, siren);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pcm[i] * 32767))), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'mobile', 'index.html'))) throw new Error('Run "npm run build" first.');
  const media = join(OUT, 'media');
  mkdirSync(media, { recursive: true });
  const video = join(media, 'road.y4m');
  if (process.env.E2E_ROAD_VIDEO) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', process.env.E2E_ROAD_VIDEO, '-t', '20', '-vf', 'scale=640:360,fps=15', '-pix_fmt', 'yuv420p', video]);
  } else writeRoadY4m(video);
  const audio = join(media, 'cabin.wav');
  writeCabinWav(audio);

  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: join(media, 'e2e.db'), ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${video}`,
      `--use-file-for-fake-audio-capture=${audio}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  try {
    if (!(await waitFor(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok, 15000))) throw new Error('server did not start');
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server', 'seed.js')], { env: { ...process.env, DB_FILE: join(media, 'e2e.db') } });

    const context = await browser.newContext({
      viewport: { width: 900, height: 420 },
      deviceScaleFactor: 2,
      permissions: ['camera', 'microphone', 'geolocation'],
      geolocation: { latitude: 41.9965, longitude: 21.4314 },
      locale: 'mk-MK',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    // --- first run ---
    await page.goto(`${BASE}/app/`);
    await page.fill('input[type=text]', 'Тест возач');
    await page.check('.consent input');
    await page.click('button.primary');
    await page.waitForSelector('.setup');
    check(true, 'welcome screen -> setup');

    // Phone-sized screens: mounting guides over the camera, calibration, home.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('text=Вклучи камера и сензори');
    const preview = await waitFor(() => page.evaluate(() => document.querySelector('.setup-video')?.readyState >= 2), 15000);
    check(preview, 'setup shows the road camera with the alignment guides');
    await page.screenshot({ path: join(OUT, 'app-setup.png'), fullPage: true });
    await page.click('text=Зачувај');
    await page.waitForSelector('.calibrate');
    await page.screenshot({ path: join(OUT, 'app-calibrate.png'), fullPage: true });
    await page.goto(`${BASE}/app/#/`);
    await page.waitForSelector('.home');
    check((await page.textContent('.home')).includes('Подготовка'), 'home screen with the setup checklist');
    await page.screenshot({ path: join(OUT, 'app-home.png'), fullPage: true });
    await page.setViewportSize({ width: 900, height: 420 });

    const isolated = await page.evaluate(() => self.crossOriginIsolated);
    check(isolated, 'app page is cross-origin isolated (multi-threaded YOLO)');

    // --- drive ---
    await page.goto(`${BASE}/app/#/drive`);
    await page.click('button.start');
    await page.waitForSelector('.drive', { timeout: 20000 });
    check(true, 'drive HUD is shown');

    // Move the GPS position east at ~54 km/h.
    let lon = 21.4314;
    const gpsTimer = setInterval(() => {
      lon += 15 / (111320 * Math.cos((41.9965 * Math.PI) / 180));
      context.setGeolocation({ latitude: 41.9965, longitude: lon }).catch(() => {});
    }, 1000);

    // Watch the HUD continuously: blinker and siren indicators are transient.
    await page.evaluate(() => {
      window.__seen = { blinker: false, siren: false, pills: new Set() };
      setInterval(() => {
        if (document.querySelector('.chip.blinker.on')) window.__seen.blinker = true;
        if (document.querySelector('.siren-banner.show')) window.__seen.siren = true;
        const pill = document.querySelector('.pill.show')?.textContent;
        if (pill) window.__seen.pills.add(pill);
      }, 150);
    });
    const seen = (key) => page.evaluate((k) => window.__seen[k], key);

    const roadRunning = await waitFor(() => page.evaluate(() => /fps/.test(document.querySelector('.chip:nth-child(3)')?.textContent ?? '')), 90000);
    check(roadRunning, 'YOLOv8 + lane detection running on the road camera');
    const speedShown = await waitFor(() => page.evaluate(() => Number(document.querySelector('.speed')?.textContent) > 30), 15000);
    check(speedShown, 'GPS speed shown in the HUD');

    // Harsh brake from the motion sensors: phone upright facing the driver, rear camera forward (-Z).
    await page.evaluate(async () => {
      const send = (az) =>
        window.dispatchEvent(
          new DeviceMotionEvent('devicemotion', {
            acceleration: { x: 0, y: 0, z: az },
            accelerationIncludingGravity: { x: 0, y: 9.81, z: az },
            rotationRate: { alpha: 0, beta: 0, gamma: 0 },
            interval: 16,
          }),
        );
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 120; i++) {
        send(0.05 * Math.sin(i));
        await sleep(16);
      }
      // Braking pushes the phone forward: -Z is forward, so deceleration shows as +Z.
      for (let i = 0; i < 70; i++) {
        send(5.5);
        await sleep(16);
      }
      for (let i = 0; i < 60; i++) {
        send(0);
        await sleep(16);
      }
    });
    const braked = await waitFor(() => page.evaluate(() => [...window.__seen.pills].some((p) => /Нагло кочење/.test(p))), 5000);
    check(braked, 'harsh braking detected from motion sensors');
    await page.screenshot({ path: join(OUT, 'app-drive.png') });

    // The cabin sound file loops every 30 s: turn signal at 4-11 s, siren at 14-22 s.
    check(await waitFor(() => seen('blinker'), 40000), 'turn signal heard by the microphone');
    const siren = await waitFor(() => seen('siren'), 40000);
    check(siren, 'siren recognised and announced');
    if (siren) await waitFor(() => page.evaluate(() => document.querySelector('.siren-banner.show') != null), 31000);
    await page.screenshot({ path: join(OUT, 'app-drive-siren.png') });
    clearInterval(gpsTimer);

    // --- end the drive (hold the stop button) ---
    const stop = await page.$('button.stop');
    const box = await stop.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1300);
    await page.mouse.up();
    await page.waitForSelector('.summary', { timeout: 15000 });
    check(true, 'summary after ending the drive');
    const summaryText = await page.textContent('.summary');
    check(/Возило за итна интервенција/.test(summaryText), 'siren event listed in the summary');
    check(/Нагло кочење/.test(summaryText), 'harsh brake listed in the summary');
    await page.click('text=Совети од AI инструкторот');
    const coached = await waitFor(() => page.evaluate(() => document.querySelectorAll('.coach li').length > 0), 15000);
    check(coached, 'AI coach answered (rule-based without API key)');
    await page.setViewportSize({ width: 430, height: 900 });
    await page.screenshot({ path: join(OUT, 'app-summary.png'), fullPage: true });

    const synced = await waitFor(async () => (await (await fetch(`${BASE}/api/trips?driverId=`)).json()).some((t) => t.driverName === 'Тест возач'), 10000);
    check(synced, 'trip synced to the server');

    // --- website ---
    const site = await context.newPage();
    await site.setViewportSize({ width: 1280, height: 900 });
    await site.goto(`${BASE}/`);
    const qr = await waitFor(() => site.evaluate(() => !!document.querySelector('#qr canvas')), 10000);
    check(qr, 'landing page shows a QR code to the app');
    await site.screenshot({ path: join(OUT, 'site-landing.png'), fullPage: true });

    await site.goto(`${BASE}/dashboard`);
    await site.waitForSelector('#trips table', { timeout: 10000 });
    const rows = await site.$$eval('#trips tbody tr', (r) => r.length);
    check(rows >= 10, `dashboard lists trips (${rows})`);
    await site.selectOption('#period', '0');
    await site.click('#trips tbody tr');
    await site.waitForSelector('#map.leaflet-container', { timeout: 10000 });
    const routeDrawn = await waitFor(() => site.evaluate(() => document.querySelectorAll('#map path.leaflet-interactive').length > 0), 5000);
    check(routeDrawn, 'trip detail with the route on a map');
    await site.click('#detail button.btn.primary');
    const dashCoach = await waitFor(() => site.evaluate(() => document.querySelectorAll('.coach-card .tips li').length > 0), 15000);
    check(dashCoach, 'dashboard AI coach');
    await site.screenshot({ path: join(OUT, 'site-dashboard.png'), fullPage: true });

    // MediaPipe prints its INFO lines through console.error.
    const realErrors = errors.filter((e) => !/^INFO:|XNNPACK|tile\.openstreetmap|ERR_|net::|Failed to load resource/.test(e));
    check(realErrors.length === 0, `no page errors${realErrors.length ? `: ${realErrors.slice(0, 5).join(' | ')}` : ''}`);
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll end-to-end checks passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
