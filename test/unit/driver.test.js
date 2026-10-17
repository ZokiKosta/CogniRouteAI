import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriverMonitor, GazeCalibrator, classifyGaze, extractFaceFeatures } from '../../shared/gaze.js';
import { ManeuverJudge } from '../../shared/maneuvers.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rand = rng(42);
const jitter = (v, amount) => v + (rand() - 0.5) * 2 * amount;

// Typical head poses seen by a phone on the windshield, right of the driver.
const POSES = {
  road: { yaw: 12, pitch: -4 },
  left_mirror: { yaw: 52, pitch: -8 },
  rear_mirror: { yaw: -14, pitch: 12 },
  right_mirror: { yaw: -48, pitch: -6 },
  down: { yaw: 10, pitch: -34 },
};
const face = (zone, extra = {}) => ({
  yaw: jitter(POSES[zone].yaw, 3),
  pitch: jitter(POSES[zone].pitch, 3),
  eyeH: jitter(0, 0.05),
  eyeV: jitter(0, 0.05),
  blink: 0.1,
  jawOpen: 0.05,
  ...extra,
});

function calibrated() {
  const cal = new GazeCalibrator();
  for (const zone of Object.keys(POSES)) for (let i = 0; i < 20; i++) cal.add(zone, face(zone));
  return cal.result();
}

test('head pose from the facial transformation matrix', () => {
  const rotY = (deg) => {
    const a = (deg * Math.PI) / 180;
    // column-major 4x4 rotation about Y
    return [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, -50, 1];
  };
  const result = (m) => ({
    facialTransformationMatrixes: [{ rows: 4, columns: 4, data: m }],
    faceBlendshapes: [{ categories: [{ categoryName: 'eyeBlinkLeft', score: 0.9 }, { categoryName: 'eyeBlinkRight', score: 0.7 }] }],
  });
  const f = extractFaceFeatures(result(rotY(30)));
  assert.ok(Math.abs(f.yaw - 30) < 0.01, `yaw ${f.yaw}`);
  assert.ok(Math.abs(f.pitch) < 0.01);
  assert.ok(Math.abs(f.blink - 0.8) < 1e-9);
  assert.equal(extractFaceFeatures({ faceBlendshapes: [], facialTransformationMatrixes: [] }), null);
});

test('calibrated gaze zones are recognised, including shoulder checks', () => {
  const cal = calibrated();
  assert.ok(cal, 'calibration complete');
  let correct = 0;
  let total = 0;
  for (const zone of Object.keys(POSES)) {
    for (let i = 0; i < 50; i++) {
      total++;
      if (classifyGaze(face(zone), cal).zone === zone) correct++;
    }
  }
  assert.ok(correct / total > 0.95, `accuracy ${correct / total}`);
  assert.equal(classifyGaze({ ...face('left_mirror'), yaw: 85 }, cal).zone, 'left_shoulder');
  assert.equal(classifyGaze({ ...face('right_mirror'), yaw: -80 }, cal).zone, 'right_shoulder');
});

test('long look down while driving is a distraction, a mirror glance is not', () => {
  const events = [];
  const alerts = [];
  const mon = new DriverMonitor({ onEvent: (e) => events.push(e), onAlert: (a) => alerts.push(a), calibration: calibrated() });
  let t = 0;
  for (; t < 3000; t += 100) mon.update(t, face('road'), 15);
  for (; t < 3800; t += 100) mon.update(t, face('left_mirror'), 15);
  for (; t < 6000; t += 100) mon.update(t, face('road'), 15);
  assert.equal(events.length, 0);
  for (; t < 9000; t += 100) mon.update(t, face('down'), 15);
  assert.equal(events.filter((e) => e.type === 'distraction').length, 1);
  assert.ok(alerts.some((a) => a.kind === 'distraction'));
});

test('eyes closed for over a second at speed raises a drowsiness alert', () => {
  const events = [];
  const alerts = [];
  const mon = new DriverMonitor({ onEvent: (e) => events.push(e), onAlert: (a) => alerts.push(a), calibration: calibrated() });
  for (let t = 0; t < 2000; t += 100) mon.update(t, face('road'), 20);
  for (let t = 2000; t < 3500; t += 100) mon.update(t, face('road', { blink: 0.9 }), 20);
  assert.ok(alerts.some((a) => a.kind === 'drowsy'));
  assert.equal(events[0]?.type, 'drowsiness');
});

test('without calibration the road pose is learned and looking down is noticed', () => {
  const events = [];
  const mon = new DriverMonitor({ onEvent: (e) => events.push(e) });
  let t = 0;
  for (; t < 6000; t += 100) mon.update(t, face('road'), 15);
  assert.equal(mon.state.zone, 'road');
  for (; t < 9000; t += 100) mon.update(t, face('down'), 15);
  assert.equal(events[0]?.type, 'distraction');
});

function judge(caps = { audio: true, driverCam: true, calibratedGaze: true }) {
  const maneuvers = [];
  const events = [];
  const j = new ManeuverJudge({ onManeuver: (m) => maneuvers.push(m), onEvent: (e) => events.push(e) });
  j.setCapabilities(caps);
  return { j, maneuvers, events };
}

function gazeTimeline(j, from, to, zoneAt) {
  for (let t = from; t <= to; t += 100) j.gaze(t, zoneAt(t));
}

test('a textbook lane change: mirror, signal, shoulder, move', () => {
  const { j, maneuvers, events } = judge();
  gazeTimeline(j, 0, 20000, (t) => (t >= 9000 && t < 9600 ? 'rear_mirror' : t >= 10000 && t < 10600 ? 'left_mirror' : 'road'));
  j.blinker({ on: true, t: 10800 });
  j.addManeuver({ type: 'lane_change', dir: 'left', tStart: 13000, tEnd: 16500, source: 'imu' });
  j.blinker({ on: false, t: 17000 });
  j.tick(20000);
  assert.equal(maneuvers.length, 1);
  const m = maneuvers[0];
  assert.equal(m.blinker, true);
  assert.equal(m.mirrors, 'full');
  assert.equal(m.order, 'mirror_first');
  assert.ok(m.blinkerLeadS > 2);
  assert.equal(events.length, 0, JSON.stringify(events));
});

test('lane change without signal or mirror check over a solid line', () => {
  const { j, maneuvers, events } = judge();
  gazeTimeline(j, 0, 20000, () => 'road');
  j.addManeuver({ type: 'lane_change', dir: 'right', tStart: 12000, tEnd: 15500, source: 'imu' });
  j.addManeuver({ type: 'lane_change', dir: 'right', tStart: 13500, tEnd: 14500, source: 'camera', lineType: 'solid' });
  j.tick(20000);
  assert.equal(maneuvers.length, 1, 'camera and gyroscope detections merged');
  assert.deepEqual(maneuvers[0].sources.sort(), ['camera', 'imu']);
  assert.deepEqual(events.map((e) => e.type).sort(), ['lane_change_no_blinker', 'no_mirror_check', 'solid_line_crossing']);
});

test('only the inside mirror before moving right is a partial check', () => {
  const { j, maneuvers, events } = judge();
  gazeTimeline(j, 0, 20000, (t) => (t >= 9000 && t < 9500 ? 'rear_mirror' : 'road'));
  j.blinker({ on: true, t: 9800 });
  j.addManeuver({ type: 'lane_change', dir: 'right', tStart: 12000, tEnd: 15000, source: 'imu' });
  j.tick(20000);
  assert.equal(maneuvers[0].mirrors, 'partial');
  assert.deepEqual(events.map((e) => e.type), ['partial_mirror_check']);
});

test('reversing with and without looking back', () => {
  for (const [looks, expected] of [
    [true, []],
    [false, ['reverse_no_check']],
  ]) {
    const { j, events, maneuvers } = judge();
    gazeTimeline(j, 0, 20000, (t) => (looks && t >= 8000 && t < 9000 ? 'rear_mirror' : looks && t >= 11000 && t < 12500 ? 'right_shoulder' : 'road'));
    j.addManeuver({ type: 'reverse', tStart: 10000, tEnd: 16000, source: 'imu' });
    j.tick(20000);
    assert.equal(maneuvers[0].mirrors, looks ? 'full' : 'none');
    assert.deepEqual(events.map((e) => e.type), expected);
  }
});

test('unknown inputs give no penalties', () => {
  const { j, maneuvers, events } = judge({ audio: false, driverCam: false });
  j.addManeuver({ type: 'turn', dir: 'left', tStart: 10000, tEnd: 14000, source: 'imu' });
  j.tick(20000);
  assert.equal(maneuvers[0].blinker, null);
  assert.equal(maneuvers[0].mirrors, null);
  assert.equal(events.length, 0);
});
