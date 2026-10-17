import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MotionAnalyzer } from '../../shared/motion/analyzer.js';
import { SpeedMonitor } from '../../shared/motion/speed.js';
import { angleBetween } from '../../shared/math.js';
import { T0, deviceForward, feed, hold, laneChangeYaw, mountMatrix, profile, ramp, simulateDrive } from '../helpers/drive-sim.js';

function run(simOptions, analyzerOptions = {}) {
  const events = [];
  const maneuvers = [];
  const statuses = [];
  const analyzer = new MotionAnalyzer({
    onEvent: (e) => events.push(e),
    onManeuver: (m) => maneuvers.push(m),
    onStatus: (s) => statuses.push(s),
    options: analyzerOptions,
  });
  const sim = simulateDrive(simOptions);
  feed(analyzer, sim);
  return { analyzer, events, maneuvers, statuses, sim };
}

// Speeds up, cruises, slows down a few times: enough for forward-axis learning.
const warmup = [
  [3, hold(0)],
  [8, ramp(0, 14)],
  [4, hold(14)],
  [5, ramp(14, 7)],
  [5, ramp(7, 16)],
  [4, hold(16)],
];

test('learns the forward axis from GPS speed changes', () => {
  const mount = mountMatrix({ tiltDeg: 25, yawDeg: 20 });
  const { analyzer } = run({ speed: profile(warmup), mount });
  assert.equal(analyzer.calibration.forward, 'learned');
  const err = angleBetween(analyzer.cal.forwardAxis(), deviceForward(mount));
  assert.ok(err < 8, `forward axis off by ${err.toFixed(1)}°`);
});

test('harsh braking is detected, normal braking is not', () => {
  const speed = profile([...warmup, [2, hold(16)], [2.2, ramp(16, 5)], [3, hold(5)], [6, ramp(5, 17)], [5, ramp(17, 7)], [3, hold(7)]]);
  const { events } = run({ speed });
  const brakes = events.filter((e) => e.type === 'harsh_brake');
  assert.equal(brakes.length, 1, JSON.stringify(events.map((e) => e.type)));
  assert.ok(brakes[0].value > 0.4 && brakes[0].value < 0.6, `peak ${brakes[0].value} g`);
  assert.ok(brakes[0].speedKmh > 45);
  assert.ok(!events.some((e) => e.type === 'harsh_accel'));
});

test('harsh acceleration and cornering', () => {
  const speed = profile([...warmup, [3, ramp(16, 5)], [3, ramp(5, 16)], [9, hold(16)]]);
  const yaw = profile([[38, hold(0)], [3, hold(0.32)], [5, hold(0)]]); // 16 m/s * 0.32 rad/s = 5.1 m/s²
  const { events } = run({ speed, yawRate: yaw });
  assert.ok(events.some((e) => e.type === 'harsh_accel'), JSON.stringify(events.map((e) => e.type)));
  const corner = events.find((e) => e.type === 'harsh_corner');
  assert.ok(corner, 'harsh corner');
  assert.equal(corner.dir, 'left');
});

test('detects a right turn at an intersection', () => {
  const speed = profile([...warmup, [4, ramp(16, 8)], [8, hold(8)], [4, ramp(8, 12)]]);
  const yaw = profile([[33.5, hold(0)], [4.5, hold(-0.35)], [6, hold(0)]]); // right turn ~90°
  const { maneuvers } = run({ speed, yawRate: yaw });
  const turns = maneuvers.filter((m) => m.type === 'turn');
  assert.equal(turns.length, 1, JSON.stringify(maneuvers));
  assert.equal(turns[0].dir, 'right');
  assert.ok(Math.abs(turns[0].angle - 90) < 10, `angle ${turns[0].angle}`);
});

for (const dir of ['left', 'right']) {
  test(`detects a lane change to the ${dir} from the gyroscope`, () => {
    const v = 20;
    const sign = dir === 'left' ? 1 : -1;
    const lane = laneChangeYaw(v, 3.5 * sign, 4);
    const speed = profile([...warmup, [3, ramp(16, v)], [12, hold(v)]]);
    const yaw = profile([[34, hold(0)], [4, (t) => lane(t)], [7, hold(0)]]);
    const { maneuvers } = run({ speed, yawRate: yaw });
    const changes = maneuvers.filter((m) => m.type === 'lane_change');
    assert.equal(changes.length, 1, JSON.stringify(maneuvers));
    assert.equal(changes[0].dir, dir);
    assert.ok(Math.abs(changes[0].lateral - 3.5) < 1.2, `lateral ${changes[0].lateral}`);
  });
}

test('steady curve is not a lane change', () => {
  const speed = profile([...warmup, [3, ramp(16, 20)], [14, hold(20)]]);
  const yaw = profile([[33, hold(0)], [12, hold(0.03)], [6, hold(0)]]);
  const { maneuvers } = run({ speed, yawRate: yaw });
  assert.equal(maneuvers.filter((m) => m.type === 'lane_change').length, 0, JSON.stringify(maneuvers));
});

test('detects reversing out of a parking spot', () => {
  const speed = profile([
    ...warmup,
    [5, ramp(16, 0)],
    [4, hold(0)],
    [2, ramp(0, -1.5)],
    [3, hold(-1.5)],
    [2, ramp(-1.5, 0)],
    [3, hold(0)],
    [4, ramp(0, 6)],
  ]);
  const { maneuvers, statuses } = run({ speed });
  const rev = maneuvers.filter((m) => m.type === 'reverse');
  assert.equal(rev.length, 1, JSON.stringify(maneuvers));
  const startS = (rev[0].tStart - T0) / 1000;
  assert.ok(startS > 37.5 && startS < 39.5, `reverse started at ${startS}s`);
  assert.ok(rev[0].distance > 3 && rev[0].distance < 11, `distance ${rev[0].distance}`);
  assert.ok(statuses.some((s) => s.type === 'reverse_start'));
});

test('driving off forward is not reversing', () => {
  const speed = profile([...warmup, [5, ramp(16, 0)], [4, hold(0)], [5, ramp(0, 8)], [3, hold(8)]]);
  const { maneuvers } = run({ speed });
  assert.equal(maneuvers.filter((m) => m.type === 'reverse').length, 0);
});

test('handles inverted accelerometer signs and gyro in deg/s', () => {
  const speed = profile([...warmup, [2, hold(16)], [2.2, ramp(16, 5)], [3, hold(5)], [5, ramp(5, 15)], [12, hold(15)]]);
  const yaw = profile([[37.2, hold(0)], [4, hold(0.3)], [4, hold(0)], [4, hold(-0.3)], [8, hold(0)]]);
  const { events, analyzer, maneuvers } = run({ speed, yawRate: yaw, flipAccel: true, gyroInDegrees: true });
  assert.ok(events.some((e) => e.type === 'harsh_brake'), JSON.stringify(events.map((e) => e.type)));
  assert.ok(!events.some((e) => e.type === 'harsh_accel'));
  assert.ok(Math.abs(analyzer.calibration.yawGain) < 0.05, `yaw gain ${analyzer.calibration.yawGain}`);
  assert.ok(maneuvers.some((m) => m.type === 'turn'), JSON.stringify(maneuvers));
});

test('notices when the phone moves in its holder while driving', () => {
  const before = mountMatrix({ tiltDeg: 20 });
  const after = mountMatrix({ tiltDeg: 55 });
  const speed = profile([...warmup, [12, hold(16)]]);
  const { statuses, events } = run({ speed, mountAt: (t) => (t < 31 ? before : after) });
  assert.ok(statuses.some((s) => s.type === 'mount_moved'));
  assert.ok(events.some((e) => e.type === 'phone_use'));
});

test('works without the OS-provided linear acceleration', () => {
  const speed = profile([...warmup, [2, hold(16)], [2.2, ramp(16, 5)], [5, hold(5)]]);
  const { events } = run({ speed, withLinear: false });
  assert.ok(events.some((e) => e.type === 'harsh_brake'), JSON.stringify(events.map((e) => e.type)));
});

test('speed monitor reports an episode over the limit', () => {
  const events = [];
  const alerts = [];
  const mon = new SpeedMonitor({ onEvent: (e) => events.push(e), onAlert: (a) => alerts.push(a) });
  for (let s = 0; s < 20; s++) mon.update(T0 + s * 1000, (s < 4 ? 50 : s < 12 ? 72 : 48) / 3.6, 50, { lat: 42, lon: 21.4 });
  assert.equal(events.length, 1);
  assert.equal(events[0].value, 22);
  assert.equal(events[0].limitKmh, 50);
  assert.equal(alerts.length, 1);
  mon.update(T0 + 30000, 58 / 3.6, 50); // within tolerance
  mon.flush();
  assert.equal(events.length, 1);
});
