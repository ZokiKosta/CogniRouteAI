// Turns raw phone motion sensors + GPS into driving signals and events:
// harsh braking / acceleration / cornering, standing still, reversing,
// turns and lane changes, and "the phone was moved while driving".
import { G, Ema, TimeBuffer, angleBetween, angleDiffDeg, bearing, clamp, haversine, mean, norm, scale, std, sub } from '../math.js';
import { makeEvent } from '../events.js';
import { MountCalibration } from './calibration.js';
import { YawManeuverDetector } from './yaw-maneuvers.js';

const DEFAULTS = {
  harshBrake: 3.4, // m/s² (~0.35 g)
  harshAccel: 3.0, // m/s² (~0.3 g)
  harshCorner: 4.0, // m/s² (~0.4 g)
  minEventMs: 300,
  eventCooldownMs: 3000,
  minSpeed: 1.5, // m/s, below this nothing counts as harsh
  gpsMaxAgeMs: 3000,
  stationaryAccStd: 0.15,
  stationaryGyro: 0.035, // rad/s
  stopHoldMs: 800,
  goHoldMs: 150,
  reverseSpeed: 0.45, // m/s integrated from standstill
  reverseMaxGpsSpeed: 4.5,
  mountMovedDeg: 15,
  mountMovedHoldMs: 2000,
};

export class MotionAnalyzer {
  constructor({ onEvent = () => {}, onManeuver = () => {}, onStatus = () => {}, options = {} } = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.onEvent = onEvent;
    this.onManeuver = onManeuver;
    this.onStatus = onStatus;
    this.cal = new MountCalibration();
    this.yawDetector = new YawManeuverDetector((m) => this.onManeuver(m));
    this.longF = new Ema(0.25);
    this.latF = new Ema(0.25);
    this.yawF = new Ema(0.2);
    this.quiet = new TimeBuffer(1000);
    this.longBuf = new TimeBuffer(3000);
    this.lastT = null;
    this.lastQuietT = null;
    this.switchSince = null;
    this.gravityEstimate = null;
    this.harsh = {};
    this.lastEventAt = {};
    this.rev = { armed: false, bias: null, quietTime: 0, v: 0, startT: null, decided: null, active: false, dist: 0 };
    this.mountSince = null;
    this.fix = null;
    this.state = { speed: null, aLong: 0, aLat: 0, yawRate: 0, stationary: false, motion: 'unknown' };
  }

  speedAt(t) {
    return this.fix && t - this.fix.t <= this.o.gpsMaxAgeMs ? this.fix.speed : null;
  }

  get calibration() {
    return this.cal.status;
  }

  /** accG/acc in m/s² (device axes, as in DeviceMotionEvent), gyro in rad/s [x, y, z]. */
  addMotion({ t, acc = null, accG, gyro = null }) {
    if (!accG || !accG.every(Number.isFinite)) return;
    const dt = this.lastT == null ? 0.016 : clamp((t - this.lastT) / 1000, 0.001, 0.2);
    this.lastT = t;
    const hasLinear = acc && acc.every(Number.isFinite);
    const gravity = hasLinear ? sub(accG, acc) : this.estimateGravity(accG, gyro, dt);
    this.cal.updateGravity(gravity, dt);
    const lin = hasLinear ? acc : sub(accG, scale(this.cal.up, G));
    this.cal.accumulate(lin, gyro, dt);

    const v = this.cal.toVehicle(lin);
    const aLong = this.longF.update(v.long, dt);
    const aLat = this.latF.update(v.lat, dt);
    const yawRate = this.yawF.update(gyro ? this.cal.yawRate(gyro) : 0, dt);
    Object.assign(this.state, { aLong, aLat, yawRate });

    const speed = this.speedAt(t);
    this.updateStationary(t, accG, gyro, speed);
    this.detectHarsh(t, aLong, aLat, speed);
    this.detectReverse(t, v.long, dt, speed);
    if (gyro) this.yawDetector.add(t, yawRate, speed);
    this.checkMount(t, speed);
  }

  /** speed in m/s and heading in degrees may be null (some phones omit them). */
  addGps({ t, lat, lon, speed = null, heading = null, accuracy = null }) {
    const prev = this.fix;
    let v = Number.isFinite(speed) ? speed : null;
    const dt = prev ? (t - prev.t) / 1000 : 0;
    if (v == null && prev && dt > 0.2) v = haversine(prev.lat, prev.lon, lat, lon) / dt;
    let course = Number.isFinite(heading) ? heading : null;
    if (course == null && prev && v != null && v > 2) course = bearing(prev.lat, prev.lon, lat, lon);

    if (prev && dt > 0.2 && dt < 5 && (accuracy == null || accuracy < 40)) {
      const dvdt = v != null && prev.speed != null ? (v - prev.speed) / dt : null;
      const courseRate =
        course != null && prev.heading != null && v > 3 && prev.speed > 3 ? angleDiffDeg(course, prev.heading) / dt : null;
      this.cal.learnFromGps({ speed: v, dvdt, courseRate });
    } else {
      this.cal.resetInterval();
    }
    this.fix = { t, lat, lon, speed: v, heading: course, accuracy };
    this.state.speed = v;
  }

  estimateGravity(accG, gyro, dt) {
    if (!this.gravityEstimate) this.gravityEstimate = [...accG];
    else if (Math.abs(norm(accG) - G) < 0.8 && (!gyro || norm(gyro) < 0.3)) {
      const k = 1 - Math.exp(-dt / 2);
      for (let i = 0; i < 3; i++) this.gravityEstimate[i] += (accG[i] - this.gravityEstimate[i]) * k;
    }
    return this.gravityEstimate;
  }

  updateStationary(t, accG, gyro, speed) {
    this.quiet.push(t, { a: accG, w: gyro ? norm(gyro) : 0 });
    const items = this.quiet.values();
    if (items.length < 10 || t - this.quiet.items[0].t < 600) return;
    // Per-axis spread catches a gentle start too (the magnitude of accG barely changes then).
    const accSpread = Math.max(...[0, 1, 2].map((i) => std(items.map((x) => x.a[i]))));
    const imuQuiet = accSpread < this.o.stationaryAccStd && mean(items.map((x) => x.w)) < this.o.stationaryGyro;
    if (imuQuiet) this.lastQuietT = t;
    // GPS speed tells a slow, smooth roll (e.g. reversing) apart from standing still.
    const stationary = imuQuiet && !(speed != null && speed > 0.8);
    if (stationary === this.state.stationary) {
      this.switchSince = null;
      return;
    }
    this.switchSince ??= t;
    if (t - this.switchSince >= (stationary ? this.o.stopHoldMs : this.o.goHoldMs)) {
      this.switchSince = null;
      this.state.stationary = stationary;
      if (stationary) this.state.motion = 'stopped';
      this.onStatus({ type: stationary ? 'stopped' : 'moving', t });
    }
  }

  detectHarsh(t, aLong, aLat, speed) {
    const moving = speed != null ? speed > this.o.minSpeed : !this.state.stationary;
    this.checkThreshold('harsh_brake', t, -aLong, this.o.harshBrake, moving, speed);
    this.checkThreshold('harsh_accel', t, aLong, this.o.harshAccel, moving, speed);
    this.checkThreshold('harsh_corner', t, Math.abs(aLat), this.o.harshCorner, moving, speed, { dir: aLat > 0 ? 'left' : 'right' });
  }

  checkThreshold(type, t, value, threshold, moving, speed, extra = {}) {
    const h = (this.harsh[type] ??= { active: false });
    if (!h.active) {
      if (moving && value > threshold && t - (this.lastEventAt[type] ?? -Infinity) > this.o.eventCooldownMs) {
        Object.assign(h, { active: true, start: t, peak: value, speed, extra });
      }
      return;
    }
    if (value > h.peak) Object.assign(h, { peak: value, extra });
    if (value >= threshold * 0.8) return;
    h.active = false;
    if (t - h.start < this.o.minEventMs) return;
    this.lastEventAt[type] = t;
    this.onEvent(
      makeEvent(type, h.start, {
        tEnd: t,
        value: Math.round((h.peak / G) * 100) / 100,
        unit: 'g',
        speedKmh: h.speed != null ? Math.round(h.speed * 3.6) : null,
        lat: this.fix?.lat,
        lon: this.fix?.lon,
        source: 'imu',
        ...h.extra,
      }),
    );
  }

  detectReverse(t, aLongRaw, dt, speed) {
    const r = this.rev;
    this.longBuf.push(t, aLongRaw);
    if (this.state.stationary) {
      if (r.active) this.finishReverse(t);
      r.bias = r.bias == null ? aLongRaw : r.bias + (aLongRaw - r.bias) * (1 - Math.exp(-dt / 1));
      r.quietTime += dt;
      r.armed = r.quietTime > 1;
      Object.assign(r, { v: 0, startT: null, decided: null, dist: 0 });
      return;
    }
    r.quietTime = 0;
    if (!r.armed) return;

    if (r.startT === null) {
      // Integrate from the last quiet moment, so the first push is not lost.
      r.startT = Math.min(this.lastQuietT ?? t, t);
      let prevT = r.startT;
      r.v = 0;
      for (const it of this.longBuf.items) {
        if (it.t <= r.startT) continue;
        r.v += (it.value - r.bias) * ((it.t - prevT) / 1000);
        prevT = it.t;
      }
    } else {
      r.v += (aLongRaw - r.bias) * dt;
    }
    r.dist += Math.abs(r.v) * dt;

    if (!r.decided) {
      if (r.v < -this.o.reverseSpeed) {
        r.decided = 'reverse';
        r.active = true;
        this.state.motion = 'reverse';
        this.onStatus({ type: 'reverse_start', t: r.startT });
      } else if (r.v > this.o.reverseSpeed) {
        r.decided = 'forward';
        r.armed = false;
        this.state.motion = 'forward';
      } else if (t - r.startT > 6000) {
        r.armed = false;
      }
    } else if (r.active) {
      if (speed != null && speed > this.o.reverseMaxGpsSpeed) {
        // Too fast for reversing: the forward axis was wrong, drop it.
        r.active = false;
        r.armed = false;
        this.state.motion = 'forward';
        this.onStatus({ type: 'reverse_cancel', t });
      } else if (r.v > 0.15 || t - r.startT > 90000) {
        this.finishReverse(t);
      }
    }
  }

  finishReverse(t) {
    const r = this.rev;
    r.active = false;
    r.armed = false;
    this.state.motion = this.state.stationary ? 'stopped' : 'forward';
    this.onStatus({ type: 'reverse_end', t });
    this.onManeuver({ type: 'reverse', tStart: r.startT, tEnd: t, distance: Math.round(r.dist * 10) / 10, source: 'imu' });
  }

  checkMount(t, speed) {
    const ref = this.cal.forwardUp;
    if (!ref || angleBetween(this.cal.up, ref) <= this.o.mountMovedDeg) {
      this.mountSince = null;
      return;
    }
    this.mountSince ??= t;
    if (t - this.mountSince < this.o.mountMovedHoldMs) return;
    this.mountSince = null;
    this.cal.resetMount();
    this.onStatus({ type: 'mount_moved', t });
    if (speed != null && speed > 3) {
      this.onEvent(
        makeEvent('phone_use', t, {
          speedKmh: Math.round(speed * 3.6),
          lat: this.fix?.lat,
          lon: this.fix?.lon,
          source: 'imu',
          detail: 'mount_moved',
        }),
      );
    }
  }
}
