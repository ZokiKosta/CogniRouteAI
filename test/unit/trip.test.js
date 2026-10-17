import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TripRecorder } from '../../shared/trip.js';
import { scoreTrip } from '../../shared/scoring.js';
import { ruleBasedCoaching, summarizeTrip, COACH_SCHEMA } from '../../shared/coach.js';
import { makeEvent } from '../../shared/events.js';

const T0 = 1_760_000_000_000;

function sampleTrip() {
  const rec = new TripRecorder({ driverId: 'd1', driverName: 'Ана', startedAt: T0, capabilities: { motion: true, gps: true, roadCam: true, driverCam: true, audio: true } });
  // 6 km east along a parallel at ~54 km/h, one fix per second
  for (let s = 0; s <= 400; s++) rec.addFix({ t: T0 + s * 1000, lat: 42.0, lon: 21.4 + (s * 15) / (111320 * Math.cos((42 * Math.PI) / 180)), speed: 15, accuracy: 5 });
  rec.addFix({ t: T0 + 401000, lat: 43.0, lon: 21.4, speed: 15, accuracy: 5 }); // GPS jump, ignored
  rec.addEvent(makeEvent('harsh_brake', T0 + 60000, { value: 0.45, unit: 'g', speedKmh: 52 }));
  rec.addEvent(makeEvent('speeding', T0 + 120000, { value: 18, unit: 'km/h', speedKmh: 68, limitKmh: 50 }));
  rec.addEvent(makeEvent('pedestrian_alert', T0 + 150000, {}));
  rec.addManeuver({ type: 'lane_change', dir: 'left', tStart: T0 + 200000, tEnd: T0 + 204000, blinker: true, mirrors: 'full', order: 'mirror_first' });
  rec.addManeuver({ type: 'turn', dir: 'right', tStart: T0 + 300000, tEnd: T0 + 305000, blinker: false, mirrors: 'partial' });
  return rec.finish(T0 + 402000);
}

test('trip recorder measures distance, speed and stats', () => {
  const trip = sampleTrip();
  assert.ok(Math.abs(trip.distanceKm - 6) < 0.05, `distance ${trip.distanceKm}`);
  assert.equal(trip.maxSpeedKmh, 54);
  assert.equal(trip.avgSpeedKmh, 54);
  assert.ok(trip.route.length > 100 && trip.route.length < 300, `route points ${trip.route.length}`);
  assert.equal(trip.stats.events.harsh_brake, 1);
  assert.equal(trip.stats.maneuvers.blinkerRate, 0.5);
  assert.ok(trip.events.every((e) => Number.isFinite(e.lat)), 'events get a location');
});

test('scores fall with penalties and ignore unmeasured categories', () => {
  const clean = scoreTrip({ events: [], distanceKm: 10, capabilities: { motion: true, gps: true } });
  assert.equal(clean.overall, 100);
  assert.equal(clean.categories.distance.measured, false);
  const e = (type, extra = {}) => ({ type, t: 0, ...extra });
  const bad = scoreTrip({ events: [e('harsh_brake'), e('harsh_brake'), e('speeding', { value: 30 }), e('phone_use')], distanceKm: 10, capabilities: { motion: true, gps: true } });
  assert.ok(bad.overall < 85, `overall ${bad.overall}`);
  assert.equal(bad.categories.smoothness.events, 2);
  const shortTrip = scoreTrip({ events: [e('harsh_brake')], distanceKm: 1, capabilities: {} });
  const longTrip = scoreTrip({ events: [e('harsh_brake')], distanceKm: 30, capabilities: {} });
  assert.ok(shortTrip.overall < longTrip.overall, 'same mistake costs more on a short trip');
  assert.equal(scoreTrip({ events: [e('pedestrian_alert')], distanceKm: 5 }).overall, 100, 'info events are free');
});

test('summary and rule-based coaching in Macedonian', () => {
  const trip = sampleTrip();
  const summary = summarizeTrip(trip);
  assert.equal(summary.maneuvers.withoutBlinker, 1);
  assert.equal(summary.worstEvents[0].type, 'speeding');
  assert.equal(summary.sensors.driverCamera, true);
  const coaching = ruleBasedCoaching(summary, [{ score: 70 }, { score: 74 }]);
  for (const key of COACH_SCHEMA.required) assert.ok(coaching[key] != null, key);
  assert.ok(coaching.tips.length >= 2);
  assert.match(coaching.tips[0].title, /Пребрзо/);
  assert.match(coaching.headline, /\/100/);
  assert.match(coaching.goal, /Следно возење/);
});
