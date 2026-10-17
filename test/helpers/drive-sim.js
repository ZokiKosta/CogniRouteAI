// Synthetic drive generator for tests: produces DeviceMotion-like samples and
// GPS fixes for a car following a speed and yaw-rate profile, seen by a phone
// mounted on the windshield at some angle.
const G = 9.80665;
const DEG = Math.PI / 180;

/** Piecewise profile: segments of [durationSeconds, (localT, duration) => value]. */
export function profile(segments) {
  const ends = [];
  let total = 0;
  for (const [d] of segments) ends.push((total += d));
  const fn = (t) => {
    let start = 0;
    for (let i = 0; i < segments.length; i++) {
      if (t <= ends[i] || i === segments.length - 1) return segments[i][1](Math.min(t - start, segments[i][0]), segments[i][0]);
      start = ends[i];
    }
    return 0;
  };
  fn.duration = total;
  return fn;
}

export const hold = (v) => () => v;
export const ramp = (from, to) => (t, d) => from + (to - from) * Math.min(1, t / d);

/** Lane change of `width` meters in `duration` seconds at constant `speed` (left > 0). */
export function laneChangeYaw(speed, width, duration) {
  return (t) => {
    // y(t) = w/2 (1 - cos(pi t / T)); heading = atan(y'/v); yaw = d(heading)/dt
    const h = 1e-3;
    const heading = (s) => Math.atan(((width * Math.PI) / (2 * duration)) * Math.sin((Math.PI * Math.min(Math.max(s, 0), duration)) / duration) / speed);
    return (heading(t + h) - heading(t - h)) / (2 * h);
  };
}

const mul = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
const matmul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];

/**
 * Vehicle frame (x forward, y left, z up) -> device frame. The phone faces the
 * driver, so its rear camera (-Z) looks forward; landscape, tilted and yawed.
 */
export function mountMatrix({ landscape = true, tiltDeg = 20, yawDeg = 5, rollDeg = 0 } = {}) {
  const portrait = [
    [0, -1, 0], // device x = vehicle right
    [0, 0, 1], // device y = vehicle up
    [-1, 0, 0], // device z = toward the driver
  ];
  let m = portrait;
  m = matmul(ry(yawDeg * DEG), m);
  m = matmul(rx(tiltDeg * DEG), m);
  if (landscape) m = matmul(rz(90 * DEG), m);
  if (rollDeg) m = matmul(rz(rollDeg * DEG), m);
  return m;
}

function gauss(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const T0 = 1_760_000_000_000;

export function simulateDrive({
  speed,
  yawRate = () => 0,
  duration = speed.duration,
  rate = 60,
  mount = mountMatrix(),
  mountAt = null, // (t) => matrix, to simulate the phone moving
  noise = 0.05,
  gyroNoise = 0.004,
  vibration = 0.15,
  gpsInterval = 1,
  gpsLag = 0.4,
  flipAccel = false,
  gyroInDegrees = false,
  withLinear = true,
  start = { lat: 41.9981, lon: 21.4254, heading: 90 },
  seed = 7,
} = {}) {
  const rand = rng(seed);
  const motion = [];
  const gps = [];
  const truth = [];
  const dt = 1 / rate;
  let north = 0;
  let east = 0;
  let heading = start.heading; // compass degrees
  let nextGps = 0;
  const history = [];

  for (let i = 0; i * dt <= duration; i++) {
    const t = i * dt;
    const v = speed(t);
    const dv = (speed(t + 0.01) - speed(Math.max(0, t - 0.01))) / (t > 0.01 ? 0.02 : 0.01);
    const w = yawRate(t);
    const aVeh = [dv, v * w, 0];
    const m = mountAt ? mountAt(t) : mount;
    const lin = mul(m, aVeh);
    const up = mul(m, [0, 0, G]);
    const vib = Math.abs(v) > 0.05 ? vibration * Math.sin(2 * Math.PI * 15 * t) : 0;
    const n = () => noise * gauss(rand);
    const linNoisy = lin.map((x, k) => x + n() + (k === 1 ? vib : 0));
    let accG = linNoisy.map((x, k) => x + up[k]);
    let acc = withLinear ? linNoisy : null;
    if (flipAccel) {
      accG = accG.map((x) => -x);
      if (acc) acc = acc.map((x) => -x);
    }
    let gyro = mul(m, [0, 0, w]).map((x) => x + gyroNoise * gauss(rand));
    if (gyroInDegrees) gyro = gyro.map((x) => x / DEG);
    motion.push({ t: T0 + Math.round(t * 1000), acc, accG, gyro });
    truth.push({ t: T0 + Math.round(t * 1000), v, aLong: dv, aLat: v * w, yaw: w });

    heading -= (w / DEG) * dt;
    north += v * Math.cos(heading * DEG) * dt;
    east += v * Math.sin(heading * DEG) * dt;
    history.push({ t, north, east, v, heading });
    if (t >= nextGps + gpsLag) {
      const past = history.find((h) => h.t >= t - gpsLag) ?? history[history.length - 1];
      gps.push({
        t: T0 + Math.round(t * 1000),
        lat: start.lat + past.north / 111320,
        lon: start.lon + past.east / (111320 * Math.cos(start.lat * DEG)),
        speed: Math.max(0, Math.abs(past.v) + 0.08 * gauss(rand)),
        heading: Math.abs(past.v) > 0.5 ? ((past.v >= 0 ? past.heading : past.heading + 180) % 360 + 360) % 360 : null,
        accuracy: 5,
      });
      nextGps += gpsInterval;
    }
  }
  return { motion, gps, truth, mount };
}

/** Feeds a simulation into an analyzer in time order. */
export function feed(analyzer, sim) {
  let g = 0;
  for (const m of sim.motion) {
    while (g < sim.gps.length && sim.gps[g].t <= m.t) analyzer.addGps(sim.gps[g++]);
    analyzer.addMotion(m);
  }
}

/** True forward axis of the car expressed in device coordinates. */
export function deviceForward(mount) {
  return mul(mount, [1, 0, 0]);
}
