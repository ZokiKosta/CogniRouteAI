import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LaneDetector, LaneTracker } from '../../shared/vision/lanes.js';
import { expectedBottomX, renderRoad } from '../helpers/road-sim.js';

const W = 320;
const H = 180;

function drive({ frames, carX = () => 0, lines, speed = 20, fps = 10 }) {
  const detector = new LaneDetector({ horizon: 0.5, hood: 0.94 });
  const changes = [];
  const tracker = new LaneTracker({ onLaneChange: (c) => changes.push(c) });
  let last = null;
  for (let i = 0; i < frames; i++) {
    const t = 1000 + (i * 1000) / fps;
    const scene = renderRoad({ carX: carX(i / fps), traveled: (i * speed) / fps, lines, seed: i + 1 });
    last = detector.detect(scene.gray, W, H);
    tracker.update(t, last.lines, W, speed);
  }
  return { changes, tracker, last };
}

test('finds a dashed and a solid line in one frame', () => {
  const scene = renderRoad({ traveled: 4 });
  const { lines } = new LaneDetector({ horizon: 0.5, hood: 0.94 }).detect(scene.gray, W, H);
  assert.equal(lines.length, 2, JSON.stringify(lines));
  const [left, right] = lines;
  assert.ok(Math.abs(left.xb - expectedBottomX({}, -1.75)) < 6, `left xb ${left.xb}`);
  assert.ok(Math.abs(right.xb - expectedBottomX({}, 1.75)) < 6, `right xb ${right.xb}`);
  assert.ok(right.coverage > 0.8, `solid coverage ${right.coverage}`);
  assert.ok(left.coverage < 0.6, `dashed coverage ${left.coverage}`);
});

test('tracker settles on line types while driving', () => {
  const { tracker } = drive({ frames: 20 });
  const { left, right } = tracker.egoLane(W);
  assert.equal(left?.type, 'dashed');
  assert.equal(right?.type, 'solid');
});

test('lane change to the left over a dashed line', () => {
  const lines = [
    { x: -5.25, type: 'solid' },
    { x: -1.75, type: 'dashed' },
    { x: 1.75, type: 'solid' },
  ];
  const { changes } = drive({ frames: 80, lines, carX: (t) => (t < 2 ? 0 : t > 6 ? -3.5 : (-3.5 * (1 - Math.cos((Math.PI * (t - 2)) / 4))) / 2) });
  assert.equal(changes.length, 1, JSON.stringify(changes));
  assert.equal(changes[0].dir, 'left');
  assert.equal(changes[0].lineType, 'dashed');
});

test('lane change to the right over a solid line is reported as solid', () => {
  const lines = [
    { x: -1.75, type: 'dashed' },
    { x: 1.75, type: 'solid' },
    { x: 5.25, type: 'dashed' },
  ];
  const { changes } = drive({ frames: 80, lines, carX: (t) => (t < 2 ? 0 : t > 6 ? 3.5 : (3.5 * (1 - Math.cos((Math.PI * (t - 2)) / 4))) / 2) });
  assert.equal(changes.length, 1, JSON.stringify(changes));
  assert.equal(changes[0].dir, 'right');
  assert.equal(changes[0].lineType, 'solid');
});

test('touching the line and coming back is not a lane change', () => {
  const { changes } = drive({ frames: 70, carX: (t) => (t < 2 ? 0 : t > 6 ? 0 : -2.0 * Math.sin((Math.PI * (t - 2)) / 4)) });
  assert.equal(changes.length, 0, JSON.stringify(changes));
});

test('no lines on plain asphalt', () => {
  const scene = renderRoad({ lines: [] });
  const { lines } = new LaneDetector({ horizon: 0.5, hood: 0.94 }).detect(scene.gray, W, H);
  assert.equal(lines.length, 0, JSON.stringify(lines));
});
