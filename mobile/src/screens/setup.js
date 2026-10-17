// Mounting the phone: permissions, which cameras to use, and lining up the
// road camera (horizon, bonnet, car centre line) while the phone is in the
// holder. The level indicator shows when the phone stands straight.
import { loadSettings, saveSettings } from '../state.js';
import { attach, openCameras, stopStream } from '../sensors/cameras.js';
import { requestMotionPermission, watchGravity } from '../sensors/motion.js';
import { h, mount, toast } from '../ui.js';

const TIPS = [
  'Држач со вендуза на шофершајбната, горе на средина или зад ретровизорот – не на вентилацијата (вибрира).',
  'Телефонот хоризонтално (landscape), задната камера гледа право кон патот, екранот кон тебе.',
  'Хоризонтот приближно на средина од сликата, хаубата најмногу на долните 10–15%.',
  'Држачот не смее да ти го попречува видот. Вклучи полнач – камерите и AI трошат батерија.',
  'Сè подеси пред да тргнеш; за време на возењето не го допирај телефонот.',
];

export async function renderSetup(root, { go }) {
  const s = loadSettings();
  const guides = { horizon: s.horizon, hood: s.hood, centerX: s.centerX };
  let streams = { road: null, driver: null };
  let stopGravity = null;

  const video = h('video', { class: 'setup-video', muted: true, playsinline: true });
  const driverVideo = h('video', { class: 'setup-driver', muted: true, playsinline: true });
  const stage = h('div', { class: 'stage' }, video);
  const levelText = h('span', { class: 'level-text' }, 'Нивелација: чекам сензори…');
  const levelBubble = h('div', { class: 'bubble' });
  const status = h('p', { class: 'muted' });

  const mode = h(
    'select',
    { onChange: () => saveSettings({ cameraMode: mode.value }) },
    [
      ['both', 'Двете камери (пат + возач)'],
      ['road', 'Само камерата кон патот'],
      ['driver', 'Само камерата кон возачот'],
      ['none', 'Без камера (само сензори и микрофон)'],
    ].map(([v, l]) => h('option', { value: v, selected: s.cameraMode === v }, l)),
  );

  // Draggable guide lines over the road camera preview.
  const line = (key, label, vertical = false) => {
    const el = h('div', { class: `guide ${vertical ? 'vertical' : ''}`, dataset: { key } }, h('span', {}, label));
    const place = () => (vertical ? (el.style.left = `${guides[key] * 100}%`) : (el.style.top = `${guides[key] * 100}%`));
    place();
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = stage.getBoundingClientRect();
        const v = vertical ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
        const limits = { horizon: [0.2, 0.75], hood: [0.6, 1], centerX: [0.25, 0.75] }[key];
        guides[key] = Math.round(Math.min(limits[1], Math.max(limits[0], v)) * 1000) / 1000;
        place();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    return el;
  };
  stage.append(line('horizon', 'Хоризонт'), line('hood', 'Почеток на хаубата'), line('centerX', 'Средина на возилото', true));

  async function start() {
    const motion = await requestMotionPermission();
    if (motion === 'granted') {
      stopGravity = watchGravity((g) => {
        // In landscape gravity runs along the phone's x axis (y in portrait);
        // tilt = how far the picture leans sideways.
        const portrait = Math.abs(g[1]) > Math.abs(g[0]);
        const tilt = (Math.atan2(portrait ? g[0] : g[1], Math.abs(portrait ? g[1] : g[0])) * 180) / Math.PI;
        const pitch = (Math.atan2(g[2], Math.hypot(g[0], g[1])) * 180) / Math.PI;
        levelBubble.style.transform = `translate(${Math.max(-40, Math.min(40, tilt * 3))}px, ${Math.max(-40, Math.min(40, pitch * 2))}px)`;
        const ok = Math.abs(tilt) < 3;
        levelBubble.classList.toggle('ok', ok);
        levelText.textContent =
          (ok ? 'Телефонот е исправен ✓' : `Наклонет ${Math.abs(tilt).toFixed(0)}° – исправи го`) + (portrait ? ' · препорачано е хоризонтално' : '');
      });
    } else levelText.textContent = 'Сензорите за движење не се достапни на овој уред.';

    try {
      stopStream(streams.road);
      stopStream(streams.driver);
      streams = await openCameras(mode.value);
      if (streams.road) await attach(video, streams.road);
      if (streams.driver) await attach(driverVideo, streams.driver);
      stage.classList.toggle('no-road', !streams.road);
      status.textContent = streams.note ?? (streams.road && streams.driver ? 'Двете камери работат ✓' : streams.road ? 'Камерата кон патот работи ✓' : streams.driver ? 'Камерата кон возачот работи ✓' : 'Без камера.');
    } catch (err) {
      status.textContent = `Камерата не се отвори: ${err.message}`;
    }
  }

  mount(
    root,
    h('header', { class: 'topbar' }, h('button', { class: 'icon-btn', 'aria-label': 'Назад', onClick: () => go('/') }, '‹'), h('h1', {}, 'Држач и камера')),
    h(
      'main',
      { class: 'setup' },
      h('ol', { class: 'tips' }, TIPS.map((t) => h('li', {}, t))),
      h('label', { class: 'field' }, 'Кои камери да се користат', mode),
      h('button', { class: 'primary', onClick: start }, 'Вклучи камера и сензори'),
      status,
      stage,
      h('p', { class: 'muted small' }, 'Повлечи ги линиите: хоризонтот на линијата каде патот се губи, хаубата каде почнува капакот, а средината на возилото пред тебе.'),
      h('div', { class: 'level' }, h('div', { class: 'level-box' }, levelBubble), levelText),
      h('div', { class: 'driver-check' }, driverVideo, h('p', { class: 'muted small' }, 'Камерата кон возачот треба да го гледа целото лице, без сонце директно во објективот.')),
      h(
        'button',
        {
          class: 'primary',
          onClick: () => {
            saveSettings({ ...guides, cameraMode: mode.value, mountDone: true });
            toast('Поставките за држачот се зачувани.');
            go(mode.value === 'both' || mode.value === 'driver' ? '/calibrate' : '/');
          },
        },
        'Зачувај',
      ),
    ),
  );

  return () => {
    stopGravity?.();
    stopStream(streams.road);
    stopStream(streams.driver);
  };
}
