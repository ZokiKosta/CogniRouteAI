// Driver camera: where the driver is looking (road, mirrors, shoulder, down)
// from MediaPipe Face Landmarker head pose + eye blendshapes, and signs of
// distraction and drowsiness.
//
// Phones sit in different places, so the mirror directions are learned in a
// short calibration ("look at the left mirror", ...). Without calibration the
// monitor still knows "road" (learned while driving) and "glance away".
import { makeEvent } from './events.js';
import { median } from './math.js';

export const GAZE_ZONES = {
  road: 'пат',
  left_mirror: 'лев ретровизор',
  rear_mirror: 'внатрешен ретровизор',
  right_mirror: 'десен ретровизор',
  left_shoulder: 'преку лево рамо',
  right_shoulder: 'преку десно рамо',
  down: 'надолу',
  glance: 'настрана',
};

export const CALIBRATION_STEPS = [
  { zone: 'road', prompt: 'Гледај право напред во патот' },
  { zone: 'left_mirror', prompt: 'Погледни во левиот ретровизор' },
  { zone: 'rear_mirror', prompt: 'Погледни во внатрешниот ретровизор' },
  { zone: 'right_mirror', prompt: 'Погледни во десниот ретровизор' },
  { zone: 'down', prompt: 'Погледни надолу кон инструмент-таблата' },
];

const blend = (categories, name) => categories.find((c) => c.categoryName === name)?.score ?? 0;

/** Head yaw/pitch (degrees) and eye-gaze/blink/yawn features from a FaceLandmarkerResult. */
export function extractFaceFeatures(result) {
  const m = result?.facialTransformationMatrixes?.[0]?.data;
  const cats = result?.faceBlendshapes?.[0]?.categories;
  if (!m || !cats) return null;
  // Third column of the rotation = where the face points (column-major 4x4).
  const fx = m[8];
  const fy = m[9];
  const fz = m[10];
  const yaw = (Math.atan2(fx, fz) * 180) / Math.PI;
  const pitch = (Math.atan2(-fy, Math.hypot(fx, fz)) * 180) / Math.PI;
  const eyeH =
    (blend(cats, 'eyeLookOutLeft') + blend(cats, 'eyeLookInRight') - blend(cats, 'eyeLookInLeft') - blend(cats, 'eyeLookOutRight')) / 2;
  const eyeV =
    (blend(cats, 'eyeLookUpLeft') + blend(cats, 'eyeLookUpRight') - blend(cats, 'eyeLookDownLeft') - blend(cats, 'eyeLookDownRight')) / 2;
  const blink = (blend(cats, 'eyeBlinkLeft') + blend(cats, 'eyeBlinkRight')) / 2;
  return { yaw, pitch, eyeH, eyeV, blink, jawOpen: blend(cats, 'jawOpen') };
}

/** Feature vector in roughly comparable units (degrees of gaze). */
const vec = (f) => [f.yaw, f.pitch, f.eyeH * 30, f.eyeV * 25];
const MIN_STD = [4, 4, 4, 4];

export class GazeCalibrator {
  constructor() {
    this.samples = {};
  }

  add(zone, features) {
    if (!features || features.blink > 0.5) return;
    (this.samples[zone] ??= []).push(vec(features));
  }

  count(zone) {
    return this.samples[zone]?.length ?? 0;
  }

  /** { zone: { mean, std } } for zones with enough samples, or null when the mirrors are missing. */
  result(minSamples = 8) {
    const out = {};
    for (const [zone, list] of Object.entries(this.samples)) {
      if (list.length < minSamples) continue;
      const mean = [0, 1, 2, 3].map((k) => median(list.map((v) => v[k])));
      const std = [0, 1, 2, 3].map((k) => Math.max(MIN_STD[k], Math.sqrt(list.reduce((s, v) => s + (v[k] - mean[k]) ** 2, 0) / list.length)));
      out[zone] = { mean: mean.map((x) => Math.round(x * 10) / 10), std: std.map((x) => Math.round(x * 10) / 10) };
    }
    return ['road', 'left_mirror', 'rear_mirror', 'right_mirror'].every((z) => out[z]) ? out : null;
  }
}

/** Nearest calibrated zone; shoulder checks are glances beyond the side mirrors. */
export function classifyGaze(features, calibration) {
  const v = vec(features);
  let best = null;
  for (const [zone, c] of Object.entries(calibration)) {
    let d2 = 0;
    for (let k = 0; k < 4; k++) d2 += ((v[k] - c.mean[k]) / c.std[k]) ** 2;
    const d = Math.sqrt(d2 / 4);
    if (!best || d < best.d) best = { zone, d };
  }
  const road = calibration.road.mean[0];
  for (const [mirror, shoulder] of [
    ['left_mirror', 'left_shoulder'],
    ['right_mirror', 'right_shoulder'],
  ]) {
    const m = calibration[mirror].mean[0];
    const dir = Math.sign(m - road);
    if (dir && (features.yaw - m) * dir > 20) return { zone: shoulder, distance: best.d };
  }
  if (best.d > 3.5) return { zone: 'glance', distance: best.d };
  return { zone: best.zone, distance: best.d };
}

const DEFAULTS = {
  minSpeed: 5, // m/s: below this nothing counts as distraction
  distractionMs: 2000,
  distractionAlertMs: 1500,
  eyesClosedMs: 1000,
  blinkClosed: 0.55,
  perclosWindowMs: 60000,
  perclos: 0.15,
  yawnOpen: 0.6,
  yawnMs: 1200,
  yawnsForBreak: 3,
  yawnWindowMs: 600000,
};

export class DriverMonitor {
  constructor({ onEvent = () => {}, onAlert = () => {}, onGaze = () => {}, calibration = null, options = {} } = {}) {
    this.onEvent = onEvent;
    this.onAlert = onAlert;
    this.onGaze = onGaze;
    this.calibration = calibration;
    this.o = { ...DEFAULTS, ...options };
    this.roadSamples = [];
    this.awaySince = null;
    this.awayZone = null;
    this.closedSince = null;
    this.eyes = [];
    this.yawnSince = null;
    this.yawns = [];
    this.lastEvent = {};
    this.lastAlert = {};
    this.state = { face: false, zone: null, blink: 0 };
  }

  setCalibration(calibration) {
    this.calibration = calibration;
  }

  /** Learns the "looking at the road" pose while driving when there is no calibration. */
  roadPose() {
    if (this.roadSamples.length < 30) return null;
    return [0, 1].map((k) => median(this.roadSamples.map((v) => v[k])));
  }

  classify(features, speed) {
    if (this.calibration) return classifyGaze(features, this.calibration).zone;
    const v = vec(features);
    const gaze = [v[0] + v[2], v[1] + v[3]]; // head + eyes
    if (speed != null && speed > 8) {
      this.roadSamples.push(gaze);
      if (this.roadSamples.length > 600) this.roadSamples.shift();
    }
    const road = this.roadPose();
    if (!road) return null;
    const dYaw = gaze[0] - road[0];
    const dPitch = gaze[1] - road[1];
    if (dPitch < -15 && Math.abs(dYaw) < 25) return 'down';
    if (Math.hypot(dYaw, dPitch) > 18) return 'glance';
    return 'road';
  }

  alert(kind, t, cooldownMs, payload = {}) {
    if (t - (this.lastAlert[kind] ?? -Infinity) < cooldownMs) return;
    this.lastAlert[kind] = t;
    this.onAlert({ kind, t, ...payload });
  }

  event(type, t, cooldownMs, fields) {
    if (t - (this.lastEvent[type] ?? -Infinity) < cooldownMs) return;
    this.lastEvent[type] = t;
    this.onEvent(makeEvent(type, t, { source: 'driver_cam', ...fields }));
  }

  /** features from extractFaceFeatures (null when no face is visible); speed in m/s. */
  update(t, features, speed = null, where = {}) {
    const o = this.o;
    const moving = speed == null || speed > o.minSpeed;
    if (!features) {
      this.state = { face: false, zone: null, blink: 0 };
      this.onGaze(t, null);
      this.awaySince = null;
      this.closedSince = null;
      return;
    }
    const zone = this.classify(features, speed);
    this.state = { face: true, zone, blink: features.blink, yaw: features.yaw, pitch: features.pitch };
    this.onGaze(t, zone);

    // Looking down or away for too long (mirror glances are short and expected).
    const away = zone === 'down' || zone === 'glance';
    if (away && moving) {
      this.awaySince ??= t;
      this.awayZone = zone;
      const dur = t - this.awaySince;
      if (dur > o.distractionAlertMs) this.alert('distraction', t, 10000);
      if (dur > o.distractionMs) {
        this.event('distraction', this.awaySince, 30000, { durationS: Math.round(dur / 100) / 10, zone, speedKmh: speed != null ? Math.round(speed * 3.6) : null, ...where });
      }
    } else this.awaySince = null;

    // Eyes closed for a second at speed: microsleep.
    const closed = features.blink > o.blinkClosed;
    if (closed && moving) {
      this.closedSince ??= t;
      if (t - this.closedSince > o.eyesClosedMs) {
        this.alert('drowsy', t, 5000);
        this.event('drowsiness', this.closedSince, 60000, { detail: 'eyes_closed', durationS: Math.round((t - this.closedSince) / 100) / 10, ...where });
      }
    } else this.closedSince = null;

    // PERCLOS: share of time with eyes (mostly) closed over the last minute.
    this.eyes.push({ t, closed });
    while (this.eyes.length && this.eyes[0].t < t - o.perclosWindowMs) this.eyes.shift();
    if (this.eyes.length > 300 && moving) {
      const perclos = this.eyes.filter((e) => e.closed).length / this.eyes.length;
      if (perclos > o.perclos) {
        this.alert('drowsy', t, 60000, { perclos });
        this.event('drowsiness', t, 300000, { detail: 'perclos', value: Math.round(perclos * 100) / 100, ...where });
      }
    }

    // Yawning several times in ten minutes: suggest a break.
    if (features.jawOpen > o.yawnOpen) {
      this.yawnSince ??= t;
    } else if (this.yawnSince != null) {
      if (t - this.yawnSince > o.yawnMs) this.yawns.push(t);
      this.yawnSince = null;
      this.yawns = this.yawns.filter((y) => y > t - o.yawnWindowMs);
      if (this.yawns.length >= o.yawnsForBreak) {
        this.yawns = [];
        this.alert('break', t, 600000);
        this.event('drowsiness', t, 600000, { detail: 'yawning', ...where });
      }
    }
  }
}
