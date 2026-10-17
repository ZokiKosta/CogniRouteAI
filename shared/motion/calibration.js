// Works out how the phone sits in the car: which way is up, forward and left in
// the phone's own coordinate system. Nothing is asked from the driver:
//  - "up" comes from gravity,
//  - "forward" starts as the direction the rear camera looks (-Z of the phone)
//    and is refined by correlating horizontal acceleration with GPS speed changes,
//  - the sign of lateral acceleration and of the gyroscope yaw (and the gyro's
//    unit, which differs between some browsers) are checked against GPS course
//    changes in turns.
import { DEG, Ema3, cross, dot, norm, normalize, reject, scale, add } from '../math.js';

const PRIOR_FORWARD = [0, 0, -1];
const YAW_GAIN_CANDIDATES = [1, 1 / DEG, DEG]; // correct, deg/s reported as rad/s, and the reverse

export class MountCalibration {
  constructor() {
    this.upFilter = new Ema3(0.4);
    this.up = [0, 0, 1];
    this.hasUp = false;
    this.forward = null; // learned horizontal forward axis (device frame)
    this.forwardUp = null; // gravity direction at the time forward was learned
    this.latSign = 1;
    this.yawGain = 1;
    this.resetLearning();
    this.resetInterval();
  }

  resetLearning() {
    this.fwdSum = [0, 0, 0];
    this.fwdWeight = 0;
    this.fwdSamples = 0;
    this.latEvidence = 0;
    this.latWeight = 0;
    this.latSamples = 0;
    this.yawNum = 0;
    this.yawDen = 0;
    this.yawSamples = 0;
  }

  /** Forget the learned forward axis, e.g. after the phone moved in its holder. */
  resetMount() {
    this.forward = null;
    this.forwardUp = null;
    this.latSign = 1;
    this.resetLearning();
  }

  resetInterval() {
    this.interval = { h: [0, 0, 0], lat: 0, yaw: 0, dt: 0 };
  }

  updateGravity(gravity, dt) {
    this.up = normalize(this.upFilter.update(gravity, dt));
    this.hasUp = true;
  }

  get forwardSource() {
    return this.forward ? 'learned' : 'prior';
  }

  forwardAxis() {
    let f = normalize(reject(this.forward ?? PRIOR_FORWARD, this.up));
    if (norm(f) < 0.5) f = normalize(reject([0, 1, 0], this.up)); // phone lying flat
    return f;
  }

  leftAxis() {
    return normalize(cross(this.up, this.forwardAxis()));
  }

  /** Vehicle-frame acceleration (m/s²): long > 0 speeding up, lat > 0 pushed to the left. */
  toVehicle(lin) {
    const h = reject(lin, this.up);
    return {
      long: dot(h, this.forwardAxis()),
      lat: dot(h, this.leftAxis()) * this.latSign,
      vert: dot(lin, this.up),
    };
  }

  /** Yaw rate in rad/s, positive when turning left. */
  yawRate(gyro) {
    return dot(gyro, this.up) * this.yawGain;
  }

  /** Called for every motion sample; averaged over the time until the next GPS fix. */
  accumulate(lin, gyro, dt) {
    const h = reject(lin, this.up);
    const it = this.interval;
    it.h = add(it.h, scale(h, dt));
    it.lat += dot(h, this.leftAxis()) * dt;
    it.yaw += (gyro ? dot(gyro, this.up) : 0) * dt;
    it.dt += dt;
  }

  /**
   * Called on every GPS fix with the speed change and course change since the
   * previous fix. Uses the motion samples accumulated in between.
   */
  learnFromGps({ speed, dvdt, courseRate }) {
    const it = this.interval;
    this.resetInterval();
    if (it.dt < 0.3 || speed == null) return;
    const meanH = scale(it.h, 1 / it.dt);
    const meanLat = it.lat / it.dt;
    const meanYaw = it.yaw / it.dt;

    if (speed > 2.5 && dvdt != null && Math.abs(dvdt) > 0.4 && Math.abs(dvdt) < 6) {
      this.fwdSum = add(this.fwdSum, scale(meanH, dvdt));
      this.fwdWeight += Math.abs(dvdt) * norm(meanH);
      this.fwdSamples++;
      const coherence = norm(this.fwdSum) / this.fwdWeight;
      if (this.fwdSamples >= 6 && coherence > 0.55) {
        this.forward = normalize(reject(this.fwdSum, this.up));
        this.forwardUp = [...this.up];
      }
    }

    if (speed > 3 && courseRate != null && Math.abs(courseRate) > 3) {
      const omega = -courseRate * DEG; // GPS course grows clockwise (right turn); yaw is left-positive
      const latExpected = speed * omega;
      this.latEvidence += meanLat * latExpected;
      this.latWeight += Math.abs(meanLat * latExpected);
      this.latSamples++;
      if (this.latSamples >= 4 && Math.abs(this.latEvidence) / this.latWeight > 0.5) {
        this.latSign = Math.sign(this.latEvidence);
      }

      this.yawNum += meanYaw * omega;
      this.yawDen += meanYaw * meanYaw;
      this.yawSamples++;
      if (this.yawSamples >= 4 && this.yawDen > 1e-9) this.yawGain = snapYawGain(this.yawNum / this.yawDen, this.yawGain);
    }
  }

  get status() {
    return {
      up: this.hasUp,
      forward: this.forwardSource,
      latSign: this.latSign,
      yawGain: this.yawGain,
      samples: this.fwdSamples,
    };
  }
}

/** Snaps a measured gain to the nearest plausible unit conversion, keeping its sign. */
function snapYawGain(slope, previous) {
  const magnitude = Math.abs(slope);
  if (!Number.isFinite(magnitude) || magnitude === 0) return previous;
  let best = YAW_GAIN_CANDIDATES[0];
  for (const c of YAW_GAIN_CANDIDATES) {
    if (Math.abs(Math.log(magnitude / c)) < Math.abs(Math.log(magnitude / best))) best = c;
  }
  if (Math.abs(Math.log(magnitude / best)) > Math.log(3)) return previous;
  return Math.sign(slope) * best;
}
