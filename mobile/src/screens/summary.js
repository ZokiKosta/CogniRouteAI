// After the drive: score, categories, maneuvers, what went wrong and how to
// improve, plus the AI coach (Claude on the server, rules when offline).
import { ruleBasedCoaching, summarizeTrip } from '../../../shared/coach.js';
import { CATEGORIES, DIRECTION_LABELS, EVENT_TYPES, MANEUVER_TYPES, eventLabel } from '../../../shared/events.js';
import { scoreLabel } from '../../../shared/scoring.js';
import { fetchCoaching, getTrip, uploadTrip } from '../storage.js';
import { formatDate, formatDuration, h, mount, scoreColor, scoreRing, toast } from '../ui.js';

const MIRRORS = { full: '✓', partial: '½', none: '✗' };

export async function renderSummary(root, { go, id }) {
  const trip = await getTrip(id);
  const header = h('header', { class: 'topbar' }, h('button', { class: 'icon-btn', 'aria-label': 'Назад', onClick: () => go('/') }, '‹'), h('h1', {}, 'Резиме од возењето'));
  if (!trip) {
    mount(root, header, h('main', {}, h('p', {}, 'Возењето не е пронајдено на овој телефон.')));
    return;
  }
  const score = trip.score?.overall;
  const coachBox = h('div', { class: 'coach' });

  const groups = {};
  for (const e of trip.events) (groups[e.type] ??= []).push(e);
  const eventRows = Object.entries(groups)
    .sort((a, b) => (EVENT_TYPES[b[0]]?.penalty ?? 0) * b[1].length - (EVENT_TYPES[a[0]]?.penalty ?? 0) * a[1].length)
    .map(([type, list]) =>
      h(
        'details',
        { class: `event-group ${EVENT_TYPES[type]?.penalty ? 'bad' : 'info'}` },
        h('summary', {}, h('strong', {}, eventLabel(type)), h('span', { class: 'count' }, `×${list.length}`)),
        h('p', {}, EVENT_TYPES[type]?.advice ?? ''),
        h(
          'ul',
          {},
          list.slice(0, 8).map((e) => h('li', {}, `${Math.round((e.t - trip.startedAt) / 60000)}. мин${e.speedKmh != null ? ` · ${e.speedKmh} km/h` : ''}${e.value != null ? ` · ${e.value}${e.unit ? ' ' + e.unit : ''}` : ''}`)),
        ),
      ),
    );

  const maneuverRows = trip.maneuvers.map((m) =>
    h(
      'tr',
      {},
      h('td', {}, `${MANEUVER_TYPES[m.type]?.label ?? m.type}${m.dir && m.type !== 'reverse' ? ' ' + DIRECTION_LABELS[m.dir] : ''}`),
      h('td', { class: m.blinker === false ? 'bad' : '' }, m.type === 'reverse' ? '' : m.blinker == null ? '—' : m.blinker ? '✓' : '✗'),
      h('td', { class: m.mirrors === 'none' ? 'bad' : '' }, m.mirrors ? MIRRORS[m.mirrors] : '—'),
      h('td', { class: m.lineType === 'solid' ? 'bad' : '' }, m.lineType === 'solid' ? 'полна ✗' : m.lineType === 'dashed' ? 'испрек.' : ''),
    ),
  );

  function renderCoaching(c) {
    mount(
      coachBox,
      h('p', { class: 'coach-headline' }, c.headline),
      c.praise?.length ? h('div', {}, h('h3', {}, '👍 Добро'), h('ul', {}, c.praise.map((p) => h('li', {}, p)))) : null,
      h('div', {}, h('h3', {}, '🎯 Совети'), h('ol', {}, c.tips.map((t) => h('li', {}, h('strong', {}, t.title), ' – ', t.text)))),
      h('p', { class: 'goal' }, '🏁 ', c.goal),
      h('p', { class: 'muted small' }, c.source === 'claude' ? `AI инструктор (Claude${c.model ? ` · ${c.model}` : ''})` : 'Совети според правила', c.note ? ` – ${c.note}` : ''),
    );
  }

  const coachBtn = h('button', {
    class: 'primary',
    onClick: async () => {
      coachBtn.disabled = true;
      coachBtn.textContent = 'AI инструкторот размислува…';
      try {
        if (!trip.synced) await uploadTrip(trip);
        renderCoaching(await fetchCoaching(trip.id));
        coachBtn.remove();
      } catch {
        toast('Серверот не е достапен – совети според правила, без интернет.', 'info');
        renderCoaching(ruleBasedCoaching(summarizeTrip(trip)));
        coachBtn.disabled = false;
        coachBtn.textContent = 'Обиди се повторно со AI';
      }
    },
  }, '🤖 Совети од AI инструкторот');

  mount(
    root,
    header,
    h(
      'main',
      { class: 'summary' },
      h(
        'section',
        { class: 'card score-card' },
        scoreRing(score, 132),
        h('div', {}, h('h2', { style: { color: scoreColor(score) } }, scoreLabel(score)), h('p', {}, formatDate(trip.startedAt)), h('p', { class: 'muted' }, trip.capabilities?.demo ? 'Демо (видео + симулирана брзина)' : trip.driverName ?? '')),
      ),
      h(
        'section',
        { class: 'stats-row' },
        stat('Растојание', `${trip.distanceKm ?? 0} km`),
        stat('Време', formatDuration(trip.durationS)),
        stat('Просек', `${trip.avgSpeedKmh ?? 0} km/h`),
        stat('Максимум', `${trip.maxSpeedKmh ?? 0} km/h`),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'По категории'),
        Object.entries(CATEGORIES).map(([key, c]) => {
          const cat = trip.score?.categories?.[key];
          const measured = cat?.measured;
          return h(
            'div',
            { class: 'bar-row' },
            h('span', {}, `${c.icon} ${c.label}`),
            h('span', { class: 'bar' }, h('i', { style: { width: measured ? `${cat.score}%` : '0%', background: scoreColor(cat?.score) } })),
            h('span', { class: 'bar-value' }, measured ? cat.score : 'не е мерено'),
          );
        }),
      ),
      h('section', { class: 'card' }, h('h2', {}, 'AI инструктор'), coachBox, coachBtn),
      trip.maneuvers.length
        ? h(
            'section',
            { class: 'card' },
            h('h2', {}, `Маневри (${trip.maneuvers.length})`),
            h('table', { class: 'maneuvers' }, h('thead', {}, h('tr', {}, h('th', {}, 'Маневар'), h('th', {}, 'Жмигавец'), h('th', {}, 'Ретровизори'), h('th', {}, 'Линија'))), h('tbody', {}, maneuverRows)),
            h('p', { class: 'muted small' }, 'Правилен редослед: ретровизор → жмигавец → мртов агол → маневар.'),
          )
        : null,
      h('section', { class: 'card' }, h('h2', {}, `Настани (${trip.events.length})`), eventRows.length ? eventRows : h('p', { class: 'muted' }, 'Нема настани – одлично!')),
      h('div', { class: 'row' }, h('a', { class: 'button', href: `/dashboard?trip=${encodeURIComponent(trip.id)}` }, '📊 Во контролната табла'), h('button', { onClick: () => go('/') }, 'Почетна')),
    ),
  );

  if (trip.coaching) renderCoaching(trip.coaching);
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('strong', {}, value), h('small', {}, label));
}
