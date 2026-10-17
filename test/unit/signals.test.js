import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GreenWave, greenWaveAdvice, greenWindows, signalStateAt, signalsAhead } from '../../shared/signals.js';
import { bearing } from '../../shared/math.js';

const T0 = 1_760_000_000_000;
// 60 s cycle: green 0–25 s, red 25–60 s, phase 0 at T0.
const sig = (over = {}) => ({ id: 's1', name: 'Семафор 1', lat: 42.0, lon: 21.5, heading: 90, cycle: { period: 60, green: [0, 25], t0: T0 }, ...over });

test('signal state and remaining time within a fixed-time cycle', () => {
  assert.equal(signalStateAt(sig(), T0).state, 'green');
  assert.equal(signalStateAt(sig(), T0 + 10_000).secondsLeft, 15); // green, 15 s left
  const red = signalStateAt(sig(), T0 + 30_000);
  assert.equal(red.state, 'red');
  assert.equal(red.secondsLeft, 30); // next green at 60 s
  // wrap-around green window 55–65 (i.e. 55–60 and 0–5)
  const w = sig({ cycle: { period: 60, green: [55, 5], t0: T0 } });
  assert.equal(signalStateAt(w, T0 + 2_000).state, 'green');
  assert.equal(signalStateAt(w, T0 + 57_000).state, 'green');
  assert.equal(signalStateAt(w, T0 + 30_000).state, 'red');
});

test('green windows over a horizon', () => {
  const windows = greenWindows(sig(), T0 + 30_000, 130); // start in red at phase 30
  // next greens begin at +30 s, +90 s
  assert.ok(Math.abs(windows[0][0] - 30) < 0.1, JSON.stringify(windows));
  assert.ok(Math.abs(windows[1][0] - 90) < 0.1);
});

test('advice: keep speed when already arriving on green', () => {
  // 200 m ahead at 50 km/h -> ETA 14.4 s, still inside the 0–25 s green
  const a = greenWaveAdvice({ signal: sig(), distanceM: 200, speedKmh: 50, nowMs: T0, limitKmh: 60 });
  assert.equal(a.arriveState, 'green');
  assert.ok(['go', 'keep'].includes(a.action), a.action);
  assert.ok(Math.abs(a.targetKmh - 50) <= 5);
});

test('advice: slow down to meet the next green instead of braking at red', () => {
  // 300 m ahead, light just turned red (phase 25), at 55 km/h you'd arrive mid-red.
  const a = greenWaveAdvice({ signal: sig(), distanceM: 300, speedKmh: 55, nowMs: T0 + 25_000, limitKmh: 60 });
  assert.equal(a.action, 'slow');
  assert.ok(a.targetKmh < 55 && a.targetKmh >= 20, `target ${a.targetKmh}`);
  assert.equal(a.arriveState, 'green');
});

test('advice: ease off when no green is reachable within the limit', () => {
  // Far signal, long red ahead, limit too low to make the green: advise easing.
  const far = sig({ cycle: { period: 120, green: [0, 10], t0: T0 } });
  const a = greenWaveAdvice({ signal: far, distanceM: 250, speedKmh: 50, nowMs: T0 + 15_000, limitKmh: 50 });
  assert.equal(a.action, 'ease');
  assert.ok(a.targetKmh >= 20);
});

test('signalsAhead filters by distance and approach direction', () => {
  const north = { id: 'n', name: 'N', lat: 42.01, lon: 21.5, heading: 0, cycle: { period: 60, green: [0, 30], t0: T0 } };
  const east = { id: 'e', name: 'E', lat: 42.0, lon: 21.52, heading: 90, cycle: { period: 60, green: [0, 30], t0: T0 } };
  const behind = { id: 'b', name: 'B', lat: 42.0, lon: 21.48, heading: 90, cycle: { period: 60, green: [0, 30], t0: T0 } };
  const pos = { lat: 42.0, lon: 21.5, heading: 90 }; // heading east
  const ahead = signalsAhead([north, east, behind], pos, { maxDistanceM: 4000 });
  assert.deepEqual(ahead.map((a) => a.signal.id), ['e']); // only the one ahead & same direction
});

test('GreenWave tracks the corridor and speaks a changed advice once', () => {
  const spoken = [];
  const gw = new GreenWave({ signals: [sig()], onAdvice: (a) => spoken.push(a), options: { maxDistanceM: 2000 } });
  // approach from the west (heading east, ~90°) at 55 km/h, 250 m before the light during red
  const west = { lat: 42.0, lon: 21.5 - 250 / (111320 * Math.cos((42 * Math.PI) / 180)), heading: bearing(42.0, 21.4, 42.0, 21.6) };
  const advice = gw.update({ t: T0 + 25_000, ...west }, 55, 60);
  assert.ok(advice, 'advice produced');
  assert.equal(advice.countAhead, 1);
  assert.equal(spoken.length, 1, 'spoke once');
  // same situation again shortly after -> no repeat
  gw.update({ t: T0 + 27_000, ...west }, 55, 60);
  assert.equal(spoken.length, 1);
});
