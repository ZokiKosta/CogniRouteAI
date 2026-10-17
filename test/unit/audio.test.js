import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlinkerDetector } from '../../shared/audio/blinker.js';
import { SirenDetector } from '../../shared/audio/siren.js';
import { addClicks, blinkerTimes, feedAudio, mix, music, rng, roadNoise, speech, tone, twoTone, wail, yelp } from '../helpers/audio-sim.js';

const SR = 48000;
const seconds = (s) => Math.round(s * SR);

function blinkerRun(signal, options = {}) {
  const changes = [];
  const det = new BlinkerDetector(SR, { onChange: (c) => changes.push(c), ...options });
  feedAudio(det, signal, SR);
  return { det, changes };
}

function cabinWithBlinker({ from = 1, to = 6, period = 0.667, tickTock = true, kind = 'relay', duration = 9, seed = 3 } = {}) {
  const sig = roadNoise(seconds(duration), { seed });
  const { ticks, tocks } = blinkerTimes(from, to, period, { tickTock });
  addClicks(sig, SR, ticks, kind);
  if (tickTock) addClicks(sig, SR, tocks, kind === 'relay' ? 'tock' : kind);
  return sig;
}

test('turn signal (tick-tock, 90/min) is detected and released', () => {
  const { changes } = blinkerRun(cabinWithBlinker());
  const on = changes.find((c) => c.on);
  const off = changes.find((c) => !c.on);
  assert.ok(on, JSON.stringify(changes));
  assert.ok(on.t >= 990 && on.t < 1400, `backdated start ${on.t}`);
  assert.ok(off && off.t > 5500 && off.t < 6600, JSON.stringify(changes));
});

test('turn signal with a single click per flash (75/min)', () => {
  const { changes } = blinkerRun(cabinWithBlinker({ period: 0.8, tickTock: false, to: 7 }));
  assert.ok(changes.some((c) => c.on), JSON.stringify(changes));
});

test('no turn signal in road noise, speech or random knocks', () => {
  const n = seconds(8);
  const knocks = roadNoise(n, { seed: 4 });
  const rand = rng(21);
  const times = [];
  for (let t = 0.5; t < 7.5; t += 0.15 + rand() * 0.5) times.push(t);
  addClicks(knocks, SR, times, 'relay');
  for (const [name, sig] of [
    ['noise', roadNoise(n)],
    ['speech', mix(roadNoise(n), speech(n, SR))],
    ['knocks', knocks],
  ]) {
    const { changes } = blinkerRun(sig);
    assert.equal(changes.length, 0, `${name}: ${JSON.stringify(changes)}`);
  }
});

test('calibrated click template rejects other periodic sounds', () => {
  const calib = new BlinkerDetector(SR);
  calib.startCalibration();
  feedAudio(calib, cabinWithBlinker({ from: 0.5, to: 6, duration: 6.5 }), SR);
  const template = calib.finishCalibration();
  assert.ok(template, 'template recorded');
  assert.ok([333, 667].some((p) => Math.abs(template.periodMs - p) < 40), `period ${template.periodMs}`);

  const same = blinkerRun(cabinWithBlinker({ seed: 8 }), { template });
  assert.ok(same.changes.some((c) => c.on), 'own blinker still detected');

  const hihats = cabinWithBlinker({ kind: 'hihat', tickTock: false, period: 0.667 });
  assert.ok(blinkerRun(hihats).changes.some((c) => c.on), 'without a template a steady beat looks like a blinker');
  assert.ok(!blinkerRun(hihats, { template }).changes.some((c) => c.on), 'template rejects the beat');
});

function sirenRun(signal) {
  const found = [];
  const ended = [];
  const det = new SirenDetector(SR, { onSiren: (s) => found.push(s), onEnd: (e) => ended.push(e) });
  feedAudio(det, signal, SR);
  return { found, ended };
}

const withNoise = (sig, seed = 3) => mix(roadNoise(sig.length, { seed, rumble: 0.08 }), sig);

for (const [name, freq, type] of [
  ['wail', wail(), 'wail'],
  ['yelp', yelp(), 'yelp'],
  ['hi-lo', twoTone(960, 770, 0.5), 'two_tone'],
  ['Martinshorn', twoTone(440, 585, 0.6), 'two_tone'],
]) {
  test(`siren: ${name}`, () => {
    const { found } = sirenRun(withNoise(tone(seconds(6), SR, freq, { amp: 0.06 })));
    assert.ok(found.length >= 1, `${name} not detected`);
    assert.equal(found[0].type, type);
    assert.ok(found[0].t < 4500, `detected late: ${found[0].t}`);
  });
}

test('approaching siren gets louder', () => {
  const sig = withNoise(tone(seconds(7), SR, wail(), { amp: 0.03, gain: (t) => 0.4 + t / 3 }));
  const { found } = sirenRun(sig);
  assert.ok(found.length);
  assert.equal(found[0].approaching, true);
});

test('no siren in noise, engine hum, a beep, music or speech', () => {
  const n = seconds(7);
  const cases = {
    noise: roadNoise(n),
    engine: withNoise(tone(n, SR, () => 70, { amp: 0.2, harmonics: [1, 0.6, 0.5, 0.4, 0.3, 0.3, 0.25, 0.2, 0.2] })),
    beep: withNoise(tone(n, SR, () => 1000, { amp: 0.06, harmonics: [1] })),
    music: withNoise(music(n, SR)),
    speech: withNoise(speech(n, SR)),
  };
  for (const [name, sig] of Object.entries(cases)) {
    const { found } = sirenRun(sig);
    assert.equal(found.length, 0, `${name}: ${JSON.stringify(found)}`);
  }
});
