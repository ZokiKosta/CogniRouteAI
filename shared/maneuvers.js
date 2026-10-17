// Judges each maneuver the way a driving instructor would:
//   ретровизор → мигавец → (мртов агол) → маневар
// Lane changes, turns and reversing come from the motion sensors and/or the
// road camera; the turn signal from the microphone; mirror glances from the
// driver camera. Missing inputs give "unknown" instead of a penalty.
import { makeEvent } from './events.js';

const WINDOWS = {
  lane_change: { blinker: [-8000, 1000], mirrors: [-7000, 500] },
  turn: { blinker: [-10000, 2000], mirrors: [-8000, 1000] },
  reverse: { mirrors: [-6000, 0] }, // plus the whole time spent reversing
};

const REQUIRED = {
  left: { side: 'left_mirror', shoulder: 'left_shoulder' },
  right: { side: 'right_mirror', shoulder: 'right_shoulder' },
};

const REVERSE_ZONES = new Set(['rear_mirror', 'left_mirror', 'right_mirror', 'left_shoulder', 'right_shoulder']);
const NON_CHECK = new Set(['road', 'down']);

export class ManeuverJudge {
  constructor({ onManeuver = () => {}, onEvent = () => {}, mergeDelayMs = 2500 } = {}) {
    this.onManeuver = onManeuver;
    this.onEvent = onEvent;
    this.mergeDelayMs = mergeDelayMs;
    this.blinkers = []; // { start, end }
    this.gazeSamples = []; // { t, zone }
    this.pending = [];
    this.caps = { audio: false, driverCam: false, calibratedGaze: false };
    this.count = 0;
  }

  setCapabilities(caps) {
    Object.assign(this.caps, caps);
  }

  blinker({ on, t }) {
    const last = this.blinkers[this.blinkers.length - 1];
    if (on && (!last || last.end != null)) this.blinkers.push({ start: t, end: null });
    else if (!on && last && last.end == null) last.end = t;
    this.prune(t);
  }

  gaze(t, zone) {
    this.gazeSamples.push({ t, zone });
    this.prune(t);
  }

  prune(t) {
    const cutoff = t - 120000;
    while (this.gazeSamples.length && this.gazeSamples[0].t < cutoff) this.gazeSamples.shift();
    this.blinkers = this.blinkers.filter((b) => b.end == null || b.end > cutoff);
  }

  addManeuver(m) {
    if (m.type === 'lane_change') {
      const mid = (m.tStart + m.tEnd) / 2;
      const twin = this.pending.find((p) => p.type === 'lane_change' && p.dir === m.dir && Math.abs((p.tStart + p.tEnd) / 2 - mid) < 4000);
      if (twin) {
        twin.tStart = Math.min(twin.tStart, m.tStart);
        twin.tEnd = Math.max(twin.tEnd, m.tEnd);
        twin.sources = [...new Set([...twin.sources, m.source])];
        if (m.lineType) twin.lineType = m.lineType;
        return;
      }
    }
    this.pending.push({ ...m, sources: [m.source] });
  }

  /** Evaluates maneuvers that had time to be merged; call regularly (e.g. every second). */
  tick(now) {
    const ready = this.pending.filter((p) => now - p.tEnd >= this.mergeDelayMs);
    this.pending = this.pending.filter((p) => now - p.tEnd < this.mergeDelayMs);
    for (const m of ready) this.evaluate(m);
  }

  flush() {
    const all = this.pending;
    this.pending = [];
    for (const m of all) this.evaluate(m);
  }

  blinkerUsed(t0, t1) {
    if (!this.caps.audio) return { used: null };
    const hit = this.blinkers.find((b) => b.start <= t1 && (b.end ?? Infinity) >= t0);
    return { used: !!hit, start: hit?.start ?? null };
  }

  glances(t0, t1) {
    const window = this.gazeSamples.filter((s) => s.t >= t0 && s.t <= t1);
    if (!this.caps.driverCam || window.length < 3) return null;
    const seen = window.filter((s) => s.zone != null).length / window.length;
    if (seen < 0.5) return null; // face not visible enough to judge
    const zones = new Map();
    for (let i = 0; i < window.length; i++) {
      const z = window[i].zone;
      if (!z || NON_CHECK.has(z)) continue;
      // Two samples in a row (or one long one) make a glance.
      const ok = window[i + 1]?.zone === z || window[i - 1]?.zone === z;
      if (ok && !zones.has(z)) zones.set(z, window[i].t);
    }
    return zones;
  }

  mirrorsFor(m, zones) {
    if (!zones) return { mirrors: null, glances: [] };
    const glances = [...zones.keys()];
    if (!glances.length) return { mirrors: 'none', glances };
    if (!this.caps.calibratedGaze) return { mirrors: 'partial', glances }; // a glance away, side unknown
    if (m.type === 'reverse') {
      const checks = glances.filter((g) => REVERSE_ZONES.has(g));
      return { mirrors: checks.length >= 2 ? 'full' : checks.length ? 'partial' : 'none', glances };
    }
    const req = REQUIRED[m.dir];
    const side = zones.has(req.side) || zones.has(req.shoulder);
    const rear = zones.has('rear_mirror');
    return { mirrors: side && rear ? 'full' : side || rear ? 'partial' : 'none', glances, shoulder: zones.has(req.shoulder) };
  }

  evaluate(m) {
    const w = WINDOWS[m.type];
    if (!w) return;
    this.count++;
    const result = { ...m, id: `${m.type}-${m.tStart}`, blinker: null, mirrors: null, glances: [] };
    if (w.blinker) {
      const b = this.blinkerUsed(m.tStart + w.blinker[0], m.tStart + w.blinker[1]);
      result.blinker = b.used;
      if (b.start != null) result.blinkerLeadS = Math.round((m.tStart - b.start) / 100) / 10;
    }
    const mirrorEnd = m.type === 'reverse' ? m.tEnd : m.tStart + w.mirrors[1];
    const zones = this.glances(m.tStart + w.mirrors[0], mirrorEnd);
    Object.assign(result, this.mirrorsFor(m, zones));
    if (zones && result.blinker && zones.size) {
      const firstGlance = Math.min(...zones.values());
      const blinkerStart = this.blinkers.find((b) => b.start <= m.tStart + w.blinker[1] && (b.end ?? Infinity) >= m.tStart + w.blinker[0])?.start;
      if (blinkerStart != null) result.order = firstGlance <= blinkerStart ? 'mirror_first' : 'blinker_first';
    }
    this.onManeuver(result);

    const at = m.tStart;
    const fields = { maneuverId: result.id, dir: m.dir, lat: m.lat, lon: m.lon, source: 'judge' };
    if (m.type === 'lane_change') {
      if (m.lineType === 'solid') this.onEvent(makeEvent('solid_line_crossing', at, fields));
      if (result.blinker === false) this.onEvent(makeEvent('lane_change_no_blinker', at, fields));
    }
    if (m.type === 'turn' && result.blinker === false) this.onEvent(makeEvent('turn_no_blinker', at, fields));
    if (m.type === 'reverse') {
      if (result.mirrors === 'none') this.onEvent(makeEvent('reverse_no_check', at, fields));
    } else if (result.mirrors === 'none') this.onEvent(makeEvent('no_mirror_check', at, fields));
    else if (result.mirrors === 'partial' && this.caps.calibratedGaze) this.onEvent(makeEvent('partial_mirror_check', at, fields));
  }
}
