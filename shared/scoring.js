// Trip score 0-100, overall and per category. Penalties are scaled to the
// distance driven (per 10 km, but a short trip counts as at least 3 km), so a
// long drive with one harsh brake scores better than a short one with two.
// Categories the phone could not measure (e.g. no road camera) are marked
// so the UI shows "—" instead of a perfect score.
import { CATEGORIES, EVENT_TYPES } from './events.js';

/** Which categories the trip could actually measure, from the sensors that were on. */
export function measuredCategories(capabilities = {}) {
  return {
    smoothness: capabilities.motion !== false,
    speed: capabilities.gps !== false,
    distance: !!capabilities.roadCam,
    maneuvers: capabilities.motion !== false || !!capabilities.roadCam,
    attention: true, // phone handling is always watched; the driver camera adds more
  };
}

export function eventPenalty(e) {
  const base = EVENT_TYPES[e.type]?.penalty ?? 0;
  if (e.type === 'speeding' && Number.isFinite(e.value)) return base * (1 + e.value / 15);
  if (e.type === 'tailgating' && Number.isFinite(e.value)) return base * (e.value < 1 ? 1.5 : 1);
  return base;
}

export function scoreTrip({ events = [], distanceKm = 0, capabilities = {} }) {
  const factor = 10 / Math.max(distanceKm, 3);
  const measured = measuredCategories(capabilities);
  const categories = {};
  for (const key of Object.keys(CATEGORIES)) categories[key] = { score: 100, events: 0, penalty: 0, measured: measured[key] };
  let total = 0;
  for (const e of events) {
    const cat = EVENT_TYPES[e.type]?.category;
    if (!cat) continue;
    const p = eventPenalty(e);
    categories[cat].penalty += p;
    total += p;
    if (p > 0) categories[cat].events++;
  }
  for (const c of Object.values(categories)) {
    c.score = clampScore(100 - c.penalty * factor * 3);
    delete c.penalty;
  }
  // Every mistake counts against the overall score; clean categories do not dilute it.
  return { overall: clampScore(100 - total * factor * 1.2), categories };
}

const clampScore = (x) => Math.round(Math.max(0, Math.min(100, x)));

export function scoreLabel(score) {
  if (score == null) return '—';
  if (score >= 90) return 'Одлично';
  if (score >= 75) return 'Добро';
  if (score >= 60) return 'Може подобро';
  return 'Потребна е работа';
}
