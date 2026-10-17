// Emergency-vehicle siren detector (ambulance, police, fire brigade).
// A siren is a loud, strongly tonal sound whose pitch either sweeps smoothly
// up and down ("wail", "yelp") or alternates between two fixed tones
// ("hi-lo" / "ta-tü-ta-ta"). Road noise and speech are not tonal enough;
// a single beep has no pitch movement; music rarely sweeps or strictly
// alternates between two notes.
import { FFT, toDb } from './dsp.js';
import { median } from '../math.js';

const DEFAULTS = {
  fftSize: 1024,
  hopSize: 512,
  fMin: 400,
  fMax: 1800,
  tonalDb: 14,
  windowMs: 3000,
  minTonalRatio: 0.55,
  sweepMinRange: 150,
  twoToneRatio: [1.12, 1.65],
  activateAfter: 2,
  releaseMs: 2500,
  analyzeEveryMs: 200,
};

export class SirenDetector {
  constructor(sampleRate, { onSiren = () => {}, onEnd = () => {}, options = {} } = {}) {
    this.sr = sampleRate;
    this.o = { ...DEFAULTS, ...options };
    this.onSiren = onSiren;
    this.onEnd = onEnd;
    this.fft = new FFT(this.o.fftSize);
    this.ring = new Float32Array(this.o.fftSize);
    this.frame = new Float32Array(this.o.fftSize);
    this.pos = 0;
    this.filled = 0;
    this.sinceHop = 0;
    this.frames = [];
    this.lastAnalysis = -Infinity;
    this.positives = 0;
    this.active = null;
    this.lastPositiveT = null;
    this.hopMs = (this.o.hopSize / sampleRate) * 1000;
  }

  get isActive() {
    return !!this.active;
  }

  process(samples, t0) {
    const { fftSize, hopSize } = this.o;
    const msPerSample = 1000 / this.sr;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.pos] = samples[i];
      this.pos = (this.pos + 1) % fftSize;
      if (this.filled < fftSize) this.filled++;
      if (++this.sinceHop >= hopSize && this.filled === fftSize) {
        this.sinceHop = 0;
        for (let k = 0; k < fftSize; k++) this.frame[k] = this.ring[(this.pos + k) % fftSize];
        this.analyzeFrame(t0 + i * msPerSample);
      }
    }
  }

  analyzeFrame(t) {
    const o = this.o;
    const mags = this.fft.magnitudes(this.frame);
    const binHz = this.sr / o.fftSize;
    const lo = Math.ceil(o.fMin / binHz);
    const hi = Math.floor(o.fMax / binHz);
    // Prominence over a per-bin noise floor that follows the steady road
    // noise but ignores strong peaks, so neither the low-frequency rumble nor
    // random noise spikes win the peak search.
    const nf = (this.noiseFloor ??= Float64Array.from(mags, (m) => m || 1e-6));
    for (let i = 0; i < mags.length; i++) {
      const m = mags[i] || 1e-9;
      if (m < nf[i]) nf[i] += (m - nf[i]) * 0.2;
      else if (m < nf[i] * 3) nf[i] += (m - nf[i]) * 0.02;
    }
    const prominence = (i) => mags[i] / Math.max(nf[i], localFloor(nf, i, 3), 1e-12);
    let k = lo;
    let best = prominence(lo);
    for (let i = lo + 1; i <= hi; i++) {
      const p = prominence(i);
      if (p > best) {
        best = p;
        k = i;
      }
    }
    // Prefer the fundamental when the strongest peak is a harmonic.
    for (const div of [3, 2]) {
      let sub = Math.round(k / div);
      if (sub < lo) continue;
      if (mags[sub - 1] > mags[sub]) sub--;
      else if (mags[sub + 1] > mags[sub]) sub++;
      const isPeak = mags[sub] >= mags[sub - 1] && mags[sub] >= mags[sub + 1];
      if (isPeak && mags[sub] > mags[k] * 0.5 && 2 * toDb(prominence(sub)) >= o.tonalDb) {
        k = sub;
        break;
      }
    }
    const a = mags[k - 1];
    const b = mags[k];
    const c = mags[k + 1];
    const delta = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
    // Voices (and chords) have several strong partials close together; a
    // siren's partials are at least ~400 Hz apart.
    let neighbours = 0;
    const span = Math.round(350 / binHz);
    for (let i = Math.max(1, k - span); i <= Math.min(mags.length - 2, k + span); i++) {
      if (Math.abs(i - k) <= 2 || mags[i] < mags[i - 1] || mags[i] < mags[i + 1]) continue;
      if (mags[i] > b * 0.3 && 2 * toDb(prominence(i)) >= o.tonalDb) neighbours++;
    }
    const tonal = neighbours >= 2 ? 0 : 2 * toDb(prominence(k));
    this.frames.push({ t, f: (k + delta) * binHz, tonal, level: 2 * toDb(b) });
    while (this.frames.length && this.frames[0].t < t - o.windowMs) this.frames.shift();
    if (t - this.lastAnalysis >= o.analyzeEveryMs) {
      this.lastAnalysis = t;
      this.analyze(t);
    }
  }

  analyze(now) {
    const result = this.classify();
    if (result) {
      this.positives++;
      this.lastPositiveT = now;
      if (!this.active && this.positives >= this.o.activateAfter) {
        this.active = { start: now, type: result.type };
        this.onSiren({ t: now, ...result });
      } else if (this.active) {
        Object.assign(this.active, { type: result.type, approaching: result.approaching });
      }
    } else {
      this.positives = 0;
      if (this.active && now - this.lastPositiveT > this.o.releaseMs) {
        const ended = this.active;
        this.active = null;
        this.onEnd({ t: now, start: ended.start, type: ended.type });
      }
    }
  }

  /** Returns { type, confidence, approaching } for the current window, or null. */
  classify() {
    const o = this.o;
    const frames = this.frames;
    const expected = o.windowMs / this.hopMs;
    if (frames.length < expected * 0.8) return null;
    const tonal = smoothPitch(frames.filter((f) => f.tonal >= o.tonalDb));
    const ratio = tonal.length / frames.length;
    if (ratio < o.minTonalRatio) return null;

    const fs = tonal.map((f) => f.f).sort((x, y) => x - y);
    const p10 = fs[Math.floor(fs.length * 0.1)];
    const p90 = fs[Math.floor(fs.length * 0.9)];
    const range = p90 - p10;
    if (range < 60) return null; // a steady beep or hum

    // Pitch movement over runs of consecutive tonal frames.
    const jumps = [];
    const predictionErrors = [];
    let moving = 0;
    let triples = 0;
    for (let i = 2; i < tonal.length; i++) {
      const [x0, x1, x2] = [tonal[i - 2], tonal[i - 1], tonal[i]];
      if (x2.t - x0.t > this.hopMs * 2.6) continue;
      jumps.push(Math.abs(x2.f - x1.f));
      predictionErrors.push(Math.abs(x2.f - (2 * x1.f - x0.f)));
      triples++;
      if (Math.abs(x2.f - x0.f) > 6) moving++;
    }
    const bigJumps = jumps.filter((j) => j > range * 0.35).length / Math.max(1, jumps.length);
    const smooth = median(predictionErrors) < range * 0.1;
    const movingFrac = moving / Math.max(1, triples);

    const levels = tonal.map((f) => f.level);
    const half = Math.floor(levels.length / 2);
    const trend = mean(levels.slice(half)) - mean(levels.slice(0, half));
    const approaching = trend > 2 ? true : trend < -2 ? false : null;
    const confidence = Math.round(Math.min(1, (ratio - o.minTonalRatio) / (1 - o.minTonalRatio) * 0.5 + 0.5) * 100) / 100;

    const twoTone = this.twoTone(tonal);
    if (twoTone) return { type: 'two_tone', confidence, approaching, tones: twoTone };

    if (range >= o.sweepMinRange && smooth && movingFrac > 0.6 && bigJumps < 0.12) {
      const cycleMs = estimateCycle(tonal, range);
      return { type: cycleMs != null && cycleMs < 1000 ? 'yelp' : 'wail', confidence, approaching };
    }
    return null;
  }

  twoTone(tonal) {
    const fs = tonal.map((f) => f.f);
    const sorted = [...fs].sort((x, y) => x - y);
    let lo = sorted[Math.floor(sorted.length * 0.1)];
    let hi = sorted[Math.floor(sorted.length * 0.9)];
    let labels = [];
    for (let iter = 0; iter < 6; iter++) {
      labels = fs.map((f) => (Math.abs(f - lo) < Math.abs(f - hi) ? 0 : 1));
      const l = fs.filter((_, i) => labels[i] === 0);
      const h = fs.filter((_, i) => labels[i] === 1);
      if (!l.length || !h.length) return null;
      lo = mean(l);
      hi = mean(h);
    }
    const ratio = hi / lo;
    if (ratio < this.o.twoToneRatio[0] || ratio > this.o.twoToneRatio[1]) return null;
    const share = labels.filter((x) => x === 0).length / labels.length;
    if (share < 0.25 || share > 0.75) return null;
    const spread = (center, idx) => mean(fs.filter((_, i) => labels[i] === idx).map((f) => Math.abs(f - center))) / center;
    if (spread(lo, 0) > 0.03 || spread(hi, 1) > 0.03) return null;
    let switches = 0;
    for (let i = 1; i < labels.length; i++) if (labels[i] !== labels[i - 1]) switches++;
    if (switches < 2) return null;
    const dwellMs = (tonal[tonal.length - 1].t - tonal[0].t) / (switches + 1);
    if (dwellMs < 150 || dwellMs > 1500) return null;
    return [Math.round(lo), Math.round(hi)];
  }
}

/** Median of the bins within ±radius of i, skipping the peak and its direct neighbours. */
function localFloor(mags, i, radius) {
  const values = [];
  for (let j = i - radius; j <= i + radius; j++) {
    if (j >= 0 && j < mags.length && Math.abs(j - i) > 1) values.push(mags[j]);
  }
  return median(values);
}

/** 5-point median filter over the pitch track: drops single-frame octave errors. */
function smoothPitch(track) {
  return track.map((x, i) => ({ ...x, f: median(track.slice(Math.max(0, i - 2), i + 3).map((y) => y.f)) }));
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * Rough period of the pitch movement (ms) from direction reversals; a reversal
 * only counts once the pitch has moved back by a third of the range, so jitter
 * at the top and bottom of a slow wail is ignored.
 */
function estimateCycle(tonal, range) {
  const turns = [];
  const step = range / 3;
  let dir = 0;
  let extreme = tonal[0].f;
  for (const x of tonal) {
    if (dir === 0) {
      if (Math.abs(x.f - tonal[0].f) > step) {
        dir = Math.sign(x.f - tonal[0].f);
        extreme = x.f;
      }
    } else if (dir * (x.f - extreme) > 0) {
      extreme = x.f;
    } else if (Math.abs(x.f - extreme) > step) {
      turns.push(x.t);
      dir = -dir;
      extreme = x.f;
    }
  }
  if (turns.length < 2) return null;
  return ((turns[turns.length - 1] - turns[0]) / (turns.length - 1)) * 2;
}
