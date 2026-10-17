// AudioWorklet: collects microphone samples into 1024-sample chunks and
// sends them to the main thread for the turn-signal and siren detectors.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(1024);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.chunk[this.filled++] = channel[i];
        if (this.filled === this.chunk.length) {
          this.port.postMessage(this.chunk, [this.chunk.buffer]);
          this.chunk = new Float32Array(1024);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
