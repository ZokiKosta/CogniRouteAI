// One entry point for the microphone: feeds the same samples to the turn
// signal and siren detectors and keeps a simple sound level for the HUD.
import { BlinkerDetector } from './blinker.js';
import { SirenDetector } from './siren.js';

export class AudioAnalyzer {
  constructor(sampleRate, { onBlinker = () => {}, onSiren = () => {}, onSirenEnd = () => {}, blinkerTemplate = null } = {}) {
    this.sampleRate = sampleRate;
    this.blinker = new BlinkerDetector(sampleRate, { onChange: onBlinker, template: blinkerTemplate });
    this.siren = new SirenDetector(sampleRate, { onSiren, onEnd: onSirenEnd });
    this.level = -100;
  }

  /** samples: Float32Array of mono audio; t0: time of samples[0] in ms. */
  process(samples, t0) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    this.level = 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-12);
    this.blinker.process(samples, t0);
    this.siren.process(samples, t0);
  }
}
