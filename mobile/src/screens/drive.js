// The in-car screen: road camera with detections, speed and limit, alerts,
// the driver camera in a corner. Designed to be glanced at, not touched;
// the coach talks. Ending a drive needs a one-second press.
import { DIRECTION_LABELS, EVENT_TYPES, MANEUVER_TYPES, eventLabel, makeEvent } from '../../../shared/events.js';
import { GAZE_ZONES } from '../../../shared/gaze.js';
import { PHRASES } from '../../../shared/voice-phrases.js';
import { DriveSession } from '../session.js';
import { openMicrophone } from '../sensors/audio.js';
import { attach, openCameras, stopStream } from '../sensors/cameras.js';
import { requestMotionPermission } from '../sensors/motion.js';
import { loadSettings } from '../state.js';
import { saveTrip, uploadTrip } from '../storage.js';
import { Voice } from '../voice.js';
import { h, mount, toast } from '../ui.js';

const ALERT_TEXT = {
  speeding: (a) => `Намали брзина – ограничување ${a.limit ?? ''} km/h`,
  tailgating: () => 'Преблиску! Држи најмалку 2 секунди растојание',
  collision: () => '⚠️ Внимание! Возило напред!',
  pedestrian: (a) => `🚶 Пешак на ${Math.round(a.distance ?? 0)} m`,
  animal: () => '🐾 Животно на патот!',
  distraction: () => '👀 Гледај на патот!',
  drowsy: () => '😴 Изгледаш поспано – направи пауза',
  break: () => '☕ Време е за кратка пауза',
};

const GREEN_TEXT = {
  slow: (a) => `🟢 Намали на ${a.targetKmh} за зелен бран`,
  speed: (a) => `🟢 Забрзај до ${a.targetKmh} за зелено`,
  keep: (a) => `🟢 Задржи ~${a.targetKmh} – зелен бран`,
  go: () => '🟢 Фаќаш зелено – рамномерно',
  ease: () => '🔴 Тргни од гас – следниот е црвен',
};

/** Optional browser APIs (fullscreen, orientation lock, wake lock) are missing on some phones, e.g. iPhone Safari. */
async function attempt(fn) {
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

export async function renderDrive(root, { go, demo }) {
  const settings = loadSettings();
  const voice = new Voice({ enabled: settings.voice });
  let session = null;
  let streams = { road: null, driver: null, mic: null };
  let wakeLock = null;
  let liveTimer = null;
  let finished = false;
  let demoSpeed = 50;
  let demoFile = null;

  // ---- start panel ------------------------------------------------------
  const fileInput = h('input', { type: 'file', accept: 'video/*', onChange: () => (demoFile = fileInput.files[0] ?? null) });
  const speedOut = h('output', {}, `${demoSpeed} km/h`);
  const speedInput = h('input', {
    type: 'range',
    min: 0,
    max: 130,
    step: 5,
    value: demoSpeed,
    onInput: () => {
      demoSpeed = Number(speedInput.value);
      speedOut.textContent = `${demoSpeed} km/h`;
    },
  });
  const startBtn = h('button', { class: 'start', onClick: () => start().catch((err) => fail(err)) }, h('span', { class: 'start-icon' }, '▶'), demo ? 'Старт на демото' : 'Старт');
  const modeLabel = { both: 'камера кон патот и кон тебе', road: 'камера кон патот', driver: 'камера кон тебе', none: 'без камера' }[settings.cameraMode];
  mount(
    root,
    h('header', { class: 'topbar' }, h('button', { class: 'icon-btn', 'aria-label': 'Назад', onClick: () => go('/') }, '‹'), h('h1', {}, demo ? 'Демо со видео' : 'Ново возење')),
    h(
      'main',
      { class: 'pre-drive' },
      demo
        ? h(
            'section',
            { class: 'card' },
            h('p', {}, 'Избери видео снимено од автомобил (dashcam). Апликацијата ќе го анализира како да е камерата кон патот, со симулирана брзина.'),
            h('label', { class: 'field' }, 'Видео од патот', fileInput),
            h('label', { class: 'field' }, 'Симулирана брзина', speedInput, speedOut),
          )
        : h(
            'section',
            { class: 'card' },
            h('p', {}, `Ќе се користи: ${modeLabel}, микрофон, GPS и сензори за движење.`),
            settings.mountDone ? null : h('p', { class: 'warn' }, 'Држачот уште не е подесен – препорачано е прво „Држач и камера“.'),
            h('p', { class: 'muted small' }, 'По стартот не го допирај телефонот. За крај држи го копчето „Заврши“ една секунда.'),
          ),
      startBtn,
    ),
  );

  function fail(err) {
    startBtn.disabled = false;
    toast(err.message ?? String(err), 'warn', 6000);
  }

  // Green-wave signals: the user's own set, plus the Skopje demo corridor in
  // demo mode. For the demo we re-anchor the cycles to now so a car leaving at
  // ~50 km/h actually catches the wave.
  async function loadSignals() {
    if (settings.signals?.length && !demo) return settings.signals;
    if (!demo && !settings.greenWaveDemo) return settings.signals ?? [];
    try {
      const data = await (await fetch('/signals/skopje-demo.json')).json();
      if (!demo) return data.signals;
      const gpsStart = { lat: 41.9965, lon: 21.4314 };
      const mPerDeg = 111320 * Math.cos((gpsStart.lat * Math.PI) / 180);
      const now = Date.now();
      const v = (data.waveKmh ?? 50) / 3.6;
      return data.signals.map((s) => {
        const d = (s.lon - gpsStart.lon) * mPerDeg;
        const eta = d / v; // seconds for the demo car to reach this light
        const len = ((s.cycle.green[1] - s.cycle.green[0] + s.cycle.period) % s.cycle.period) || 30;
        // green opens 3 s before the car arrives
        const start = ((eta - 3) % s.cycle.period + s.cycle.period) % s.cycle.period;
        return { ...s, cycle: { ...s.cycle, t0: now, green: [Math.round(start), Math.round((start + len) % s.cycle.period)] } };
      });
    } catch {
      return [];
    }
  }

  // ---- HUD --------------------------------------------------------------
  const roadVideo = h('video', { class: 'road-video', muted: true, playsinline: true });
  const overlay = h('canvas', { class: 'road-overlay' });
  const driverVideo = h('video', { class: 'driver-pip', muted: true, playsinline: true });
  const speedEl = h('div', { class: 'speed' }, '—');
  const limitEl = h('div', { class: 'limit', title: 'ограничување' }, settings.defaultLimit);
  const scoreEl = h('div', { class: 'live-score' }, '100');
  const eventsEl = h('div', { class: 'live-events' }, '0 настани');
  const banner = h('div', { class: 'banner', role: 'alert' });
  const sirenBanner = h('div', { class: 'siren-banner' }, '🚑 СИРЕНА – направи простор, тргни десно');
  const pill = h('div', { class: 'pill' });
  const chips = {
    gps: h('span', { class: 'chip' }, 'GPS …'),
    motion: h('span', { class: 'chip' }, 'Сензори …'),
    road: h('span', { class: 'chip' }, 'Пат …'),
    driver: h('span', { class: 'chip' }, 'Возач …'),
    mic: h('span', { class: 'chip mic' }, '🎙', h('i', { class: 'meter' })),
    blinker: h('span', { class: 'chip blinker' }, '⇦ ⇨'),
    reverse: h('span', { class: 'chip reverse' }, 'РИКВЕРЦ'),
  };
  const gazeLabel = h('div', { class: 'gaze-label' }, '');
  const greenWave = h('div', { class: 'green-wave' });
  const stopBtn = h('button', { class: 'stop' }, h('span', { class: 'fill' }), h('span', { class: 'label' }, 'Заврши (држи)'));
  const demoSlider = demo ? h('input', { type: 'range', class: 'demo-speed', min: 0, max: 130, step: 5, value: demoSpeed, onInput: (e) => (demoSpeed = Number(e.target.value)) }) : null;

  const hud = h(
    'div',
    { class: 'drive' },
    roadVideo,
    overlay,
    h(
      'div',
      { class: 'hud' },
      h('div', { class: 'hud-top' }, banner, sirenBanner),
      h('div', { class: 'hud-left' }, speedEl, h('div', { class: 'unit' }, 'km/h'), limitEl, greenWave, demoSlider),
      h('div', { class: 'hud-right' }, scoreEl, eventsEl, h('div', { class: 'chips' }, Object.values(chips))),
      h('div', { class: 'hud-bottom' }, pill, stopBtn),
      h('div', { class: 'pip' }, driverVideo, gazeLabel),
    ),
  );

  let bannerTimer = null;
  const showBanner = (text, kind = 'warn') => {
    banner.textContent = text;
    banner.className = `banner show ${kind}`;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => (banner.className = 'banner'), 4500);
  };
  let pillTimer = null;
  const showPill = (text, kind) => {
    pill.textContent = text;
    pill.className = `pill show ${kind}`;
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => (pill.className = 'pill'), 5000);
  };

  const describeManeuver = (m) => {
    const parts = [`${MANEUVER_TYPES[m.type]?.label ?? m.type}${m.dir && m.type !== 'reverse' ? ' ' + DIRECTION_LABELS[m.dir] : ''}`];
    if (m.blinker != null) parts.push(m.blinker ? 'жмигавец ✓' : 'жмигавец ✗');
    if (m.mirrors) parts.push({ full: 'ретровизори ✓', partial: 'ретровизор ½', none: 'ретровизор ✗' }[m.mirrors]);
    if (m.lineType === 'solid') parts.push('полна линија ✗');
    return parts.join(' · ');
  };

  // ---- start ------------------------------------------------------------
  async function start() {
    startBtn.disabled = true;
    if (demo && !demoFile) throw new Error('Прво избери видео.');
    voice.unlock();
    if (!demo) await requestMotionPermission();
    attempt(() => document.documentElement.requestFullscreen?.());
    attempt(() => screen.orientation?.lock?.('landscape'));

    let note = null;
    if (demo) {
      streams.road = URL.createObjectURL(demoFile);
      if (settings.cameraMode === 'both' || settings.cameraMode === 'driver') {
        try {
          streams.driver = (await openCameras('driver')).driver;
        } catch {
          streams.driver = null;
        }
      }
    } else {
      try {
        const cams = await openCameras(settings.cameraMode);
        streams.road = cams.road;
        streams.driver = cams.driver;
        note = cams.note;
      } catch (err) {
        note = `Камерата не е достапна (${err.message}) – продолжувам без неа.`;
      }
    }
    try {
      streams.mic = await openMicrophone();
    } catch {
      note = note ?? 'Микрофонот не е дозволен – жмигавец и сирени нема да се слушаат.';
    }

    mount(root, hud);
    document.body.classList.add('driving');
    if (streams.road) await attach(roadVideo, streams.road);
    else hud.classList.add('no-road');
    if (streams.driver) await attach(driverVideo, streams.driver);
    else hud.querySelector('.pip').hidden = true;
    if (note) showBanner(note, 'info');

    session = new DriveSession({
      settings,
      voice,
      hud: {
        onEvent: (e) => {
          const meta = EVENT_TYPES[e.type];
          showPill(`${eventLabel(e.type)}`, meta?.penalty ? 'bad' : 'info');
        },
        onAlert: (a) => {
          if (a.kind === 'siren') return; // the flashing siren banner covers it
          const text = ALERT_TEXT[a.kind]?.(a);
          if (text) showBanner(text, ['collision', 'pedestrian', 'animal', 'siren', 'drowsy', 'distraction'].includes(a.kind) ? 'danger' : 'warn');
        },
        onManeuver: (m) => showPill(describeManeuver(m), m.mirrors === 'none' || m.blinker === false || m.lineType === 'solid' ? 'bad' : 'good'),
        onStatus: (st) => {
          if (st.type === 'road_error') showBanner(`Камерата кон патот: ${st.message}`, 'info');
          if (st.type === 'driver_error') showBanner(`Камерата кон возачот: ${st.message}`, 'info');
          if (st.type === 'mount_moved') showBanner('Телефонот се помести во држачот – повторна калибрација…', 'info');
        },
        onGreenWave: (a) => {
          const text = GREEN_TEXT[a.action]?.(a);
          if (text) showPill(text, a.action === 'ease' || a.action === 'slow' ? 'green' : 'good');
        },
      },
    });
    await session.start({
      roadVideo: streams.road ? roadVideo : null,
      roadCanvas: overlay,
      driverVideo: streams.driver ? driverVideo : null,
      micStream: streams.mic,
      demo: demo ? { speedKmh: () => demoSpeed } : null,
      signals: await loadSignals(),
    });
    const hello = demo ? 'start_demo' : 'start';
    voice.say(PHRASES[hello], { key: hello, cooldownMs: 0 });

    wakeLock = await attempt(() => navigator.wakeLock?.request('screen'));
    liveTimer = setInterval(updateHud, 250);
  }

  function updateHud() {
    if (!session) return;
    const L = session.live();
    speedEl.textContent = L.speedKmh ?? '—';
    const limit = L.limit?.limit;
    limitEl.textContent = limit ?? '—';
    limitEl.title = L.limit?.source === 'osm' ? `од OpenStreetMap${L.limit.road ? ` – ${L.limit.road}` : ''}` : 'стандардно ограничување';
    speedEl.classList.toggle('over', limit != null && L.speedKmh != null && L.speedKmh > limit + 5);
    scoreEl.textContent = L.score ?? '—';
    eventsEl.textContent = `${L.events} настани · ${L.distanceKm.toFixed(1)} km`;
    chips.gps.textContent = L.speedKmh != null ? 'GPS ✓' : 'GPS …';
    chips.gps.classList.toggle('ok', L.speedKmh != null);
    if (session.caps?.motion) {
      const learned = L.calibration?.forward === 'learned';
      chips.motion.textContent = learned ? 'Сензори ✓' : 'Сензори учат…';
      chips.motion.classList.toggle('ok', learned);
    } else chips.motion.hidden = true;
    if (L.roadStats?.backend) {
      chips.road.textContent = `Пат ${Math.round(L.roadStats.fps)} fps`;
      chips.road.title = `YOLOv8 на ${L.roadStats.backend}, ${Math.round(L.roadStats.inferMs)} ms; линии: ${L.roadStats.laneModel ? 'YOLOv8-seg' : 'вграден детектор'}`;
      chips.road.classList.add('ok');
    } else if (!session.caps?.roadCam) chips.road.hidden = true;
    if (session.caps?.driverCam) {
      const zone = L.gaze?.face ? GAZE_ZONES[L.gaze.zone] ?? 'учам…' : 'нема лице';
      chips.driver.textContent = `Возач: ${zone}`;
      chips.driver.classList.toggle('ok', !!L.gaze?.face);
      gazeLabel.textContent = zone;
    } else chips.driver.hidden = true;
    if (session.caps?.audio) {
      const level = Math.max(0, Math.min(1, ((L.audioLevel ?? -100) + 70) / 60));
      chips.mic.querySelector('.meter').style.width = `${Math.round(level * 100)}%`;
    } else chips.mic.hidden = true;
    chips.blinker.classList.toggle('on', !!L.blinker);
    chips.reverse.classList.toggle('on', L.motion?.motion === 'reverse');
    sirenBanner.classList.toggle('show', !!L.siren);
    renderGreenWave(L.greenWave);
  }

  // Compact green-wave widget under the speed: light dot + countdown, advised
  // speed, and how many signals lie ahead.
  function renderGreenWave(a) {
    if (!a) {
      greenWave.className = 'green-wave';
      greenWave.replaceChildren();
      return;
    }
    const red = a.nowState === 'red';
    greenWave.className = `green-wave show ${red ? 'red' : 'green'}`;
    const label =
      a.action === 'slow' || a.action === 'keep'
        ? `${a.targetKmh}`
        : a.action === 'speed'
          ? `${a.targetKmh}↑`
          : a.action === 'ease'
            ? '—'
            : `${a.targetKmh}`;
    greenWave.replaceChildren(
      h('span', { class: 'gw-dot' }),
      h('span', { class: 'gw-count' }, `${a.secondsToChange}s`),
      h('span', { class: 'gw-speed' }, a.action === 'ease' ? 'пушти гас' : `${label} km/h`),
      a.countAhead > 1 ? h('span', { class: 'gw-ahead' }, `${a.countAhead} семафори`) : null,
    );
  }

  // Touching the screen while moving = using the phone (except the stop button).
  hud.addEventListener('pointerdown', (e) => {
    if (!stopBtn.contains(e.target) && e.target !== demoSlider) session?.touched();
  });

  const onVisibility = async () => {
    if (!session) return;
    if (document.visibilityState === 'hidden') {
      const v = session.speed;
      if (v != null && v > 3) session.event(makeEvent('phone_use', Date.now(), { speedKmh: Math.round(v * 3.6), detail: 'app_hidden', source: 'app' }), { cooldownMs: 60000 });
    } else if (wakeLock?.released !== false) {
      wakeLock = await attempt(() => navigator.wakeLock?.request('screen'));
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Hold-to-stop so a bump cannot end the drive.
  let holdTimer = null;
  const cancelHold = () => {
    clearTimeout(holdTimer);
    stopBtn.classList.remove('holding');
  };
  stopBtn.addEventListener('pointerdown', () => {
    stopBtn.classList.add('holding');
    holdTimer = setTimeout(finish, 1000);
  });
  stopBtn.addEventListener('pointerup', cancelHold);
  stopBtn.addEventListener('pointerleave', cancelHold);

  async function finish() {
    if (finished || !session) return;
    finished = true;
    const trip = teardown();
    await saveTrip(trip);
    voice.say(PHRASES.end, { key: 'end', cooldownMs: 0 });
    uploadTrip(trip).catch(() => toast('Возењето е зачувано на телефонот и ќе се испрати подоцна.'));
    go(`/summary/${trip.id}`);
  }

  function teardown() {
    clearInterval(liveTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    document.body.classList.remove('driving');
    const trip = session?.stop();
    session = null;
    stopStream(streams.driver);
    stopStream(streams.mic);
    if (typeof streams.road === 'string') URL.revokeObjectURL(streams.road);
    else stopStream(streams.road);
    attempt(() => wakeLock?.release?.());
    if (document.fullscreenElement) attempt(() => document.exitFullscreen?.());
    return trip;
  }

  // Leaving the screen any other way still saves the drive.
  return () => {
    if (session && !finished) {
      finished = true;
      const trip = teardown();
      saveTrip(trip).then(() => uploadTrip(trip)).catch(() => {});
    } else {
      document.removeEventListener('visibilitychange', onVisibility);
      document.body.classList.remove('driving');
    }
  };
}
