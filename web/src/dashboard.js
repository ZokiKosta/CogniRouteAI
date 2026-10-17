// Dashboard: progress over time for a driver, every trip with its route,
// events, maneuvers and the AI coach.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CATEGORIES, DIRECTION_LABELS, EVENT_TYPES, MANEUVER_TYPES, eventLabel, formatDateTime, formatDayMonth } from '../../shared/events.js';
import { scoreLabel } from '../../shared/scoring.js';
import { driverStats } from '../../shared/stats.js';
import { barList, lineChart, meters, table, tableToggle } from './charts.js';

const $ = (id) => document.getElementById(id);
const driverSelect = $('driver');
const periodSelect = $('period');
const content = $('content');
let trips = [];
let map = null;
let refreshTrend = () => {};
let refreshEvents = () => {};

const fmtDate = formatDayMonth;
const fmtDateTime = formatDateTime;
const fmtMin = (s) => ((s ?? 0) < 60 ? `${Math.round(s ?? 0)} с` : `${Math.round(s / 60)} мин`);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.status === 204 ? null : res.json();
}

function tile(label, value, delta = null, hero = false) {
  const t = el('div', `tile${hero ? ' hero-tile' : ''}`);
  t.append(el('span', 'label', label), el('span', 'value', value));
  if (delta) t.append(el('span', `delta ${delta.dir ?? ''}`, delta.text));
  return t;
}

function periodTrips() {
  const days = Number(periodSelect.value);
  if (!days) return trips;
  const from = Date.now() - days * 86400000;
  return trips.filter((t) => t.startedAt >= from);
}

function renderOverview() {
  const list = periodTrips();
  const stats = driverStats(list);
  const kpis = $('kpis');
  kpis.replaceChildren();
  if (!list.length) {
    kpis.append(tile('Просечна оценка', '—', null, true));
  } else {
    const trend = stats.trend;
    kpis.append(
      tile(
        'Просечна оценка',
        stats.avgScore ?? '—',
        trend != null ? { text: `${trend > 0 ? '▲ +' : trend < 0 ? '▼ ' : ''}${trend} последните 5 возења наспроти претходните 5`, dir: trend > 0 ? 'up' : trend < 0 ? 'down' : '' } : { text: scoreLabel(stats.avgScore) },
        true,
      ),
      tile('Возења', String(stats.trips)),
      tile('Километри', stats.km.toLocaleString('mk-MK')),
      tile('Часови возење', stats.hours.toLocaleString('mk-MK')),
      tile('Жмигавец пред маневар', stats.maneuvers.blinkerRate != null ? `${Math.round(stats.maneuvers.blinkerRate * 100)}%` : '—'),
      tile('Целосна проверка на ретровизори', stats.maneuvers.mirrorRate != null ? `${Math.round(stats.maneuvers.mirrorRate * 100)}%` : '—'),
    );
  }

  const points = stats.series.map((p) => ({ label: fmtDate(p.t), value: p.score, sub: `${fmtDateTime(p.t)} · ${p.km ?? 0} km` }));
  lineChart($('trend'), points, { refs: [{ y: 90, label: 'одлично (90)' }] });
  refreshTrend();

  const top = stats.events.filter((e) => (EVENT_TYPES[e.type]?.penalty ?? 0) > 0).slice(0, 8);
  if (top.length) barList($('events'), top.map((e) => ({ name: e.label, value: e.count, detail: e.per100km != null ? `${e.label} · ${e.per100km} на 100 km` : e.label })));
  else $('events').replaceChildren(el('p', 'empty', 'Нема грешки во овој период.'));
  refreshEvents();

  meters(
    $('categories'),
    Object.entries(CATEGORIES).map(([key, c]) => ({ label: c.label, value: stats.categories[key] })),
  );

  renderTripTable(list);
}

function renderTripTable(list) {
  const box = $('trips');
  if (!list.length) {
    box.replaceChildren(emptyState());
    return;
  }
  const t = table([['Датум', 'Возач', 'km', 'Време', 'Настани', 'Маневри', 'Оценка'], ...list.map((x) => [fmtDateTime(x.startedAt), x.driverName ?? '—', String(x.distanceKm ?? 0), fmtMin(x.durationS), String(x.eventCount), String(x.stats?.maneuvers?.total ?? 0), ''])], [2, 4, 5, 6]);
  [...t.tBodies[0].rows].forEach((row, i) => {
    const trip = list[i];
    row.className = 'clickable';
    row.tabIndex = 0;
    const badge = el('span', 'score-badge', trip.score ?? '—');
    row.cells[6].replaceChildren(badge);
    row.cells[1].classList.add('hide-sm');
    const open = () => showTrip(trip.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => e.key === 'Enter' && open());
  });
  t.tHead.rows[0].cells[1].classList.add('hide-sm');
  box.replaceChildren(t);
}

function emptyState() {
  const box = el('div', 'empty');
  box.append(
    el('p', '', 'Сè уште нема возења.'),
    el('p', '', 'Вози со мобилната апликацијата или вчитај демо податоци:'),
    Object.assign(el('code', '', 'npm run seed'), {}),
  );
  return box;
}

function severity(type) {
  const p = EVENT_TYPES[type]?.penalty ?? 0;
  return p >= 5 ? 'critical' : p > 0 ? 'serious' : 'info';
}

async function showTrip(id) {
  const detail = $('detail');
  detail.classList.add('refreshing');
  const trip = await api(`/api/trips/${encodeURIComponent(id)}`);
  history.replaceState(null, '', `?trip=${encodeURIComponent(id)}`);
  document.querySelectorAll('#trips tr.selected').forEach((r) => r.classList.remove('selected'));
  detail.hidden = false;
  detail.classList.remove('refreshing');

  const head = el('div', 'card-head');
  head.append(el('h2', '', `Возење ${fmtDateTime(trip.startedAt)} · ${trip.distanceKm ?? 0} km · ${fmtMin(trip.durationS)}`), el('span', 'score-badge', `${trip.score?.overall ?? '—'} · ${scoreLabel(trip.score?.overall)}`));

  const mapBox = el('div');
  mapBox.id = 'map';
  const legend = el('div', 'legend');
  const key = (cls, label, line = false) => {
    const k = el('span', 'key');
    const sw = el('span', `sw${line ? ' line' : ''}`);
    if (!line) sw.style.background = { critical: 'var(--critical)', serious: 'var(--serious)', info: 'var(--muted)' }[cls];
    k.append(sw, document.createTextNode(label));
    return k;
  };
  legend.append(key(null, 'Рута', true), key('critical', '⛔ Сериозна грешка'), key('serious', '⚠️ Грешка'), key('info', 'ℹ️ Информација'));
  const mapCard = el('section', 'card');
  mapCard.append(head, mapBox, legend);

  const timeline = el('div', 'timeline');
  for (const e of trip.events) {
    const row = el('div', 'ev');
    const icon = { critical: '⛔', serious: '⚠️', info: 'ℹ️' }[severity(e.type)];
    const text = el('div');
    text.append(el('strong', '', eventLabel(e.type)), el('small', '', [e.speedKmh != null ? `${e.speedKmh} km/h` : null, e.value != null ? `${e.value} ${e.unit ?? ''}` : null, e.dir ? DIRECTION_LABELS[e.dir] : null].filter(Boolean).join(' · ')));
    row.append(el('time', '', `${Math.round((e.t - trip.startedAt) / 60000)}. мин`), el('span', '', icon), text);
    timeline.append(row);
  }
  if (!trip.events.length) timeline.append(el('p', 'empty', 'Нема настани.'));
  const evCard = el('section', 'card');
  evCard.append(el('h2', '', `Настани (${trip.events.length})`), timeline);

  const maneuverCard = el('section', 'card');
  maneuverCard.append(el('h2', '', `Маневри (${trip.maneuvers.length})`));
  if (trip.maneuvers.length) {
    const mark = (v, map) => (v == null ? '—' : map[v] ?? String(v));
    maneuverCard.append(
      table(
        [
          ['Маневар', 'Жмигавец', 'Ретровизори', 'Редослед'],
          ...trip.maneuvers.map((m) => [
            `${MANEUVER_TYPES[m.type]?.label ?? m.type}${m.dir && m.type !== 'reverse' ? ' ' + DIRECTION_LABELS[m.dir] : ''}${m.lineType === 'solid' ? ' (полна линија!)' : ''}`,
            m.type === 'reverse' ? '' : mark(m.blinker, { true: '✓', false: '✗' }),
            mark(m.mirrors, { full: '✓ сите', partial: '½ делумно', none: '✗ без' }),
            mark(m.order, { mirror_first: 'ретровизор → жмигавец ✓', blinker_first: 'жмигавец пред ретровизор' }),
          ]),
        ],
        [],
      ),
    );
  } else maneuverCard.append(el('p', 'empty', 'Нема маневри.'));

  const coachCard = el('section', 'card coach-card');
  const coachBody = el('div');
  const coachBtn = el('button', 'btn primary', '🤖 Совети од AI инструкторот');
  coachCard.append(el('h2', '', 'AI инструктор'), coachBody, coachBtn);
  const showCoaching = (c) => {
    coachBody.replaceChildren(el('p', 'headline', c.headline));
    if (c.praise?.length) {
      const ul = el('ul');
      c.praise.forEach((p) => ul.append(el('li', '', p)));
      coachBody.append(el('h3', '', 'Добро'), ul);
    }
    const ol = el('ol', 'tips');
    c.tips.forEach((t) => {
      const li = el('li');
      li.append(el('strong', '', t.title), document.createTextNode(` – ${t.text}`));
      ol.append(li);
    });
    coachBody.append(el('h3', '', 'Совети'), ol, el('p', 'goal', `🏁 ${c.goal}`), el('p', 'hint', c.source === 'claude' ? `Claude${c.model ? ` (${c.model})` : ''}` : 'Совети според правила'));
    coachBtn.textContent = 'Нови совети';
  };
  coachBtn.addEventListener('click', async () => {
    coachBtn.disabled = true;
    coachBtn.textContent = 'Размислува…';
    try {
      showCoaching(await api(`/api/trips/${encodeURIComponent(id)}/coach${trip.coaching ? '?refresh=1' : ''}`, { method: 'POST' }));
    } catch (err) {
      coachBody.replaceChildren(el('p', '', `Грешка: ${err.message}`));
    } finally {
      coachBtn.disabled = false;
    }
  });
  if (trip.coaching) showCoaching(trip.coaching);

  const grid = el('div', 'detail');
  const right = el('div');
  right.style.display = 'grid';
  right.style.gap = '16px';
  right.append(coachCard, evCard);
  grid.append(mapCard, right);
  detail.replaceChildren(grid, maneuverCard);
  maneuverCard.style.marginTop = '16px';
  drawMap(mapBox, trip);
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drawMap(box, trip) {
  map?.remove();
  map = L.map(box, { scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const route = trip.route.map((p) => [p[0], p[1]]);
  const color = getComputedStyle(document.documentElement).getPropertyValue('--series-1').trim() || '#2a78d6';
  if (route.length > 1) {
    const line = L.polyline(route, { color, weight: 4, opacity: 0.9 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [24, 24] });
  } else map.setView(route[0] ?? [41.9965, 21.4314], 14);
  for (const e of trip.events) {
    if (!Number.isFinite(e.lat)) continue;
    const sev = severity(e.type);
    const icon = L.divIcon({ className: '', html: `<div class="event-marker ${sev}">${CATEGORIES[EVENT_TYPES[e.type]?.category]?.icon ?? '•'}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    const marker = L.marker([e.lat, e.lon], { icon, title: eventLabel(e.type) }).addTo(map);
    const tip = document.createElement('div');
    tip.append(el('strong', '', eventLabel(e.type)), el('div', '', [e.speedKmh != null ? `${e.speedKmh} km/h` : null, e.value != null ? `${e.value} ${e.unit ?? ''}` : null].filter(Boolean).join(' · ')));
    marker.bindTooltip(tip);
  }
}

async function loadTrips() {
  content.classList.add('refreshing');
  const driverId = driverSelect.value;
  try {
    trips = await api(`/api/trips?limit=500${driverId ? `&driverId=${encodeURIComponent(driverId)}` : ''}`);
  } catch {
    trips = [];
  }
  content.classList.remove('refreshing');
  renderOverview();
}

async function init() {
  try {
    const health = await api('/api/health');
    $('ai-status').textContent = health.ai ? `AI совети: Claude (${health.model})` : 'AI совети: според правила (без API клуч)';
  } catch {
    $('ai-status').textContent = 'Серверот не е достапен';
  }
  let drivers = [];
  try {
    drivers = await api('/api/drivers');
  } catch {
    drivers = [];
  }
  driverSelect.replaceChildren(new Option('Сите возачи', ''));
  for (const d of drivers) driverSelect.append(new Option(`${d.name ?? 'Непознат'} (${d.trips})`, d.id ?? ''));
  if (drivers.length === 1) driverSelect.value = drivers[0].id ?? '';

  refreshTrend = tableToggle($('trend-toggle'), $('trend'), () => {
    const stats = driverStats(periodTrips());
    return table([['Датум', 'km', 'Оценка'], ...stats.series.map((p) => [fmtDateTime(p.t), String(p.km ?? 0), String(p.score ?? '—')])], [1, 2]);
  });
  refreshEvents = tableToggle($('events-toggle'), $('events'), () => {
    const stats = driverStats(periodTrips());
    return table([['Настан', 'Број', 'На 100 km'], ...stats.events.map((e) => [e.label, String(e.count), e.per100km != null ? String(e.per100km) : '—'])], [1, 2]);
  });

  driverSelect.addEventListener('change', loadTrips);
  periodSelect.addEventListener('change', renderOverview);
  await loadTrips();
  const tripParam = new URLSearchParams(location.search).get('trip');
  if (tripParam) showTrip(tripParam).catch(() => {});
}

init();
