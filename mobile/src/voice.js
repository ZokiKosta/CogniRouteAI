// Spoken feedback while driving (the driver should never have to read the
// screen). In order of preference:
//   1. pre-recorded Macedonian clips in /voice/mk/ (made with an Azure
//      Macedonian neural voice via `npm run voice`),
//   2. a Macedonian system voice, if the phone has one,
//   3. the closest Slavic system voice,
// plus a beep for urgent warnings.
const PREFERRED = ['mk', 'sr', 'bg', 'hr', 'bs', 'sl', 'ru'];

export class Voice {
  constructor({ enabled = true, clipsUrl = '/voice/mk/manifest.json' } = {}) {
    this.enabled = enabled;
    this.lastSaid = {};
    this.voice = null;
    this.ctx = null;
    this.clips = null; // { key: HTMLAudioElement }
    this.playing = null;
    this.supported = typeof speechSynthesis !== 'undefined';
    if (this.supported) {
      this.pickVoice();
      speechSynthesis.addEventListener?.('voiceschanged', () => this.pickVoice());
    }
    this.loadClips(clipsUrl);
  }

  async loadClips(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const manifest = await res.json();
      this.clips = {};
      const base = url.replace(/manifest\.json$/, '');
      for (const [key, info] of Object.entries(manifest.phrases ?? {})) {
        const audio = new Audio(base + info.file);
        audio.preload = 'auto';
        this.clips[key] = audio;
      }
    } catch {
      this.clips = null; // fall back to the system voice
    }
  }

  pickVoice() {
    const voices = speechSynthesis.getVoices();
    for (const lang of PREFERRED) {
      const v = voices.find((x) => x.lang?.toLowerCase().startsWith(lang));
      if (v) {
        this.voice = v;
        return;
      }
    }
    this.voice = null;
  }

  get usingRecorded() {
    return !!this.clips && Object.keys(this.clips).length > 0;
  }

  /** Must be called from a user gesture once (iOS) so later audio may play. */
  unlock() {
    try {
      this.ctx ??= new AudioContext();
      this.ctx.resume();
      if (this.supported) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
      // Prime one recorded clip so iOS allows later playback without a tap.
      const first = this.clips && Object.values(this.clips)[0];
      if (first) first.play().then(() => (first.pause(), (first.currentTime = 0))).catch(() => {});
    } catch {
      // no audio output available
    }
  }

  beep({ freq = 880, ms = 180, times = 2 } = {}) {
    if (!this.enabled) return;
    try {
      this.ctx ??= new AudioContext();
      const now = this.ctx.currentTime;
      for (let i = 0; i < times; i++) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.25);
        gain.gain.exponentialRampToValueAtTime(0.4, now + i * 0.25 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.25 + ms / 1000);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(now + i * 0.25);
        osc.stop(now + i * 0.25 + ms / 1000 + 0.05);
      }
    } catch {
      // ignore
    }
  }

  /**
   * key + cooldown keep the same warning from repeating every few seconds.
   * When a recorded clip exists for `key`, it is played; otherwise the system
   * voice reads `text`.
   */
  say(text, { key = text, cooldownMs = 20000, urgent = false } = {}) {
    const now = Date.now();
    if (!this.enabled || now - (this.lastSaid[key] ?? -Infinity) < cooldownMs) return false;
    this.lastSaid[key] = now;
    if (urgent) this.beep();

    const clip = this.clips?.[key];
    if (clip) {
      if (urgent && this.playing && this.playing !== clip) {
        this.playing.pause();
        this.playing.currentTime = 0;
      }
      clip.currentTime = 0;
      this.playing = clip;
      clip.play().catch(() => this.speak(text, urgent));
      return true;
    }
    this.speak(text, urgent);
    return true;
  }

  speak(text, urgent) {
    if (!this.supported) return;
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.voice?.lang ?? 'mk-MK';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }
}
