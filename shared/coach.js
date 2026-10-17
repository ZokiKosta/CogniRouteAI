// Coaching after a drive: a compact trip summary (what the AI coach sees),
// the prompt and output schema for Claude, and a rule-based fallback that
// works offline or without an API key.
import { CATEGORIES, DIRECTION_LABELS, EVENT_TYPES, eventLabel } from './events.js';
import { eventPenalty, scoreLabel } from './scoring.js';

/** The facts about one trip, small enough to send to the language model. */
export function summarizeTrip(trip) {
  const start = new Date(trip.startedAt);
  const counts = {};
  for (const e of trip.events ?? []) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const worst = [...(trip.events ?? [])]
    .filter((e) => eventPenalty(e) > 0)
    .sort((a, b) => eventPenalty(b) - eventPenalty(a))
    .slice(0, 8)
    .map((e) => ({
      type: e.type,
      label: eventLabel(e.type),
      minute: Math.round((e.t - trip.startedAt) / 6000) / 10,
      value: e.value,
      unit: e.unit,
      speedKmh: e.speedKmh,
      limitKmh: e.limitKmh,
      dir: e.dir ? DIRECTION_LABELS[e.dir] : undefined,
      detail: e.detail,
    }));
  const m = trip.maneuvers ?? [];
  return {
    distanceKm: trip.distanceKm,
    durationMin: Math.round((trip.durationS ?? 0) / 60),
    avgSpeedKmh: trip.avgSpeedKmh,
    maxSpeedKmh: trip.maxSpeedKmh,
    startHour: start.getHours(),
    night: start.getHours() >= 20 || start.getHours() < 6,
    score: trip.score?.overall ?? null,
    categories: Object.fromEntries(
      Object.entries(trip.score?.categories ?? {}).map(([k, c]) => [k, c.measured ? c.score : 'не е мерено']),
    ),
    eventCounts: Object.fromEntries(Object.entries(counts).map(([k, n]) => [eventLabel(k), n])),
    worstEvents: worst,
    maneuvers: {
      total: m.length,
      laneChanges: m.filter((x) => x.type === 'lane_change').length,
      turns: m.filter((x) => x.type === 'turn').length,
      reverses: m.filter((x) => x.type === 'reverse').length,
      withBlinker: m.filter((x) => x.blinker === true).length,
      withoutBlinker: m.filter((x) => x.blinker === false).length,
      fullMirrorCheck: m.filter((x) => x.mirrors === 'full').length,
      noMirrorCheck: m.filter((x) => x.mirrors === 'none').length,
      mirrorBeforeBlinker: m.filter((x) => x.order === 'mirror_first').length,
    },
    sensors: {
      roadCamera: !!trip.capabilities?.roadCam,
      driverCamera: !!trip.capabilities?.driverCam,
      microphone: !!trip.capabilities?.audio,
      motion: trip.capabilities?.motion !== false,
    },
  };
}

export const COACH_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'Една реченица: како помина возењето.' },
    praise: { type: 'array', items: { type: 'string' }, description: '1–3 работи што возачот ги направил добро.' },
    tips: {
      type: 'array',
      description: '2–4 конкретни совети, најважниот прв.',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, text: { type: 'string' } },
        required: ['title', 'text'],
        additionalProperties: false,
      },
    },
    goal: { type: 'string', description: 'Една мерлива цел за следното возење.' },
  },
  required: ['headline', 'praise', 'tips', 'goal'],
  additionalProperties: false,
};

export const COACH_SYSTEM_PROMPT = `Ти си искусен и смирен инструктор по возење во Северна Македонија.
Добиваш резиме од едно возење снимено со апликацијата CogniRouteAI: сензори за движење и GPS на телефонот, камера кон патот (YOLOv8 за возила и пешаци, препознавање полни и испрекинати линии), камера кон возачот (поглед во ретровизори, внимание, поспаност) и микрофон (мигавец, сирени).

Напиши кратка повратна информација на македонски јазик (кирилица), директно до возачот (ти-форма).
- Темели се само на податоците; не измислувај настани ни места.
- Поврзувај причини и последици кога податоците го покажуваат тоа (на пр. нагло кочење по блиско следење).
- Кај маневрите потсети на редоследот: ретровизор → мигавец → мртов агол → маневар.
- За сензор што не бил вклучен („не е мерено“) не давај заклучоци.
- Можеш да се повикаш на правилата од Законот за безбедност на сообраќајот на патиштата, без да наведуваш броеви на членови.
- Биди охрабрувачки, но искрен. Совети од една до две реченици, без општи фрази.`;

export function coachingUserMessage(summary, history = []) {
  const past = history.length
    ? `\n\nПретходни возења (од најново): ${JSON.stringify(history.map((h) => ({ score: h.score, distanceKm: h.distanceKm, topEvents: h.topEvents })))}`
    : '';
  return `Резиме од возењето:\n${JSON.stringify(summary, null, 1)}${past}`;
}

/** Same shape as the AI answer, built from the event catalog. */
export function ruleBasedCoaching(summary, history = []) {
  const praise = [];
  for (const [key, score] of Object.entries(summary.categories ?? {})) {
    if (typeof score === 'number' && score >= 90) praise.push(`${CATEGORIES[key].label}: ${score}/100 – одлично.`);
  }
  const m = summary.maneuvers ?? {};
  if (m.withBlinker && !m.withoutBlinker) praise.push('Мигавецот го вклучуваше пред секој маневар.');
  if (m.fullMirrorCheck && !m.noMirrorCheck) praise.push('Ги проверуваше ретровизорите пред маневрите.');

  const byType = {};
  for (const e of summary.worstEvents ?? []) {
    const entry = (byType[e.type] ??= { count: 0, weight: 0, example: e });
    entry.count++;
    entry.weight += EVENT_TYPES[e.type]?.penalty ?? 1;
  }
  const ranked = Object.entries(byType).sort((a, b) => b[1].weight - a[1].weight);
  const tips = ranked
    .slice(0, 3)
    .map(([type, { count, example }]) => ({
      title: `${eventLabel(type)}${count > 1 ? ` (${count}×)` : ''}`,
      text: `${EVENT_TYPES[type]?.advice ?? ''}${describe(example)}`,
    }));
  if (m.withBlinker && m.mirrorBeforeBlinker < m.fullMirrorCheck) {
    tips.push({ title: 'Редослед кај маневрите', text: 'Прво погледни во ретровизор, па вклучи мигавец – така знаеш дали е безбедно пред да најавиш.' });
  }
  if (!tips.length) tips.push({ title: 'Продолжи така', text: 'Немаше значајни грешки. Следниот чекор: возење ноќе или на автопат со истото внимание.' });

  const avg = history.length ? history.reduce((s, h) => s + (h.score ?? 0), 0) / history.length : null;
  const trend = avg != null && summary.score != null ? Math.round(summary.score - avg) : null;
  const headline = `${scoreLabel(summary.score)} возење – ${summary.score ?? '—'}/100${trend ? ` (${trend > 0 ? '+' : ''}${trend} во однос на просекот)` : ''}.`;
  const top = ranked[0]?.[0];
  const goal = top ? `Следно возење: без „${eventLabel(top).toLowerCase()}“.` : 'Следно возење: задржи оценка над 90.';
  return { headline, praise: praise.slice(0, 3), tips: tips.slice(0, 4), goal, source: 'rules' };
}

function describe(e) {
  if (!e) return '';
  if (e.type === 'speeding' && e.speedKmh) return ` Возеше ${e.speedKmh} km/h каде што ограничувањето е ${e.limitKmh} km/h.`;
  if (e.type === 'tailgating' && e.value) return ` Растојанието падна на ${e.value} s.`;
  if ((e.type === 'harsh_brake' || e.type === 'harsh_accel') && e.value) return ` Најсилно: ${e.value} g при ${e.speedKmh ?? '?'} km/h.`;
  return '';
}
