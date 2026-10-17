// YOLOv8 pre- and post-processing for onnxruntime (browser or Node).
// Model output is [1, 4 + classes, anchors]: box centre/size in input pixels
// followed by per-class scores (already sigmoid-activated).

/** Classes the road camera cares about, with Macedonian labels. */
export const ROAD_CLASSES = {
  person: 'пешак',
  bicycle: 'велосипед',
  car: 'автомобил',
  motorcycle: 'мотоцикл',
  bus: 'автобус',
  truck: 'камион',
  'traffic light': 'семафор',
  'stop sign': 'STOP знак',
  dog: 'куче',
  horse: 'коњ',
  sheep: 'овца',
  cow: 'крава',
};

export const VEHICLE_CLASSES = new Set(['car', 'bus', 'truck', 'motorcycle']);
export const VULNERABLE_CLASSES = new Set(['person', 'bicycle', 'dog', 'horse', 'sheep', 'cow']);

/** Where a srcW x srcH frame lands inside a dstW x dstH model input (keeping aspect ratio). */
export function letterbox(srcW, srcH, dstW, dstH) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);
  return { scale, newW, newH, padX: Math.floor((dstW - newW) / 2), padY: Math.floor((dstH - newH) / 2), dstW, dstH, srcW, srcH };
}

/**
 * RGBA pixels (srcW x srcH) -> Float32 CHW tensor data in [0, 1], letterboxed
 * with gray (114) padding. Nearest-neighbour resize; feed a frame already
 * scaled close to the model size for best quality.
 */
export function toTensor(rgba, srcW, srcH, dstW, dstH) {
  const lb = letterbox(srcW, srcH, dstW, dstH);
  const plane = dstW * dstH;
  const data = new Float32Array(plane * 3).fill(114 / 255);
  for (let y = 0; y < lb.newH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(y / lb.scale));
    for (let x = 0; x < lb.newW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x / lb.scale));
      const s = (sy * srcW + sx) * 4;
      const d = (y + lb.padY) * dstW + x + lb.padX;
      data[d] = rgba[s] / 255;
      data[d + plane] = rgba[s + 1] / 255;
      data[d + 2 * plane] = rgba[s + 2] / 255;
    }
  }
  return { data, letterbox: lb };
}

/**
 * Decodes raw YOLOv8 output into detections in source-frame pixels.
 * `classes` is the model's class-name list; `keep` limits which names are returned.
 */
export function decodeYolo(output, dims, { classes, letterbox: lb, confThreshold = 0.35, iouThreshold = 0.45, keep = null, maxDetections = 50 }) {
  const [, channels, anchors] = dims;
  const numClasses = classes.length;
  if (channels < 4 + numClasses) throw new Error(`unexpected output shape ${dims}`);
  const keepIdx = keep ? new Set(classes.map((c, i) => (keep.has(c) ? i : -1)).filter((i) => i >= 0)) : null;
  const found = [];
  for (let i = 0; i < anchors; i++) {
    let best = -1;
    let score = confThreshold;
    for (let c = 0; c < numClasses; c++) {
      const s = output[(4 + c) * anchors + i];
      if (s > score && (!keepIdx || keepIdx.has(c))) {
        score = s;
        best = c;
      }
    }
    if (best < 0) continue;
    const cx = output[i];
    const cy = output[anchors + i];
    const w = output[2 * anchors + i];
    const h = output[3 * anchors + i];
    const box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
    found.push({ cls: classes[best], classIndex: best, score, box: lb ? unletterbox(box, lb) : box, anchor: i });
  }
  return nms(found, iouThreshold).slice(0, maxDetections);
}

function unletterbox([x1, y1, x2, y2], lb) {
  const fx = (x) => Math.min(lb.srcW, Math.max(0, (x - lb.padX) / lb.scale));
  const fy = (y) => Math.min(lb.srcH, Math.max(0, (y - lb.padY) / lb.scale));
  return [fx(x1), fy(y1), fx(x2), fy(y2)];
}

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/** Class-aware non-maximum suppression. */
export function nms(detections, threshold) {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const d of sorted) {
    if (!kept.some((k) => k.cls === d.cls && iou(k.box, d.box) > threshold)) kept.push(d);
  }
  return kept;
}
