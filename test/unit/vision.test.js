import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeYolo, letterbox, nms, toTensor } from '../../shared/vision/yolo.js';
import { RoadRiskMonitor, estimateDistance, findLead, focalPx } from '../../shared/vision/road-risk.js';

const CLASSES = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck'];

function fakeOutput(anchors, boxes) {
  const channels = 4 + CLASSES.length;
  const out = new Float32Array(channels * anchors);
  boxes.forEach(({ i, cx, cy, w, h, cls, score }) => {
    out[i] = cx;
    out[anchors + i] = cy;
    out[2 * anchors + i] = w;
    out[3 * anchors + i] = h;
    out[(4 + CLASSES.indexOf(cls)) * anchors + i] = score;
  });
  return { out, dims: [1, channels, anchors] };
}

test('letterbox maps a 16:9 frame into 320x192', () => {
  const lb = letterbox(320, 180, 320, 192);
  assert.equal(lb.scale, 1);
  assert.equal(lb.padY, 6);
  assert.equal(lb.padX, 0);
  const { data } = toTensor(new Uint8ClampedArray(320 * 180 * 4).fill(255), 320, 180, 320, 192);
  assert.equal(data.length, 3 * 320 * 192);
  assert.ok(Math.abs(data[0] - 114 / 255) < 1e-6, 'padding is gray');
  assert.equal(data[320 * 10], 1, 'image pixels are copied');
});

test('decodes boxes, removes duplicates and maps back to the frame', () => {
  const lb = letterbox(640, 360, 320, 192);
  const { out, dims } = fakeOutput(100, [
    { i: 3, cx: 160, cy: 96, w: 40, h: 30, cls: 'car', score: 0.9 },
    { i: 4, cx: 162, cy: 97, w: 41, h: 30, cls: 'car', score: 0.7 }, // duplicate
    { i: 9, cx: 60, cy: 100, w: 10, h: 30, cls: 'person', score: 0.8 },
    { i: 10, cx: 250, cy: 100, w: 20, h: 20, cls: 'airplane', score: 0.95 }, // filtered out
    { i: 11, cx: 280, cy: 120, w: 20, h: 20, cls: 'truck', score: 0.2 }, // too weak
  ]);
  const dets = decodeYolo(out, dims, { classes: CLASSES, letterbox: lb, keep: new Set(['car', 'person', 'truck']) });
  assert.deepEqual(dets.map((d) => d.cls).sort(), ['car', 'person']);
  const car = dets.find((d) => d.cls === 'car');
  // input x 140..180 -> frame x 280..360; input y (96-15-6)..(96+15-6) -> frame 150..210
  assert.deepEqual(car.box.map(Math.round), [280, 150, 360, 210]);
});

test('nms keeps different classes that overlap', () => {
  const kept = nms(
    [
      { cls: 'person', score: 0.9, box: [0, 0, 10, 20] },
      { cls: 'bicycle', score: 0.8, box: [0, 2, 10, 20] },
      { cls: 'person', score: 0.5, box: [1, 0, 11, 20] },
    ],
    0.45,
  );
  assert.deepEqual(kept.map((k) => k.cls), ['person', 'bicycle']);
});

// A car `d` meters ahead, `x` meters to the right, in a 320x180 frame.
const W = 320;
const H = 180;
const camera = { hfovDeg: 63, horizon: 0.5, hood: 0.94, camHeight: 1.3, centerX: 0.5 };
function carAt(d, x = 0, cls = 'car', width = 1.8, height = 1.5) {
  const f = focalPx(W, camera.hfovDeg);
  const cx = W / 2 + (f * x) / d;
  const bottom = H * camera.horizon + (f * camera.camHeight) / d;
  return { cls, score: 0.8, box: [cx - (f * width) / d / 2, bottom - (f * height) / d, cx + (f * width) / d / 2, bottom] };
}

test('distance from box size and road contact agree', () => {
  for (const d of [8, 15, 30]) {
    const est = estimateDistance(carAt(d), W, H, camera);
    assert.ok(Math.abs(est - d) / d < 0.05, `${d} m estimated as ${est}`);
  }
  const person = carAt(12, 0, 'person', 0.5, 1.7);
  assert.ok(Math.abs(estimateDistance(person, W, H, camera) - 12) < 0.6);
});

test('lead vehicle is the closest one in our lane', () => {
  const lead = findLead([carAt(20), carAt(10, 3.5), carAt(35)], W, H, {}, camera);
  assert.equal(Math.round(estimateDistance(lead, W, H, camera)), 20);
});

test('tailgating at 70 km/h with a 10 m gap becomes an event and an alert', () => {
  const events = [];
  const alerts = [];
  const mon = new RoadRiskMonitor({ onEvent: (e) => events.push(e), onAlert: (a) => alerts.push(a), camera });
  const speed = 70 / 3.6;
  for (let i = 0; i < 80; i++) {
    const gap = i < 60 ? 10 : 40; // 0.5 s gap for 6 s, then drops back
    mon.update(i * 100, { detections: [carAt(gap)], frameW: W, frameH: H, speed });
  }
  for (let i = 80; i < 100; i++) mon.update(i * 100, { detections: [], frameW: W, frameH: H, speed });
  const ev = events.find((e) => e.type === 'tailgating');
  assert.ok(ev, JSON.stringify(events));
  assert.ok(ev.value < 0.7, `min headway ${ev.value}`);
  assert.ok(alerts.some((a) => a.kind === 'tailgating'));
});

test('closing in fast triggers a collision warning', () => {
  const alerts = [];
  const mon = new RoadRiskMonitor({ onAlert: (a) => alerts.push(a), camera });
  for (let i = 0; i < 15; i++) mon.update(i * 100, { detections: [carAt(30 - i * 1.5)], frameW: W, frameH: H, speed: 15 });
  assert.ok(alerts.some((a) => a.kind === 'collision'), JSON.stringify(alerts));
});

test('pedestrian ahead raises an alert, one far to the side does not', () => {
  const events = [];
  const alerts = [];
  const mon = new RoadRiskMonitor({ onEvent: (e) => events.push(e), onAlert: (a) => alerts.push(a), camera });
  mon.update(0, { detections: [carAt(14, 6, 'person', 0.5, 1.7)], frameW: W, frameH: H, speed: 10 });
  assert.equal(alerts.length, 0);
  mon.update(100, { detections: [carAt(14, 1, 'person', 0.5, 1.7)], frameW: W, frameH: H, speed: 10 });
  assert.equal(alerts[0]?.kind, 'pedestrian');
  assert.equal(events[0]?.type, 'pedestrian_alert');
});

test('rolling through a STOP sign is reported, stopping is not', () => {
  const sign = { cls: 'stop sign', score: 0.9, box: [250, 60, 262, 72] };
  for (const [minSpeed, expected] of [
    [3, 1],
    [0.2, 0],
  ]) {
    const events = [];
    const mon = new RoadRiskMonitor({ onEvent: (e) => events.push(e), camera });
    for (let i = 0; i < 100; i++) {
      const speed = i < 30 ? 10 : i < 50 ? minSpeed : 8;
      mon.update(i * 100, { detections: i < 30 ? [sign] : [], frameW: W, frameH: H, speed });
    }
    assert.equal(events.filter((e) => e.type === 'stop_sign_violation').length, expected, `min speed ${minSpeed}`);
  }
});
