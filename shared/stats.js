// Aggregates over a driver's trips for the dashboard (progress over time).
import { CATEGORIES, eventLabel } from './events.js';

/** trips: summaries as returned by the server list endpoint (any order). */
export function driverStats(trips) {
  const sorted = [...trips].sort((a, b) => a.startedAt - b.startedAt);
  const scores = sorted.map((t) => t.score).filter((s) => s != null);
  const km = sorted.reduce((s, t) => s + (t.distanceKm ?? 0), 0);
  const hours = sorted.reduce((s, t) => s + (t.durationS ?? 0), 0) / 3600;
  const recent = scores.slice(-5);
  const before = scores.slice(-10, -5);

  const events = {};
  const maneuvers = { total: 0, blinkerYes: 0, blinkerJudged: 0, mirrorFull: 0, mirrorJudged: 0 };
  const categorySums = {};
  for (const t of sorted) {
    for (const [type, n] of Object.entries(t.stats?.events ?? {})) events[type] = (events[type] ?? 0) + n;
    const m = t.stats?.maneuvers;
    if (m) {
      maneuvers.total += m.total ?? 0;
      if (m.blinkerRate != null) {
        const judged = (m.laneChanges ?? 0) + (m.turns ?? 0);
        maneuvers.blinkerJudged += judged;
        maneuvers.blinkerYes += m.blinkerRate * judged;
      }
      if (m.mirrorRate != null) {
        maneuvers.mirrorJudged += m.total ?? 0;
        maneuvers.mirrorFull += m.mirrorRate * (m.total ?? 0);
      }
    }
    for (const [key, c] of Object.entries(t.categories ?? {})) {
      if (!c.measured) continue;
      const s = (categorySums[key] ??= { sum: 0, n: 0 });
      s.sum += c.score;
      s.n++;
    }
  }

  return {
    trips: sorted.length,
    km: Math.round(km * 10) / 10,
    hours: Math.round(hours * 10) / 10,
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    recentAvg: recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null,
    trend: recent.length && before.length ? Math.round(avg(recent) - avg(before)) : null,
    series: sorted.slice(-30).map((t) => ({ id: t.id, t: t.startedAt, score: t.score, km: t.distanceKm })),
    events: Object.entries(events)
      .map(([type, count]) => ({ type, label: eventLabel(type), count, per100km: km > 0 ? Math.round((count / km) * 1000) / 10 : null }))
      .sort((a, b) => b.count - a.count),
    categories: Object.fromEntries(
      Object.keys(CATEGORIES).map((key) => [key, categorySums[key] ? Math.round(categorySums[key].sum / categorySums[key].n) : null]),
    ),
    maneuvers: {
      total: maneuvers.total,
      blinkerRate: maneuvers.blinkerJudged ? Math.round((maneuvers.blinkerYes / maneuvers.blinkerJudged) * 100) / 100 : null,
      mirrorRate: maneuvers.mirrorJudged ? Math.round((maneuvers.mirrorFull / maneuvers.mirrorJudged) * 100) / 100 : null,
    },
  };
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
