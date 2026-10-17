// Turns road-camera detections into safety signals: distance and time gap
// to the vehicle ahead, time to collision, pedestrians/cyclists/animals in
// the car's path, and whether the car really stopped at a STOP sign.
import { makeEvent } from '../events.js';
import { lineX } from './lanes.js';
import { VEHICLE_CLASSES, VULNERABLE_CLASSES } from './yolo.js';

const REAL_WIDTH = { car: 1.8, bus: 2.55, truck: 2.5, motorcycle: 0.8, bicycle: 0.6, dog: 0.35, sheep: 0.5, horse: 0.6, cow: 0.8 };
const PERSON_HEIGHT = 1.7;

export const CAMERA_DEFAULTS = { hfovDeg: 63, horizon: 0.5, hood: 0.94, camHeight: 1.3, centerX: 0.5 };

export const focalPx = (frameW, hfovDeg) => frameW / 2 / Math.tan((hfovDeg * Math.PI) / 360);

/** Distance in meters to a detected object, from its size and from where it touches the road. */
export function estimateDistance(det, frameW, frameH, camera = CAMERA_DEFAULTS) {
  const c = { ...CAMERA_DEFAULTS, ...camera };
  const f = focalPx(frameW, c.hfovDeg);
  const [x1, y1, x2, y2] = det.box;
  let bySize = null;
  if (det.cls === 'person') bySize = (PERSON_HEIGHT * f) / Math.max(1, y2 - y1);
  else if (REAL_WIDTH[det.cls]) bySize = (REAL_WIDTH[det.cls] * f) / Math.max(1, x2 - x1);
  const yh = c.horizon * frameH;
  const groundOk = y2 > yh + 3 && y2 < c.hood * frameH - 2;
  const byGround = groundOk ? (f * c.camHeight) / (y2 - yh) : null;
  if (bySize && byGround) return (bySize + byGround) / 2;
  return bySize ?? byGround;
}

/** Lateral offset (m, right positive) of the object's bottom centre from the car's centre line. */
export function lateralOffset(det, distance, frameW, camera = CAMERA_DEFAULTS) {
  const c = { ...CAMERA_DEFAULTS, ...camera };
  const cx = (det.box[0] + det.box[2]) / 2;
  return ((cx - c.centerX * frameW) * distance) / focalPx(frameW, c.hfovDeg);
}

/** Closest vehicle in the car's own lane (between the tracked lane lines, or a central corridor). */
export function findLead(detections, frameW, frameH, lane = {}, camera = CAMERA_DEFAULTS) {
  const c = { ...CAMERA_DEFAULTS, ...camera };
  const yh = c.horizon * frameH;
  const bottom = c.hood * frameH;
  let lead = null;
  for (const d of detections) {
    if (!VEHICLE_CLASSES.has(d.cls)) continue;
    const cx = (d.box[0] + d.box[2]) / 2;
    const by = d.box[3];
    let inLane;
    if (lane.left?.top != null && lane.right?.top != null) {
      inLane = cx > lineX(lane.left, by) && cx < lineX(lane.right, by);
    } else {
      const s = Math.max(0, Math.min(1, (by - yh) / Math.max(1, bottom - yh)));
      inLane = Math.abs(cx - c.centerX * frameW) < frameW * (0.04 + 0.3 * s);
    }
    if (inLane && (!lead || by > lead.box[3])) lead = d;
  }
  return lead;
}

const DEFAULTS = {
  tailgateHeadway: 2.0, // s, the 2-second rule
  dangerHeadway: 0.8,
  minTailgateMs: 3000,
  minSpeed: 8, // m/s; below this, gaps are not judged
  ttcAlert: 2.5, // s
  pedestrianRange: 25, // m
  pedestrianCorridor: 2.5, // m each side of the centre line
  stopSignMinWidth: 0.025, // share of frame width
  stopSignSpeed: 1.5, // m/s; slower than this counts as stopped
};

export class RoadRiskMonitor {
  constructor({ onEvent = () => {}, onAlert = () => {}, camera = {}, options = {} } = {}) {
    this.onEvent = onEvent;
    this.onAlert = onAlert;
    this.camera = { ...CAMERA_DEFAULTS, ...camera };
    this.o = { ...DEFAULTS, ...options };
    this.leadHistory = [];
    this.tailgate = null;
    this.lastAlert = {};
    this.lastEvent = {};
    this.stop = null;
    this.state = { lead: null, vulnerable: [] };
  }

  configure(camera) {
    Object.assign(this.camera, camera);
  }

  alert(kind, t, cooldownMs, payload) {
    if (t - (this.lastAlert[kind] ?? -Infinity) < cooldownMs) return;
    this.lastAlert[kind] = t;
    this.onAlert({ kind, t, ...payload });
  }

  update(t, { detections, frameW, frameH, lane = {}, speed = null, where = {} }) {
    this.updateLead(t, detections, frameW, frameH, lane, speed, where);
    this.updateVulnerable(t, detections, frameW, frameH, speed, where);
    this.updateStopSign(t, detections, frameW, speed, where);
  }

  updateLead(t, detections, frameW, frameH, lane, speed, where) {
    const o = this.o;
    const lead = findLead(detections, frameW, frameH, lane, this.camera);
    const d = lead ? estimateDistance(lead, frameW, frameH, this.camera) : null;
    const prev = this.leadHistory[this.leadHistory.length - 1];
    if (d == null || (prev && Math.abs(d - prev.d) > Math.max(6, prev.d * 0.35))) this.leadHistory = [];
    if (d != null) this.leadHistory.push({ t, d });
    this.leadHistory = this.leadHistory.filter((h) => h.t > t - 1500);

    let closing = null;
    if (this.leadHistory.length >= 4) {
      const h = this.leadHistory;
      const mt = h.reduce((s, x) => s + x.t, 0) / h.length;
      const md = h.reduce((s, x) => s + x.d, 0) / h.length;
      let num = 0;
      let den = 0;
      for (const x of h) {
        num += (x.t - mt) * (x.d - md);
        den += (x.t - mt) ** 2;
      }
      closing = den > 0 ? (-num / den) * 1000 : null; // m/s, positive when the gap shrinks
    }
    const dist = this.leadHistory.length ? this.leadHistory.reduce((s, x) => s + x.d, 0) / this.leadHistory.length : null;
    const headway = dist != null && speed != null && speed > o.minSpeed ? dist / speed : null;
    const ttc = dist != null && closing != null && closing > 0.5 ? dist / closing : null;
    this.state.lead = lead ? { box: lead.box, cls: lead.cls, distance: dist, headway, ttc } : null;

    if (ttc != null && ttc < o.ttcAlert && dist < 50) this.alert('collision', t, 5000, { distance: dist, ttc });

    if (headway != null && headway < o.tailgateHeadway) {
      const ep = (this.tailgate ??= { start: t, minHeadway: headway, distance: dist, speed, alerted: false, ...where });
      ep.last = t;
      if (headway < ep.minHeadway) Object.assign(ep, { minHeadway: headway, distance: dist, speed });
      const danger = headway < o.dangerHeadway;
      if (!ep.alerted && (t - ep.start >= o.minTailgateMs || (danger && t - ep.start >= 1000))) {
        ep.alerted = true;
        this.alert('tailgating', t, 15000, { headway, distance: dist });
      }
    } else if (this.tailgate && (headway == null ? t - this.tailgate.last > 1500 : headway > o.tailgateHeadway + 0.3)) {
      const ep = this.tailgate;
      this.tailgate = null;
      if (ep.last - ep.start >= o.minTailgateMs) {
        this.onEvent(
          makeEvent('tailgating', ep.start, {
            tEnd: ep.last,
            value: Math.round(ep.minHeadway * 10) / 10,
            unit: 's',
            distanceM: Math.round(ep.distance),
            speedKmh: ep.speed != null ? Math.round(ep.speed * 3.6) : null,
            durationS: Math.round((ep.last - ep.start) / 1000),
            lat: ep.lat,
            lon: ep.lon,
            source: 'road_cam',
          }),
        );
      }
    }
  }

  updateVulnerable(t, detections, frameW, frameH, speed, where) {
    const o = this.o;
    const near = [];
    for (const det of detections) {
      if (!VULNERABLE_CLASSES.has(det.cls)) continue;
      const d = estimateDistance(det, frameW, frameH, this.camera);
      if (d == null) continue;
      const x = lateralOffset(det, d, frameW, this.camera);
      if (d < o.pedestrianRange && Math.abs(x) < o.pedestrianCorridor) near.push({ cls: det.cls, distance: d, offset: x, box: det.box });
    }
    this.state.vulnerable = near;
    if (!near.length || speed == null || speed < 2) return;
    const closest = near.reduce((a, b) => (a.distance < b.distance ? a : b));
    this.alert('pedestrian', t, 8000, { cls: closest.cls, distance: closest.distance });
    if (t - (this.lastEvent.pedestrian ?? -Infinity) > 20000) {
      this.lastEvent.pedestrian = t;
      this.onEvent(
        makeEvent('pedestrian_alert', t, {
          cls: closest.cls,
          distanceM: Math.round(closest.distance),
          speedKmh: Math.round(speed * 3.6),
          lat: where.lat,
          lon: where.lon,
          source: 'road_cam',
        }),
      );
    }
  }

  updateStopSign(t, detections, frameW, speed, where) {
    const o = this.o;
    const sign = detections.find((d) => d.cls === 'stop sign' && d.box[2] - d.box[0] >= frameW * o.stopSignMinWidth);
    if (sign) {
      this.stop ??= { first: t, minSpeed: Infinity, ...where };
      this.stop.lastSeen = t;
    }
    if (!this.stop) return;
    if (speed != null) this.stop.minSpeed = Math.min(this.stop.minSpeed, speed);
    // Judge a few seconds after the sign is out of view (the car has reached the junction).
    if (t - this.stop.lastSeen > 4000) {
      const s = this.stop;
      this.stop = null;
      if (Number.isFinite(s.minSpeed) && s.minSpeed > o.stopSignSpeed) {
        this.onEvent(
          makeEvent('stop_sign_violation', s.first, {
            tEnd: t,
            value: Math.round(s.minSpeed * 3.6),
            unit: 'km/h',
            lat: s.lat,
            lon: s.lon,
            source: 'road_cam',
          }),
        );
      }
    }
  }
}
