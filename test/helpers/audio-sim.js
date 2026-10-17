// Synthetic cabin audio for tests: road noise, turn-signal clicks, sirens,
// engine hum, music- and speech-like distractors.

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

export function rms(x) {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

/** Low-frequency road rumble plus a little high-frequency hiss. */
export function roadNoise(n, { rumble = 0.05, hiss = 0.004, seed = 3 } = {}) {
  const rand = rng(seed);
  const out = new Float32Array(n);
  let b = 0;
  for (let i = 0; i < n; i++) {
    b = 0.995 * b + gaussian(rand);
    out[i] = b;
  }
  const k = rumble / rms(out);
  for (let i = 0; i < n; i++) out[i] = out[i] * k + hiss * gaussian(rand);
  return out;
}

/** Oscillator following freq(tSeconds) with the given harmonic amplitudes. */
export function tone(n, sr, freq, { amp = 0.1, harmonics = [1, 0, 0.33, 0, 0.2], gain = () => 1 } = {}) {
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * freq(t)) / sr;
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) if (harmonics[h]) v += harmonics[h] * Math.sin((h + 1) * phase);
    out[i] = amp * gain(t) * v;
  }
  return out;
}

const CLICKS = {
  relay: { freqs: [2400, 4700], tau: 0.0015, noise: 0.5, amp: 0.25 },
  tock: { freqs: [1900, 3900], tau: 0.0012, noise: 0.4, amp: 0.18 },
  hihat: { freqs: [], tau: 0.02, noise: 1, amp: 0.2, highpass: true },
};

/** Adds clicks of `kind` at the given times (seconds) into `out`. */
export function addClicks(out, sr, times, kind = 'relay', seed = 9) {
  const spec = CLICKS[kind];
  const rand = rng(seed);
  const len = Math.round(sr * Math.max(0.015, spec.tau * 6));
  for (const t of times) {
    const start = Math.round(t * sr);
    let prev = 0;
    for (let i = 0; i < len && start + i < out.length; i++) {
      const tt = i / sr;
      const env = Math.exp(-tt / spec.tau);
      let v = 0;
      for (const f of spec.freqs) v += Math.sin(2 * Math.PI * f * tt);
      let w = gaussian(rand);
      if (spec.highpass) {
        const hp = w - prev;
        prev = w;
        w = hp;
      }
      v += spec.noise * w;
      out[start + i] += spec.amp * env * v;
    }
  }
  return out;
}

/** Times of a turn signal running from `from` to `to` seconds. */
export function blinkerTimes(from, to, periodS, { tickTock = true, tockAt = 0.5 } = {}) {
  const ticks = [];
  const tocks = [];
  for (let t = from; t < to; t += periodS) {
    ticks.push(t);
    if (tickTock) tocks.push(t + periodS * tockAt);
  }
  return { ticks, tocks };
}

export const wail = (lo = 500, hi = 1400, periodS = 4) => (t) => (lo + hi) / 2 + ((hi - lo) / 2) * Math.sin((2 * Math.PI * t) / periodS);
export const yelp = (lo = 650, hi = 1550, rateHz = 4) => (t) => {
  const p = (t * rateHz) % 1;
  return lo + (hi - lo) * (p < 0.5 ? p * 2 : 2 - p * 2);
};
export const twoTone = (a, b, dwellS) => (t) => (Math.floor(t / dwellS) % 2 ? b : a);

/** Random notes of a scale, 250 ms each, with a soft attack: a music-like distractor. */
export function music(n, sr, seed = 5) {
  const rand = rng(seed);
  const notes = [392, 440, 494, 523, 587, 659, 698, 784, 880];
  const seq = Array.from({ length: Math.ceil(n / sr / 0.25) + 1 }, () => notes[Math.floor(rand() * notes.length)]);
  const chord = Array.from({ length: seq.length }, () => notes[Math.floor(rand() * notes.length)]);
  const a = tone(n, sr, (t) => seq[Math.floor(t / 0.25)], { amp: 0.08, harmonics: [1, 0.5, 0.25], gain: (t) => Math.min(1, ((t % 0.25) / 0.02)) });
  const b = tone(n, sr, (t) => chord[Math.floor(t / 0.25)] * 1.5, { amp: 0.05, harmonics: [1, 0.3] });
  for (let i = 0; i < n; i++) a[i] += b[i];
  return a;
}

/** Voiced speech-like sound: wobbling pitch, syllable-rate amplitude. */
export function speech(n, sr, seed = 11) {
  const rand = rng(seed);
  const syll = Array.from({ length: Math.ceil(n / sr / 0.18) + 1 }, () => 110 + rand() * 90);
  return tone(n, sr, (t) => syll[Math.floor(t / 0.18)] * (1 + 0.05 * Math.sin(2 * Math.PI * 5 * t)), {
    amp: 0.1,
    harmonics: [1, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15],
    gain: (t) => Math.max(0, Math.sin((Math.PI * (t % 0.18)) / 0.18)),
  });
}

export function mix(...signals) {
  const n = Math.max(...signals.map((s) => s.length));
  const out = new Float32Array(n);
  for (const s of signals) for (let i = 0; i < s.length; i++) out[i] += s[i];
  return out;
}

/** Feeds a signal to a detector in chunks like an AudioWorklet would. */
export function feedAudio(detector, signal, sr, t0 = 0, chunk = 1024) {
  for (let i = 0; i < signal.length; i += chunk) {
    detector.process(signal.subarray(i, Math.min(signal.length, i + chunk)), t0 + (i / sr) * 1000);
  }
}
