// Turn-signal ("жмигавец") detector: finds the short relay/electronic clicks in
// the cabin sound and checks that they repeat on a steady rhythm (60-120
// flashes per minute, "tick-tock" counted as two clicks).
// Optional calibration records the car's own click sound and rhythm, which
// makes it much harder for music to be mistaken for the indicator.
import { Biquad, FFT, toDb } from './dsp.js';

const DEFAULTS = {
  hpFreq: 1500,
  hopMs: 5,
  onsetDb: 8,
  sharpDb: 8,
  refractoryMs: 90,
  bgTauMs: 400,
  minPeriodMs: 280,
  maxPeriodMs: 1100,
  windowMs: 4500,
  minHits: 5,
  jitterMs: 30,
  minCoverage: 0.7,
  maxOffGrid: 0.3,
  templateMinCorr: 0.5,
  templatePeriodTolerance: 0.12,
};

const FEATURE_FFT = 512;
const BAND_EDGES = [600, 1000, 1600, 2500, 3800, 5500, 7500, 9500, 12000];

export class BlinkerDetector {
  constructor(sampleRate, { onChange = () => {}, template = null, options = {} } = {}) {
    this.sr = sampleRate;
    this.o = { ...DEFAULTS, ...options };
    this.onChange = onChange;
    this.template = template;
    this.hp = new Biquad('highpass', this.o.hpFreq, sampleRate);
    this.hop = Math.max(1, Math.round((sampleRate * this.o.hopMs) / 1000));
    this.ring = new Float32Array(FEATURE_FFT);
    this.ringPos = 0;
    this.fft = new FFT(FEATURE_FFT);
    this.acc = 0;
    this.n = 0;
    this.bg = null;
    this.lastOnsetT = -Infinity;
    this.pending = null;
    this.onsets = [];
    this.lastAnalysis = -Infinity;
    this.isOn = false;
    this.periodMs = null;
    this.lastHitT = null;
    this.calibrating = null;
  }

  get on() {
    return this.isOn;
  }

  /** Feeds mono samples; t0 is the time (ms) of samples[0]. */
  process(samples, t0) {
    const msPerSample = 1000 / this.sr;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      this.ring[this.ringPos] = x;
      this.ringPos = (this.ringPos + 1) % FEATURE_FFT;
      const y = this.hp.process(x);
      this.acc += y * y;
      if (++this.n < this.hop) continue;
      this.frame(t0 + i * msPerSample, this.acc / this.n);
      this.acc = 0;
      this.n = 0;
    }
  }

  frame(t, energy) {
    const level = toDb(energy);
    if (this.bg === null) this.bg = level;
    const p = this.pending;
    if (p) {
      p.hops++;
      if (p.hops <= 3) p.peak = Math.max(p.peak, level);
      if (p.hops === 1) p.bands = this.features();
      if (p.hops === 7) {
        // A click is over within ~30 ms; syllables and notes are still sounding.
        if (p.peak - level >= this.o.sharpDb) this.onsets.push({ t: p.t, strength: p.strength, bands: p.bands });
        this.pending = null;
      }
    }
    const rise = level - this.bg;
    if (rise > this.o.onsetDb && t - this.lastOnsetT > this.o.refractoryMs && !this.pending) {
      this.lastOnsetT = t;
      this.pending = { t, strength: rise, hops: 0, peak: level, bands: null };
    }
    // The background follows quieter frames quickly and loud ones slowly.
    const tau = rise > 3 ? this.o.bgTauMs * 8 : this.o.bgTauMs;
    this.bg += (level - this.bg) * (1 - Math.exp(-this.o.hopMs / tau));

    while (this.onsets.length && this.onsets[0].t < t - this.o.windowMs * 2) this.onsets.shift();
    if (t - this.lastAnalysis >= 100) {
      this.lastAnalysis = t;
      this.analyze(t);
    }
  }

  /** Normalized log band energies of the most recent click (spectral "fingerprint"). */
  features() {
    const frame = new Float32Array(FEATURE_FFT);
    for (let i = 0; i < FEATURE_FFT; i++) frame[i] = this.ring[(this.ringPos + i) % FEATURE_FFT];
    const mags = this.fft.magnitudes(frame);
    const binHz = this.sr / FEATURE_FFT;
    const bands = [];
    for (let b = 0; b + 1 < BAND_EDGES.length; b++) {
      const lo = Math.floor(BAND_EDGES[b] / binHz);
      const hi = Math.min(mags.length - 1, Math.ceil(BAND_EDGES[b + 1] / binHz));
      let e = 0;
      for (let k = lo; k < hi; k++) e += mags[k] * mags[k];
      bands.push(toDb(e + 1e-12));
    }
    const m = bands.reduce((a, b) => a + b, 0) / bands.length;
    return bands.map((v) => v - m);
  }

  matchesTemplate(onset) {
    if (!this.template) return true;
    return correlation(onset.bands, this.template.bands) >= this.o.templateMinCorr;
  }

  periodMatchesTemplate(p) {
    if (!this.template?.periodMs) return true;
    const tol = this.o.templatePeriodTolerance;
    return [0.5, 1, 2].some((k) => Math.abs(p / (this.template.periodMs * k) - 1) < tol);
  }

  analyze(now) {
    const o = this.o;
    const onsets = this.onsets.filter((x) => x.t > now - o.windowMs && this.matchesTemplate(x));
    let best = onsets.length >= o.minHits ? this.bestGrid(onsets) : null;
    if (best && now - best.lastHit > Math.max(1200, 1.8 * best.period)) best = null; // clicks stopped

    if (best) {
      this.periodMs = best.period;
      this.lastHitT = best.lastHit;
      if (this.calibrating) this.calibrating.sequences.push(best);
      if (!this.isOn) {
        this.isOn = true;
        this.onChange({ on: true, t: best.firstHit, periodMs: Math.round(best.period) });
      }
    } else if (this.isOn) {
      const quietFor = now - (this.lastHitT ?? now);
      if (quietFor > Math.max(1200, 1.8 * (this.periodMs ?? 700))) {
        this.isOn = false;
        this.onChange({ on: false, t: this.lastHitT ?? now });
      }
    }
  }

  /** Finds a steady click rhythm that explains most recent onsets. */
  bestGrid(onsets) {
    const o = this.o;
    const candidates = [];
    for (let i = 0; i < onsets.length; i++) {
      for (let j = i + 1; j <= i + 2 && j < onsets.length; j++) {
        const d = onsets[j].t - onsets[i].t;
        if (d >= o.minPeriodMs && d <= o.maxPeriodMs && !candidates.some((c) => Math.abs(c - d) < 10)) candidates.push(d);
      }
    }
    const anchor = onsets[onsets.length - 1].t;
    let best = null;
    for (const period of candidates) {
      if (!this.periodMatchesTemplate(period)) continue;
      const main = [];
      const rest = [];
      for (const x of onsets) (phaseDistance(anchor - x.t, period) < o.jitterMs ? main : rest).push(x);
      // A second click per cycle ("tock") at a fixed offset also counts.
      let tock = [];
      if (rest.length >= 2) {
        const ref = rest[rest.length - 1].t;
        const offset = (((anchor - ref) % period) + period) % period / period;
        if (offset > 0.25 && offset < 0.75) tock = rest.filter((x) => phaseDistance(ref - x.t, period) < o.jitterMs);
      }
      if (main.length < 3) continue;
      const span = anchor - main[0].t;
      const expected = Math.floor(span / period + 0.5) + 1;
      const coverage = main.length / expected;
      const explained = main.length + (tock.length >= 2 ? tock.length : 0);
      const offGrid = 1 - explained / onsets.length;
      if (explained < o.minHits || coverage < o.minCoverage || offGrid > o.maxOffGrid) continue;
      const score = explained + coverage;
      if (!best || score > best.score) {
        best = { period, score, firstHit: main[0].t, lastHit: anchor, hits: main.concat(tock.length >= 2 ? tock : []) };
      }
    }
    return best;
  }

  startCalibration() {
    this.calibrating = { sequences: [] };
  }

  /** Returns a template { bands, periodMs } from the clicks heard since startCalibration(), or null. */
  finishCalibration() {
    const cal = this.calibrating;
    this.calibrating = null;
    if (!cal?.sequences.length) return null;
    const last = cal.sequences[cal.sequences.length - 1];
    const bands = last.hits[0].bands.map((_, k) => last.hits.reduce((s, h) => s + h.bands[k], 0) / last.hits.length);
    return { bands: bands.map((v) => Math.round(v * 100) / 100), periodMs: Math.round(last.period) };
  }
}

function phaseDistance(dt, period) {
  const r = ((dt % period) + period) % period;
  return Math.min(r, period - r);
}

export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
