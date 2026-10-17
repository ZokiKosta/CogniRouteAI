// Spoken feedback while driving (the driver should never have to read the
// screen). Uses a Macedonian voice when the phone has one, otherwise the
// closest Slavic voice, and a beep for urgent warnings.
const PREFERRED = ['mk', 'sr', 'bg', 'hr', 'bs', 'sl', 'ru'];

export class Voice {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.lastSaid = {};
    this.voice = null;
    this.ctx = null;
    this.supported = typeof speechSynthesis !== 'undefined';
    if (this.supported) {
      this.pickVoice();
      speechSynthesis.addEventListener?.('voiceschanged', () => this.pickVoice());
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

  /** Must be called from a user gesture once (iOS) so later audio may play. */
  unlock() {
    try {
      this.ctx ??= new AudioContext();
      this.ctx.resume();
      if (this.supported) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
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

  /** key + cooldown keep the same warning from repeating every few seconds. */
  say(text, { key = text, cooldownMs = 20000, urgent = false } = {}) {
    const now = Date.now();
    if (!this.enabled || now - (this.lastSaid[key] ?? -Infinity) < cooldownMs) return false;
    this.lastSaid[key] = now;
    if (urgent) this.beep();
    if (!this.supported) return true;
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.voice?.lang ?? 'mk-MK';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    speechSynthesis.speak(u);
    return true;
  }
}
