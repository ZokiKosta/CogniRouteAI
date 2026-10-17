// Green-wave / GLOSA (Green Light Optimal Speed Advisory).
//
// IMPORTANT: this does NOT control or connect to traffic lights. It only READS
// the timing of fixed-time signals – either published by the city, entered by
// the user, or a demo set – and advises the driver on a steady speed so they
// reach the next light on green instead of accelerating up to a red and braking
// hard. Nothing is sent to any signal; it is advice to the driver, like a
// navigation voice.
//
// A signal is modelled as a fixed-time cycle anchored to a reference time:
//   { id, name, lat, lon, heading, cycle: { period, green: [start, end] } }
// where `heading` is the bearing (deg) a car has when approaching it, and the
// green window [start, end) is in seconds within the cycle, measured from
// `cycle.t0` (epoch ms when phase 0 began; defaults to 0). Actuated or
// adaptive signals can't be predicted and should be left out.
import { angleDiffDeg, bearing, clamp, haversine } from './math.js';

/** State of a fixed-time signal at time tMs: { state, secondsLeft, nextGreenIn }. */
export function signalStateAt(signal, tMs) {
  const c = signal.cycle;
  const period = c.period;
  const phase = (((tMs / 1000 - (c.t0 ?? 0) / 1000) % period) + period) % period;
  const [gs, ge] = c.green;
  const inWindow = gs <= ge ? phase >= gs && phase < ge : phase >= gs || phase < ge; // green may wrap past 0
  if (inWindow) {
    const end = gs <= ge ? ge : phase >= gs ? ge + period : ge;
    return { state: 'green', secondsLeft: end - phase, nextGreenIn: 0 };
  }
  // time until the next green start
  let until = gs - phase;
  if (until <= 0) until += period;
  return { state: 'red', secondsLeft: until, nextGreenIn: until };
}

/** Green windows (start/end seconds from now) for the next `horizon` seconds. */
export function greenWindows(signal, nowMs, horizon) {
  const windows = [];
  const c = signal.cycle;
  let t = 0;
  let guard = 0;
  while (t < horizon && guard++ < 100) {
    const s = signalStateAt(signal, nowMs + t * 1000);
    if (s.state === 'green') {
      windows.push([t, Math.min(horizon, t + s.secondsLeft)]);
      t += s.secondsLeft + 0.01;
    } else t += s.secondsLeft + 0.01;
  }
  return windows;
}

const DEFAULTS = {
  minKmh: 20, // never advise crawling below this
  comfortMarginS: 2, // aim this far inside the green window
  reachableMinKmh: 15, // if catching green needs less than this, coast/stop instead
};

/**
 * Advice for one signal ahead.
 *   action: 'go'    – you'll arrive on green at your current speed
 *           'keep'  – hold ~this speed to stay in the green wave
 *           'slow'  – ease off to this speed to meet the next green (no braking)
 *           'speed' – speed up (within the limit) to catch the closing green
 *           'ease'  – green is far; lift off the gas, you'll reach it red anyway
 * targetKmh is the advised speed; arriveState/secondsToChange describe the light.
 */
export function greenWaveAdvice({ signal, distanceM, speedKmh, nowMs, limitKmh, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const now = signalStateAt(signal, nowMs);
  const vmax = Math.max(o.minKmh + 5, limitKmh ?? 60);
  const v = Math.max(1, speedKmh);
  const etaS = distanceM / (v / 3.6);
  const arrive = signalStateAt(signal, nowMs + etaS * 1000);

  const speedFor = (seconds) => (distanceM / seconds) * 3.6; // km/h to cover distanceM in `seconds`
  const windows = greenWindows(signal, nowMs, Math.max(etaS, distanceM / (o.minKmh / 3.6)) + 5);

  // Find a green window reachable within [minKmh, vmax].
  for (const [start, end] of windows) {
    const enterAt = start + o.comfortMarginS;
    const latest = end - 0.5;
    if (latest <= 0) continue;
    const vSlow = speedFor(latest); // slowest speed that still arrives before green ends
    const vFast = speedFor(Math.max(enterAt, 0.1)); // fastest useful speed (arrive at window start+margin)
    const lo = Math.max(o.minKmh, vSlow);
    const hi = Math.min(vmax, vFast);
    if (lo > hi + 0.5) continue; // this window needs an out-of-range speed; try the next
    const target = clamp(v, lo, hi);
    let action = 'keep';
    if (Math.abs(target - v) < 3) action = arrive.state === 'green' ? 'go' : 'keep';
    else if (target < v) action = 'slow';
    else action = 'speed';
    return {
      action,
      targetKmh: Math.round(target),
      arriveState: 'green',
      secondsToChange: Math.round(now.secondsLeft),
      nowState: now.state,
      etaS: Math.round(etaS),
      distanceM: Math.round(distanceM),
      signal: { id: signal.id, name: signal.name },
    };
  }
  // No reachable green: tell the driver to ease off instead of racing to a red.
  return {
    action: 'ease',
    targetKmh: Math.round(Math.max(o.minKmh, speedFor((windows[0]?.[0] ?? now.secondsLeft) + o.comfortMarginS))),
    arriveState: arrive.state,
    secondsToChange: Math.round(now.secondsLeft),
    nowState: now.state,
    etaS: Math.round(etaS),
    distanceM: Math.round(distanceM),
    signal: { id: signal.id, name: signal.name },
  };
}

/**
 * Picks the signal the car is approaching and counts how many lie ahead along
 * the same heading, so the HUD can show "3 семафори · следен за 180 m".
 */
export function signalsAhead(signals, { lat, lon, heading }, { maxDistanceM = 1200, headingToleranceDeg = 45 } = {}) {
  const ahead = [];
  for (const s of signals) {
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d > maxDistanceM) continue;
    const toSignal = bearing(lat, lon, s.lat, s.lon);
    // the signal must be roughly in front of us...
    if (heading != null && Math.abs(angleDiffDeg(toSignal, heading)) > headingToleranceDeg) continue;
    // ...and we must be approaching it from its configured direction
    if (s.heading != null && heading != null && Math.abs(angleDiffDeg(heading, s.heading)) > headingToleranceDeg) continue;
    ahead.push({ signal: s, distanceM: d });
  }
  return ahead.sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * Tracks the corridor during a drive. On each GPS fix call update(); it emits
 * advice for the nearest signal ahead and, when the advised speed changes
 * meaningfully, calls onAdvice so the app can speak it.
 */
export class GreenWave {
  constructor({ signals = [], onAdvice = () => {}, options = {} } = {}) {
    this.signals = signals;
    this.onAdvice = onAdvice;
    this.options = options;
    this.current = null; // latest advice
    this.lastSpokenKey = null;
    this.lastSpokenAt = 0;
  }

  setSignals(signals) {
    this.signals = signals ?? [];
  }

  /** fix: { t, lat, lon, heading }, speedKmh and limitKmh may be null. */
  update({ t, lat, lon, heading }, speedKmh, limitKmh) {
    if (!this.signals.length || speedKmh == null || speedKmh < 3) {
      this.current = null;
      return null;
    }
    const ahead = signalsAhead(this.signals, { lat, lon, heading }, this.options);
    if (!ahead.length) {
      this.current = null;
      return null;
    }
    const next = ahead[0];
    const advice = greenWaveAdvice({ signal: next.signal, distanceM: next.distanceM, speedKmh, nowMs: t, limitKmh, options: this.options });
    advice.countAhead = ahead.length;
    advice.secondAheadM = ahead[1] ? Math.round(ahead[1].distanceM) : null;
    this.current = advice;

    // Speak only meaningful, non-repetitive changes, and only when close enough to act.
    if (next.distanceM < 350 && next.distanceM > 40) {
      const key = `${next.signal.id}:${advice.action}:${Math.round(advice.targetKmh / 5) * 5}`;
      if (key !== this.lastSpokenKey && t - this.lastSpokenAt > 8000) {
        this.lastSpokenKey = key;
        this.lastSpokenAt = t;
        this.onAdvice(advice);
      }
    }
    return advice;
  }
}
