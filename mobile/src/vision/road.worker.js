// Web Worker: YOLOv8 (onnxruntime-web, WebGPU or WebAssembly) and lane-line
// detection on frames from the road camera, off the main thread.
import * as ort from 'onnxruntime-web';
import { LaneDetector } from '../../../shared/vision/lanes.js';
import { ROAD_CLASSES, decodeYolo, decodeYoloSeg, segmentsToLines, toTensor } from '../../../shared/vision/yolo.js';

const lanes = new LaneDetector();
const keep = new Set(Object.keys(ROAD_CLASSES));
let session = null;
let meta = null;
let laneSession = null; // optional YOLOv8-seg lane model (ml/train_lane_lines.py)
let laneMeta = null;
let laneLines = null;
let frameCount = 0;
let confThreshold = 0.35;

async function init(msg) {
  ort.env.wasm.wasmPaths = msg.wasmPath;
  meta = await (await fetch(msg.metaUrl)).json();
  lanes.configure(msg.lanes ?? {});
  let backend = 'wasm';
  if (msg.webgpu && 'gpu' in navigator) {
    try {
      session = await ort.InferenceSession.create(msg.modelUrl, { executionProviders: ['webgpu'] });
      backend = 'webgpu';
    } catch {
      session = null;
    }
  }
  session ??= await ort.InferenceSession.create(msg.modelUrl, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  try {
    const res = await fetch(msg.laneMetaUrl);
    const candidate = res.ok ? await res.json() : null;
    if (candidate?.task === 'segment') {
      laneSession = await ort.InferenceSession.create(msg.laneModelUrl, { executionProviders: [backend] });
      laneMeta = candidate;
    }
  } catch {
    laneSession = null; // no trained lane model: use the built-in line detector
  }
  return { backend, threads: ort.env.wasm.numThreads, isolated: self.crossOriginIsolated, laneModel: !!laneSession };
}

async function detect({ width, height, buffer }) {
  const rgba = new Uint8ClampedArray(buffer);
  const t0 = performance.now();
  // Luminance, with yellow markings lifted: they are bright in red+green but
  // not in blue, and would otherwise barely stand out from light concrete.
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const r = rgba[j];
    const g = rgba[j + 1];
    const b = rgba[j + 2];
    const yellow = Math.max(0, (r + g) / 2 - b - 40);
    gray[i] = Math.min(255, ((r * 77 + g * 150 + b * 29) >> 8) + yellow * 0.6);
  }
  const inW = Math.ceil(width / 32) * 32;
  const inH = Math.ceil(height / 32) * 32;
  const { data, letterbox } = toTensor(rgba, width, height, inW, inH);
  const input = new ort.Tensor('float32', data, [1, 3, inH, inW]);
  let laneResult;
  if (laneSession) {
    // The lane model runs every other frame; lines move slowly.
    if (frameCount++ % 2 === 0 || !laneLines) {
      const out = await laneSession.run({ [laneSession.inputNames[0]]: input });
      const [o0, o1] = laneSession.outputNames.map((n) => out[n]);
      const dets = decodeYoloSeg(o0.data, o0.dims, o1.data, o1.dims, { classes: laneMeta.classes, letterbox, confThreshold: 0.3 });
      laneLines = segmentsToLines(dets, width, height, lanes.o);
    }
    laneResult = { lines: laneLines, source: 'yolo' };
  } else {
    laneResult = { ...lanes.detect(gray, width, height), source: 'cv' };
  }
  const t1 = performance.now();
  let detections = [];
  if (session) {
    const output = await session.run({ [session.inputNames[0]]: input });
    const o = output[session.outputNames[0]];
    detections = decodeYolo(o.data, o.dims, { classes: meta.classes, letterbox, keep, confThreshold });
  }
  return { detections, lanes: laneResult, laneMs: t1 - t0, inferMs: performance.now() - t1 };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') self.postMessage({ type: 'ready', ...(await init(msg)) });
    else if (msg.type === 'config') {
      if (msg.lanes) lanes.configure(msg.lanes);
      if (msg.confThreshold) confThreshold = msg.confThreshold;
    } else if (msg.type === 'frame') {
      self.postMessage({ type: 'result', id: msg.id, t: msg.t, width: msg.width, height: msg.height, ...(await detect(msg)) });
    }
  } catch (err) {
    self.postMessage({ type: msg.type === 'init' ? 'error' : 'frame-error', id: msg.id, message: String(err?.message ?? err) });
  }
};
