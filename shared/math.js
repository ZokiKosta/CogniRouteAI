// Small numeric helpers shared by the detectors (no DOM, runs in Node and browsers).

export const G = 9.80665;
export const DEG = Math.PI / 180;

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);

export function normalize(a) {
  const n = norm(a);
  return n > 1e-9 ? scale(a, 1 / n) : [0, 0, 0];
}

/** Component of `v` perpendicular to the unit vector `axis`. */
export const reject = (v, axis) => sub(v, scale(axis, dot(v, axis)));

/** Angle between two vectors in degrees. */
export function angleBetween(a, b) {
  const c = dot(normalize(a), normalize(b));
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;

export function mean(values) {
  if (!values.length) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function median(values) {
  if (!values.length) return NaN;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) ** 2;
  return Math.sqrt(s / (values.length - 1));
}

/** Signed difference a - b of two compass angles, in (-180, 180]. */
export function angleDiffDeg(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** First-order low-pass filter with a time constant, robust to irregular sampling. */
export class Ema {
  constructor(tau, initial = null) {
    this.tau = tau;
    this.value = initial;
  }

  update(x, dt) {
    if (this.value === null || !Number.isFinite(this.value)) this.value = x;
    else this.value += (x - this.value) * (1 - Math.exp(-dt / this.tau));
    return this.value;
  }
}

/** Vector version of Ema. */
export class Ema3 {
  constructor(tau) {
    this.tau = tau;
    this.value = null;
  }

  update(v, dt) {
    if (!this.value) this.value = [...v];
    else {
      const k = 1 - Math.exp(-dt / this.tau);
      for (let i = 0; i < 3; i++) this.value[i] += (v[i] - this.value[i]) * k;
    }
    return this.value;
  }
}

/** Time-stamped samples kept for a limited time window. */
export class TimeBuffer {
  constructor(maxAgeMs) {
    this.maxAgeMs = maxAgeMs;
    this.items = [];
  }

  push(t, value) {
    this.items.push({ t, value });
    const cutoff = t - this.maxAgeMs;
    let drop = 0;
    while (drop < this.items.length && this.items[drop].t < cutoff) drop++;
    if (drop) this.items.splice(0, drop);
  }

  between(t0, t1) {
    return this.items.filter((it) => it.t >= t0 && it.t <= t1);
  }

  values() {
    return this.items.map((it) => it.value);
  }

  last() {
    return this.items[this.items.length - 1];
  }

  get length() {
    return this.items.length;
  }

  clear() {
    this.items.length = 0;
  }
}

/** Great-circle distance in meters. */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial compass bearing (degrees clockwise from north) from point 1 to point 2. */
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}
