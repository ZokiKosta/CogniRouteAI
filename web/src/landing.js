// Landing page: QR code that opens the mobile app on a phone, server status.
import QRCode from 'qrcode';

const qrBox = document.getElementById('qr');
const qrUrl = document.getElementById('qr-url');
const status = document.getElementById('server-status');

async function appUrl() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!local) return { url: `${location.origin}/app/` };
  // On this computer: point the phone at the computer's address in the local network.
  try {
    const info = await (await fetch('/api/info')).json();
    const ip = info.addresses?.[0];
    if (ip) return { url: `${location.protocol}//${ip}${location.port ? `:${location.port}` : ''}/app/`, lan: true, ai: info.ai };
  } catch {
    // API not running
  }
  return { url: `${location.origin}/app/` };
}

async function main() {
  const { url, lan } = await appUrl();
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, url, { margin: 0, width: 352, color: { dark: '#0b1726', light: '#ffffff' } });
  canvas.style.width = '100%'; // the library sets a fixed pixel size
  canvas.style.height = '100%';
  qrBox.replaceChildren(canvas);
  qrUrl.textContent = url;
  if (lan && location.protocol === 'http:') {
    status.textContent = 'Телефонот бара HTTPS за камера и сензори: на компјутерот пушти „npm run dev:phone“, или постави ја апликацијата на сервер со HTTPS.';
  }
  try {
    const health = await (await fetch('/api/health')).json();
    status.textContent = `${status.textContent ? status.textContent + ' ' : ''}Серверот работи · AI совети: ${health.ai ? 'Claude' : 'според правила'}`.trim();
  } catch {
    status.textContent ||= 'Серверот (API) не е вклучен – апликацијата сепак работи и ги чува возењата на телефонот.';
  }
}

main();
