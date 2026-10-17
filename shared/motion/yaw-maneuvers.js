// Detects turns and lane changes from the yaw rate (gyroscope around the
// vertical axis, left-positive) and speed.
//  - Turn: the heading keeps changing in one direction by 45° or more.
//  - Lane change: a short yaw "lobe" in one direction followed by an opposite
//    lobe of similar area (the heading goes out and comes back), at speed,
//    moving the car sideways by roughly one lane width.
import { DEG, median } from '../math.js';

const DEFAULTS = {
  turnStartRate: 6 * DEG, // rad/s
  turnEndRate: 2.5 * DEG,
  turnEndHoldMs: 1200,
  turnMinAngle: 45 * DEG,
  turnMaxMs: 25000,
  laneMinSpeed: 8, // m/s (~30 km/h)
  laneLobeRate: 0.9 * DEG,
  laneLobePeak: 1.4 * DEG,
  laneLobeMinMs: 500,
  laneLobeMaxMs: 4500,
  laneMaxGapMs: 1200,
  laneHeadingMin: 1.2 * DEG,
  laneHeadingMax: 14 * DEG,
  laneLateralMin: 1.8, // m
  laneLateralMax: 6.5,
  windowMs: 14000,
  sampleMs: 50,
};

export class YawManeuverDetector {
  constructor(onManeuver, options = {}) {
    this.onManeuver = onManeuver;
    this.o = { ...DEFAULTS, ...options };
    this.samples = []; // { t, yaw, speed } at ~20 Hz
    this.turn = null;
    this.lastLaneEnd = -Infinity;
    this.lastAnalysis = -Infinity;
    this.lastSampleT = -Infinity;
  }

  add(t, yaw, speed) {
    this.trackTurn(t, yaw, speed);
    if (t - this.lastSampleT < this.o.sampleMs) return;
    this.lastSampleT = t;
    this.samples.push({ t, yaw, speed });
    while (this.samples.length && this.samples[0].t < t - this.o.windowMs) this.samples.shift();
    if (t - this.lastAnalysis >= 250) {
      this.lastAnalysis = t;
      this.findLaneChange(t);
    }
  }

  trackTurn(t, yaw, speed) {
    const o = this.o;
    if (!this.turn) {
      if (Math.abs(yaw) > o.turnStartRate && (speed == null || speed > 0.8)) {
        this.turn = { tStart: t, lastT: t, lastActive: t, angle: 0, speedSum: 0, speedN: 0 };
      }
      return;
    }
    const tr = this.turn;
    const dt = Math.min(0.2, (t - tr.lastT) / 1000);
    tr.lastT = t;
    tr.angle += yaw * dt;
    if (speed != null) {
      tr.speedSum += speed;
      tr.speedN++;
    }
    if (Math.abs(yaw) > o.turnEndRate) tr.lastActive = t;
    const settled = t - tr.lastActive > o.turnEndHoldMs;
    if (settled || t - tr.tStart > o.turnMaxMs) {
      this.turn = null;
      if (Math.abs(tr.angle) >= o.turnMinAngle) {
        this.onManeuver({
          type: 'turn',
          dir: tr.angle > 0 ? 'left' : 'right',
          angle: Math.round(Math.abs(tr.angle) / DEG),
          uTurn: Math.abs(tr.angle) > 150 * DEG,
          tStart: tr.tStart,
          tEnd: tr.lastActive,
          speed: tr.speedN ? tr.speedSum / tr.speedN : null,
          source: 'imu',
        });
      }
    }
  }

  findLaneChange(now) {
    const o = this.o;
    const s = this.samples;
    if (s.length < 40 || this.turn) return;
    const recent = s.filter((x) => x.t > now - 8000);
    if (recent.some((x) => x.speed == null || x.speed < o.laneMinSpeed)) return;

    const baseline = median(s.map((x) => x.yaw)); // steady curve of the road
    const lobes = [];
    let cur = null;
    for (let i = 0; i < s.length; i++) {
      const w = s[i].yaw - baseline;
      const sign = Math.abs(w) > o.laneLobeRate ? Math.sign(w) : 0;
      if (cur && sign === cur.sign) {
        const dt = (s[i].t - s[i - 1].t) / 1000;
        cur.area += w * dt;
        cur.peak = Math.max(cur.peak, Math.abs(w));
        cur.end = s[i].t;
        cur.endIndex = i;
      } else {
        if (cur) lobes.push(cur);
        cur = sign ? { sign, start: s[i].t, end: s[i].t, startIndex: i, endIndex: i, area: 0, peak: Math.abs(w) } : null;
      }
    }
    if (cur) lobes.push({ ...cur, open: true });
    mergeShortGaps(lobes, 250);

    for (let k = 0; k + 1 < lobes.length; k++) {
      const a = lobes[k];
      const b = lobes[k + 1];
      if (b.open || b.end > now - 400 || a.start <= this.lastLaneEnd) continue;
      if (a.sign === b.sign || b.start - a.end > o.laneMaxGapMs) continue;
      const okDuration = (l) => l.end - l.start >= o.laneLobeMinMs && l.end - l.start <= o.laneLobeMaxMs;
      if (!okDuration(a) || !okDuration(b)) continue;
      if (a.peak < o.laneLobePeak || b.peak < o.laneLobePeak) continue;
      const ratio = Math.abs(b.area) / Math.abs(a.area);
      if (ratio < 0.45 || ratio > 2.2) continue;
      if (Math.abs(a.area) < o.laneHeadingMin || Math.abs(a.area) > o.laneHeadingMax) continue;

      let heading = 0;
      let lateral = 0;
      for (let i = a.startIndex + 1; i <= b.endIndex; i++) {
        const dt = (s[i].t - s[i - 1].t) / 1000;
        heading += (s[i].yaw - baseline) * dt;
        lateral += s[i].speed * Math.sin(heading) * dt;
      }
      if (Math.abs(lateral) < o.laneLateralMin || Math.abs(lateral) > o.laneLateralMax) continue;

      this.lastLaneEnd = b.end;
      this.onManeuver({
        type: 'lane_change',
        dir: a.sign > 0 ? 'left' : 'right',
        tStart: a.start,
        tEnd: b.end,
        lateral: Math.round(Math.abs(lateral) * 10) / 10,
        source: 'imu',
      });
    }
  }
}

/** Joins same-direction lobes split by a brief dip under the threshold (sensor noise). */
function mergeShortGaps(lobes, maxGapMs) {
  for (let k = 0; k + 1 < lobes.length; ) {
    const a = lobes[k];
    const b = lobes[k + 1];
    if (a.sign === b.sign && b.start - a.end <= maxGapMs) {
      a.area += b.area;
      a.peak = Math.max(a.peak, b.peak);
      a.end = b.end;
      a.endIndex = b.endIndex;
      a.open = b.open;
      lobes.splice(k + 1, 1);
    } else k++;
  }
}
