// Microphone -> AudioWorklet -> turn-signal and siren detectors.
import { AudioAnalyzer } from '../../../shared/audio/analyzer.js';

export async function openMicrophone() {
  // Raw sound: echo cancellation and noise suppression would remove clicks and sirens.
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    video: false,
  });
}

/**
 * Starts analysing a microphone stream. handlers: onBlinker, onSiren, onSirenEnd,
 * blinkerTemplate. Returns { analyzer, stop, context }.
 */
export async function startAudioAnalysis(stream, handlers = {}) {
  const context = new AudioContext();
  await context.audioWorklet.addModule('/audio-capture.worklet.js');
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'capture');
  const analyzer = new AudioAnalyzer(context.sampleRate, handlers);
  const chunkMs = (1024 / context.sampleRate) * 1000;
  node.port.onmessage = (e) => analyzer.process(e.data, Date.now() - chunkMs);
  source.connect(node);
  // Keep the graph pulling samples without making any sound.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);
  if (context.state === 'suspended') await context.resume();
  return {
    analyzer,
    context,
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      context.close();
    },
  };
}
