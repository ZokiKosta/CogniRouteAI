import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.js';
import { createCoach } from '../../server/coach.js';
import { openDb } from '../../server/db.js';
import { seed } from '../../server/seed.js';

let server;
let base;
let db;
const quiet = { warn: () => {} };

before(async () => {
  db = openDb(':memory:');
  const { coach } = createCoach({ client: null, log: quiet });
  const app = createApp({ db, coach, distDir: '/nonexistent' });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

const json = async (path, options = {}) => {
  const res = await fetch(base + path, { headers: { 'Content-Type': 'application/json' }, ...options });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const trip = (id, extra = {}) => ({
  id,
  driverId: 'd1',
  driverName: 'Тест',
  startedAt: 1_760_000_000_000,
  endedAt: 1_760_000_600_000,
  durationS: 600,
  distanceKm: 6,
  capabilities: { motion: true, gps: true },
  events: [{ id: 'e1', type: 'harsh_brake', t: 1_760_000_100_000, value: 0.5 }],
  maneuvers: [{ type: 'turn', dir: 'left', tStart: 1_760_000_200_000, tEnd: 1_760_000_205_000, blinker: false }],
  route: [[42, 21.4, 30, 0]],
  ...extra,
});

test('stores a trip and recomputes its score', async () => {
  const res = await json('/api/trips', { method: 'POST', body: JSON.stringify(trip('trip-abc123')) });
  assert.equal(res.status, 201);
  assert.equal(res.body.score.overall, 92); // one harsh brake in 6 km
  const list = await json('/api/trips?driverId=d1');
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].stats.events.harsh_brake, 1);
  const full = await json('/api/trips/trip-abc123');
  assert.equal(full.body.events.length, 1);
  assert.equal(full.body.coaching, null);
});

test('rejects malformed trips', async () => {
  for (const bad of [{}, trip('x'), trip('trip-ok-123', { events: 'nope' }), trip('trip-ok-456', { startedAt: 'yesterday' })]) {
    const res = await json('/api/trips', { method: 'POST', body: JSON.stringify(bad) });
    assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 80));
  }
  const broken = await fetch(`${base}/api/trips`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(broken.status, 400);
});

test('coaching is generated once and cached', async () => {
  const first = await json('/api/trips/trip-abc123/coach', { method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(first.body.source, 'rules');
  assert.ok(first.body.tips.length >= 1);
  const again = await json('/api/trips/trip-abc123/coach', { method: 'POST' });
  assert.equal(again.body.createdAt, first.body.createdAt);
  const missing = await json('/api/trips/nope-nope/coach', { method: 'POST' });
  assert.equal(missing.status, 404);
});

test('drivers, stats, delete, CORS and unknown routes', async () => {
  await json('/api/trips', { method: 'POST', body: JSON.stringify(trip('trip-def456', { startedAt: 1_760_100_000_000, events: [] })) });
  const drivers = await json('/api/drivers');
  assert.equal(drivers.body[0].trips, 2);
  const stats = await json('/api/stats?driverId=d1');
  assert.equal(stats.body.trips, 2);
  assert.equal(stats.body.km, 12);
  assert.equal(stats.body.events[0].type, 'harsh_brake');
  const pre = await fetch(`${base}/api/trips`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal((await json('/api/trips/trip-def456', { method: 'DELETE' })).status, 204);
  assert.equal((await json('/api/trips/trip-def456')).status, 404);
  assert.equal((await json('/api/nothing')).status, 404);
});

test('Claude coach: parsed answer, refusal and errors fall back to rules', async () => {
  const answer = { headline: 'Добро', praise: ['мазно'], tips: [{ title: 'Растојание', text: 'Држи 2 секунди.' }], goal: 'Без нагло кочење' };
  const fake = (impl) => ({ beta: { messages: { parse: impl } } });
  let seen;
  const ok = createCoach({
    client: fake(async (params) => {
      seen = params;
      return { stop_reason: 'end_turn', parsed_output: answer, model: params.model };
    }),
    log: quiet,
  });
  const t = trip('trip-coach1');
  const r1 = await ok.coach(t, []);
  assert.equal(r1.source, 'claude');
  assert.equal(r1.headline, 'Добро');
  assert.equal(seen.model, 'claude-opus-5-5');
  assert.equal(seen.fallbacks, 'default');
  assert.equal(seen.output_config.format.type, 'json_schema');
  assert.match(seen.messages[0].content, /Резиме од возењето/);

  const refused = createCoach({ client: fake(async () => ({ stop_reason: 'refusal', stop_details: { category: null }, parsed_output: null })), log: quiet });
  assert.equal((await refused.coach(t, [])).source, 'rules');
  const failing = createCoach({ client: fake(async () => { throw new Error('network down'); }), log: quiet });
  const r3 = await failing.coach(t, []);
  assert.equal(r3.source, 'rules');
  assert.ok(r3.note);
});

test('demo seed produces improving trips', () => {
  const mem = openDb(':memory:');
  const n = seed(mem, 1_760_000_000_000);
  assert.equal(n, 20);
  const ana = mem.listTrips({ driverId: 'demo-ana', limit: 100 }).reverse();
  const firstHalf = ana.slice(0, 6).reduce((s, t) => s + t.score, 0) / 6;
  const secondHalf = ana.slice(6).reduce((s, t) => s + t.score, 0) / 6;
  assert.ok(secondHalf > firstHalf, `scores ${firstHalf} -> ${secondHalf}`);
  const full = mem.getTrip(ana[0].id);
  assert.ok(full.route.length > 20 && full.events.every((e) => Number.isFinite(e.lat)));
  mem.close();
});
