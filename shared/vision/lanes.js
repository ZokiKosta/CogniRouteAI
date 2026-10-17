// Lane-marking detection and tracking on the road camera, without a neural
// network: bright thin "ridges" on the asphalt are collected row by row and a
// Hough transform (parametrised by where a line meets the top and the bottom
// of the road area) finds straight markings. How much of a line's length is
// painted tells a solid line (полна линија) from a dashed one.
// The tracker follows lines over time and reports when one passes under the
// car's centre line: a lane change, and over which kind of line.

const DETECT_DEFAULTS = {
  horizon: 0.5, // fraction of height where the road meets the horizon
  hood: 0.94, // fraction of height where the bonnet starts
  roiOffset: 0.06, // start the road area a bit below the horizon
  minContrast: 18,
  roadBrighter: 14,
  maxLines: 4,
  minVoteShare: 0.16,
};

export class LaneDetector {
  constructor(options = {}) {
    this.o = { ...DETECT_DEFAULTS, ...options };
  }

  configure(options) {
    Object.assign(this.o, options);
  }

  /** gray: Uint8Array/Uint8ClampedArray of width*height luminance values. */
  detect(gray, width, height) {
    const o = this.o;
    const top = Math.round(height * Math.min(0.9, o.horizon + o.roiOffset));
    const bottom = Math.round(height * o.hood) - 1;
    if (bottom - top < 10) return { lines: [], top, bottom, candidates: 0 };
    const candidates = findCandidates(gray, width, top, bottom, o);
    const lines = houghLines(candidates, width, top, bottom, o);
    return { lines, top, bottom, candidates: candidates.length };
  }
}

/** Bright, narrow, darker-on-both-sides pixels in each row of the road area. */
function findCandidates(gray, width, top, bottom, o) {
  const out = [];
  const rowValues = new Uint8Array(width);
  for (let y = top; y <= bottom; y++) {
    const s = (y - top) / (bottom - top);
    const d = Math.max(2, Math.round(1.5 + s * 0.03 * width));
    const base = y * width;
    for (let x = 0; x < width; x++) rowValues[x] = gray[base + x];
    const road = quickMedian(rowValues);
    let runStart = -1;
    let runBest = 0;
    for (let x = 0; x <= width; x++) {
      let hit = false;
      let r = 0;
      if (x >= d && x < width - d) {
        const v = gray[base + x];
        r = Math.min(v - gray[base + x - d], v - gray[base + x + d]);
        hit = r > o.minContrast && v > road + o.roadBrighter;
      }
      if (hit) {
        if (runStart < 0) runStart = x;
        runBest = Math.max(runBest, r);
      } else if (runStart >= 0) {
        const len = x - runStart;
        if (len <= 2.5 * d) out.push({ x: (runStart + x - 1) / 2, y, s, r: runBest });
        runStart = -1;
        runBest = 0;
      }
    }
  }
  return out;
}

function quickMedian(values) {
  const hist = new Uint32Array(256);
  for (const v of values) hist[v]++;
  let acc = 0;
  const half = values.length / 2;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= half) return i;
  }
  return 128;
}

/** Hough transform over (x at the top row, x at the bottom row) + least-squares refinement. */
function houghLines(cands, width, top, bottom, o) {
  const rows = bottom - top + 1;
  const xtStep = 2;
  const xbStep = 3;
  const xtBins = Math.ceil(width / xtStep) + 1;
  const xbMin = -width;
  const xbBins = Math.ceil((3 * width) / xbStep) + 1;
  const acc = new Float32Array(xtBins * xbBins);
  for (const c of cands) {
    if (c.s < 0.04) continue;
    for (let i = 0; i < xtBins; i++) {
      const xt = i * xtStep;
      const xb = xt + (c.x - xt) / c.s;
      const j = Math.round((xb - xbMin) / xbStep);
      if (j >= 0 && j < xbBins) acc[i * xbBins + j] += 1;
    }
  }
  const minVotes = rows * o.minVoteShare;
  const lines = [];
  for (let n = 0; n < o.maxLines * 2 && lines.length < o.maxLines; n++) {
    let best = -1;
    let bestV = minVotes;
    for (let k = 0; k < acc.length; k++) {
      if (acc[k] > bestV) {
        bestV = acc[k];
        best = k;
      }
    }
    if (best < 0) break;
    const bi = Math.floor(best / xbBins);
    const bj = best % xbBins;
    for (let i = Math.max(0, bi - 5); i <= Math.min(xtBins - 1, bi + 5); i++) {
      for (let j = Math.max(0, bj - 8); j <= Math.min(xbBins - 1, bj + 8); j++) acc[i * xbBins + j] = 0;
    }
    const line = refine(cands, bi * xtStep, xbMin + bj * xbStep, width, top, bottom);
    if (line && !lines.some((l) => Math.abs(l.xb - line.xb) < width * 0.04 && Math.abs(l.xt - line.xt) < width * 0.02)) lines.push(line);
  }
  return lines.sort((a, b) => a.xb - b.xb);
}

function refine(cands, xt0, xb0, width, top, bottom) {
  let xt = xt0;
  let xb = xb0;
  let inliers = [];
  for (let pass = 0; pass < 2; pass++) {
    inliers = cands.filter((c) => Math.abs(c.x - (xt + (xb - xt) * c.s)) <= 1.5 + c.s * 0.012 * width);
    if (inliers.length < 4) return null;
    // Least squares x = a + b s  ->  xt = a, xb = a + b
    let ss = 0;
    let sx = 0;
    let sss = 0;
    let ssx = 0;
    for (const c of inliers) {
      ss += c.s;
      sx += c.x;
      sss += c.s * c.s;
      ssx += c.s * c.x;
    }
    const n = inliers.length;
    const den = n * sss - ss * ss;
    if (Math.abs(den) < 1e-9) return null;
    const b = (n * ssx - ss * sx) / den;
    const a = (sx - b * ss) / n;
    xt = a;
    xb = a + b;
  }
  const rows = bottom - top + 1;
  const rowHit = new Uint8Array(rows);
  let minS = 1;
  let maxS = 0;
  for (const c of inliers) {
    rowHit[c.y - top] = 1;
    minS = Math.min(minS, c.s);
    maxS = Math.max(maxS, c.s);
  }
  // Coverage over the stretch the line is visible in (it may start lower down).
  const firstRow = Math.floor(minS * (rows - 1));
  let hits = 0;
  for (let r = firstRow; r < rows; r++) hits += rowHit[r];
  const extent = maxS - minS;
  if (extent < 0.35) return null;
  return {
    xt: round1(xt),
    xb: round1(xb),
    top,
    bottom,
    coverage: Math.round((hits / Math.max(1, rows - firstRow)) * 100) / 100,
    extent: Math.round(extent * 100) / 100,
    inliers: inliers.length,
  };
}

const round1 = (v) => Math.round(v * 10) / 10;

/** x position of a line at image row y. */
export function lineX(line, y) {
  const s = (y - line.top) / (line.bottom - line.top);
  return line.xt + (line.xb - line.xt) * s;
}

const TRACK_DEFAULTS = {
  centerX: 0.5, // car centre line as a fraction of the image width
  solidAbove: 0.68,
  dashedBelow: 0.55,
  coverageTau: 700, // ms
  confirmMs: 600,
  minLaneChangeSpeed: 4, // m/s
};

export class LaneTracker {
  constructor({ onLaneChange = () => {}, options = {} } = {}) {
    this.onLaneChange = onLaneChange;
    this.o = { ...TRACK_DEFAULTS, ...options };
    this.tracks = [];
    this.nextId = 1;
    this.lastT = null;
  }

  configure(options) {
    Object.assign(this.o, options);
  }

  /** speed in m/s (null if unknown). */
  update(t, lines, width, speed = null) {
    const dt = this.lastT == null ? 100 : Math.min(500, t - this.lastT);
    this.lastT = t;
    const gate = width * 0.12;
    const unmatched = new Set(lines.map((_, i) => i));
    for (const tr of [...this.tracks].sort((a, b) => b.seen - a.seen)) {
      let best = -1;
      let bestCost = gate;
      for (const i of unmatched) {
        const cost = Math.abs(lines[i].xb - (tr.xb + tr.vel * dt)) + 0.5 * Math.abs(lines[i].xt - tr.xt);
        if (cost < bestCost) {
          bestCost = cost;
          best = i;
        }
      }
      if (best >= 0) {
        unmatched.delete(best);
        const l = lines[best];
        const k = 1 - Math.exp(-dt / this.o.coverageTau);
        tr.vel = 0.7 * tr.vel + 0.3 * ((l.xb - tr.xb) / dt);
        tr.xb = 0.5 * tr.xb + 0.5 * l.xb;
        tr.xt = 0.5 * tr.xt + 0.5 * l.xt;
        tr.coverage += (l.coverage - tr.coverage) * k;
        tr.top = l.top;
        tr.bottom = l.bottom;
        tr.seen++;
        tr.missed = 0;
        tr.lastSeen = t;
      } else {
        tr.missed++;
      }
    }
    for (const i of unmatched) {
      const l = lines[i];
      this.tracks.push({
        id: this.nextId++,
        xb: l.xb,
        xt: l.xt,
        top: l.top,
        bottom: l.bottom,
        vel: 0,
        coverage: l.coverage,
        seen: 1,
        missed: 0,
        lastSeen: t,
        type: 'unknown',
        side: 0,
        crossing: null,
        approachT: null,
      });
    }
    this.tracks = this.tracks.filter((tr) => t - tr.lastSeen < 1200);

    const egoX = width * this.o.centerX;
    for (const tr of this.tracks) {
      if (tr.coverage > this.o.solidAbove && tr.seen >= 5) tr.type = 'solid';
      else if (tr.coverage < this.o.dashedBelow && tr.seen >= 5) tr.type = 'dashed';
      this.checkCrossing(t, tr, egoX, width, speed);
    }
  }

  checkCrossing(t, tr, egoX, width, speed) {
    const off = tr.xb - egoX;
    const side = Math.sign(off);
    if (Math.abs(off) > width * 0.25) tr.approachT = null;
    else if (tr.approachT == null && Math.abs(off) < width * 0.18) tr.approachT = t;
    if (tr.seen < 4 || tr.missed > 0) return;

    if (tr.crossing) {
      if (side === tr.crossing.from) tr.crossing = null; // went back: weaving, not a lane change
      else if (t - tr.crossing.t >= this.o.confirmMs && Math.abs(off) > width * 0.06) {
        const c = tr.crossing;
        tr.crossing = null;
        if (speed == null || speed >= this.o.minLaneChangeSpeed) {
          this.onLaneChange({
            type: 'lane_change',
            dir: c.from < 0 ? 'left' : 'right',
            lineType: c.lineType,
            tStart: c.startT,
            tEnd: t,
            source: 'camera',
          });
        }
      }
    } else if (tr.side && side && side !== tr.side) {
      tr.crossing = { from: tr.side, t, startT: tr.approachT ?? t, lineType: tr.type };
    }
    if (side) tr.side = side;
  }

  /** The tracked lines just left and right of the car. */
  egoLane(width) {
    const egoX = width * this.o.centerX;
    let left = null;
    let right = null;
    for (const tr of this.tracks) {
      if (tr.missed > 3) continue;
      if (tr.xb < egoX && (!left || tr.xb > left.xb)) left = tr;
      if (tr.xb >= egoX && (!right || tr.xb < right.xb)) right = tr;
    }
    return { left, right };
  }
}
