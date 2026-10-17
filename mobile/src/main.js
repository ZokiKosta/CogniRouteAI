// CogniRouteAI mobile app: hash router and the small screens.
import { scoreLabel } from '../../shared/scoring.js';
import { loadSettings, saveSettings } from './state.js';
import { deleteTrip, listTrips, syncPending } from './storage.js';
import { formatDate, formatDuration, h, mount, scoreColor, scoreRing, toast } from './ui.js';
import { renderSetup } from './screens/setup.js';
import { renderCalibrate } from './screens/calibrate.js';
import { renderDrive } from './screens/drive.js';
import { renderSummary } from './screens/summary.js';

const app = document.getElementById('app');
let cleanup = null;

export function go(path) {
  if (location.hash !== `#${path}`) location.hash = path;
  else route();
}

async function route() {
  cleanup?.();
  cleanup = null;
  window.scrollTo(0, 0);
  const settings = loadSettings();
  const [path, arg] = location.hash.replace(/^#\/?/, '').split('/');
  if (!settings.consent && path !== 'welcome') return go('/welcome');
  document.body.dataset.screen = path || 'home';
  const screens = {
    '': renderHome,
    welcome: renderWelcome,
    setup: renderSetup,
    calibrate: renderCalibrate,
    drive: (root, ctx) => renderDrive(root, { ...ctx, demo: false }),
    demo: (root, ctx) => renderDrive(root, { ...ctx, demo: true }),
    summary: (root, ctx) => renderSummary(root, { ...ctx, id: arg }),
    history: renderHistory,
    settings: renderSettings,
  };
  const render = screens[path] ?? renderHome;
  cleanup = (await render(app, { go })) ?? null;
}

function header(title, back = true) {
  return h('header', { class: 'topbar' }, back ? h('button', { class: 'icon-btn', 'aria-label': 'Назад', onClick: () => go('/') }, '‹') : h('img', { src: '/icons/icon.svg', alt: '', class: 'logo' }), h('h1', {}, title));
}

async function renderHome(root) {
  const s = loadSettings();
  const trips = await listTrips();
  const last = trips[0];
  const pending = trips.filter((t) => !t.synced).length;
  const check = (done, label, hint, path) =>
    h('button', { class: `check ${done ? 'done' : ''}`, onClick: () => go(path) }, h('span', { class: 'mark' }, done ? '✓' : '•'), h('span', {}, h('strong', {}, label), h('small', {}, hint)), h('span', { class: 'chev' }, '›'));

  mount(
    root,
    header(s.driverName ? `Здраво, ${s.driverName}` : 'CogniRouteAI', false),
    h(
      'main',
      { class: 'home' },
      h('button', { class: 'start', onClick: () => go('/drive') }, h('span', { class: 'start-icon' }, '▶'), 'Започни возење'),
      h('p', { class: 'muted center' }, 'Стави го телефонот во држачот, па притисни старт. Додека возиш, советите ги слушаш – не допирај го екранот.'),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'Подготовка'),
        check(s.mountDone, 'Држач и камера', 'Хоризонт, хауба и средина на возилото', '/setup'),
        check(!!s.gazeCalibration, 'Ретровизори', 'Каде гледаш кога проверуваш ретровизор', '/calibrate'),
        check(!!s.blinkerTemplate, 'Звук на жмигавецот', 'Препознавање на твојот жмигавец', '/calibrate'),
      ),
      last
        ? h(
            'section',
            { class: 'card last-trip', onClick: () => go(`/summary/${last.id}`) },
            scoreRing(last.score?.overall, 76),
            h('div', {}, h('h2', {}, 'Последно возење'), h('p', {}, `${formatDate(last.startedAt)} · ${last.distanceKm ?? 0} km · ${formatDuration(last.durationS)}`), h('p', { style: { color: scoreColor(last.score?.overall) } }, scoreLabel(last.score?.overall))),
          )
        : null,
      h(
        'nav',
        { class: 'grid-links' },
        h('button', { onClick: () => go('/history') }, '🕘 Историја'),
        h('button', { onClick: () => go('/demo') }, '🎬 Демо со видео'),
        h('button', { onClick: () => go('/settings') }, '⚙️ Поставки'),
        h('a', { class: 'button', href: '/dashboard' }, '📊 Контролна табла'),
      ),
      pending ? h('p', { class: 'muted center' }, `${pending} возења чекаат да се испратат на серверот.`) : null,
    ),
  );
}

function renderWelcome(root) {
  const s = loadSettings();
  const name = h('input', { type: 'text', value: s.driverName, placeholder: 'на пр. Марко', maxLength: 40, autocomplete: 'given-name' });
  const consent = h('input', { type: 'checkbox', checked: s.consent });
  mount(
    root,
    h(
      'main',
      { class: 'welcome' },
      h('img', { src: '/icons/icon.svg', alt: '', class: 'hero-logo' }),
      h('h1', {}, 'CogniRouteAI'),
      h('p', { class: 'lead' }, 'Твојот AI инструктор за возење. Додека возиш, телефонот ги следи патот, твоето внимание и маневрите, и ти дава совети со глас.'),
      h(
        'ul',
        { class: 'feature-list' },
        h('li', {}, '🚗 Камера кон патот: возила, пешаци, полни линии, растојание (YOLOv8)'),
        h('li', {}, '👀 Камера кон тебе: ретровизори пред маневар, поспаност, поглед надолу'),
        h('li', {}, '🎧 Микрофон: жмигавец и сирени на брза помош'),
        h('li', {}, '📈 Сензори и GPS: нагло кочење, свртување, рикверц, брзина'),
      ),
      h('label', { class: 'field' }, 'Твоето име', name),
      h(
        'label',
        { class: 'consent' },
        consent,
        h('span', {}, 'Разбирам: сликата и звукот се обработуваат на телефонот и не се снимаат; на серверот се праќа само резиме на возењето (настани, рута, оценка). Нема да го допирам телефонот додека возам, а држачот нема да ми го попречува видот.'),
      ),
      h(
        'button',
        {
          class: 'primary',
          onClick: () => {
            if (!consent.checked) return toast('Потребна е согласност за да продолжиш.', 'warn');
            saveSettings({ driverName: name.value.trim(), consent: true });
            go(loadSettings().mountDone ? '/' : '/setup');
          },
        },
        'Продолжи',
      ),
    ),
  );
}

async function renderHistory(root) {
  const trips = await listTrips();
  const list = h('div', { class: 'trip-list' });
  const draw = (items) =>
    mount(
      list,
      items.length
        ? items.map((t) =>
            h(
              'button',
              { class: 'trip-row', onClick: () => go(`/summary/${t.id}`) },
              h('span', { class: 'score-chip', style: { background: scoreColor(t.score?.overall) } }, t.score?.overall ?? '—'),
              h('span', { class: 'grow' }, h('strong', {}, formatDate(t.startedAt)), h('small', {}, `${t.distanceKm ?? 0} km · ${formatDuration(t.durationS)} · ${t.events?.length ?? 0} настани`)),
              h('span', { class: 'sync', title: t.synced ? 'испратено' : 'чека' }, t.synced ? '☁️' : '⏳'),
            ),
          )
        : h('p', { class: 'muted center' }, 'Сè уште нема возења.'),
    );
  draw(trips);
  mount(
    root,
    header('Историја'),
    h(
      'main',
      {},
      list,
      h(
        'button',
        {
          onClick: async () => {
            const n = await syncPending();
            toast(n ? `Испратени ${n} возења.` : 'Нема што да се испрати или серверот не е достапен.');
            draw(await listTrips());
          },
        },
        'Испрати на серверот',
      ),
    ),
  );
}

function renderSettings(root) {
  const s = loadSettings();
  const field = (label, input, hint) => h('label', { class: 'field' }, label, input, hint ? h('small', {}, hint) : null);
  const select = (key, options) => {
    const el = h('select', { onChange: () => saveSettings({ [key]: el.value }) }, options.map(([v, l]) => h('option', { value: v, selected: s[key] === v }, l)));
    return el;
  };
  const number = (key, min, max, step = 1) => {
    const el = h('input', { type: 'number', min, max, step, value: s[key], onChange: () => saveSettings({ [key]: Number(el.value) }) });
    return el;
  };
  const toggle = (key) => {
    const el = h('input', { type: 'checkbox', checked: !!s[key], onChange: () => saveSettings({ [key]: el.checked }) });
    return el;
  };
  const name = h('input', { type: 'text', value: s.driverName, maxLength: 40, onChange: () => saveSettings({ driverName: name.value.trim() }) });
  const server = h('input', { type: 'url', value: s.serverUrl, placeholder: 'истиот сервер', onChange: () => saveSettings({ serverUrl: server.value.trim() }) });
  mount(
    root,
    header('Поставки'),
    h(
      'main',
      { class: 'settings' },
      field('Име на возачот', name),
      field('Камери', select('cameraMode', [['both', 'Двете (пат + возач)'], ['road', 'Само кон патот'], ['driver', 'Само кон возачот'], ['none', 'Без камера']]), 'Ако телефонот не дозволува две камери, се користи камерата кон патот.'),
      field('Квалитет на детекција', select('quality', [['fast', 'Брзо (320 px)'], ['quality', 'Подетално (640 px, побрз телефон)']])),
      field('Видно поле на камерата (°)', number('hfovDeg', 40, 100), 'Потребно за проценка на растојание. Главната камера е обично 60–70°.'),
      field('Ограничување кога не е познато (km/h)', number('defaultLimit', 20, 130, 10)),
      h('label', { class: 'toggle' }, toggle('osmLimits'), 'Ограничувања од OpenStreetMap'),
      h('label', { class: 'toggle' }, toggle('voice'), 'Гласовни совети'),
      h('label', { class: 'toggle' }, toggle('greenWaveDemo'), 'Зелен бран (демо коридор во Скопје)'),
      field('Адреса на серверот', server, 'Празно = истиот сервер од кој е отворена апликацијата.'),
      h('div', { class: 'row' }, h('button', { onClick: () => go('/setup') }, 'Држач и камера'), h('button', { onClick: () => go('/calibrate') }, 'Калибрација')),
      h(
        'button',
        {
          class: 'danger',
          onClick: async () => {
            if (!confirm('Да се избришат сите возења зачувани на овој телефон?')) return;
            for (const t of await listTrips()) await deleteTrip(t.id);
            toast('Избришано.');
          },
        },
        'Избриши ги локалните возења',
      ),
      h('p', { class: 'muted small' }, `ID на уредот: ${s.driverId}`),
    ),
  );
}

window.addEventListener('hashchange', route);
window.addEventListener('online', () => syncPending());
route();
syncPending();

// Offline support only in the built app (it would fight with hot reload in dev).
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js', { scope: '/app/' }).catch(() => {});
}
