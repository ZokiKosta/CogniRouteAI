// Renders a simple grayscale road scene through a pinhole camera: asphalt,
// solid and dashed lane markings, sky and the car's bonnet.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function renderRoad({
  width = 320,
  height = 180,
  horizon = 0.5,
  hood = 0.94,
  hfovDeg = 66,
  camHeight = 1.3,
  carX = 0, // car's lateral position on the road in meters (right positive)
  traveled = 0, // meters driven, moves the dashes
  lines = [
    { x: -1.75, type: 'dashed' },
    { x: 1.75, type: 'solid' },
  ],
  dash = 3,
  gap = 6,
  markWidth = 0.15,
  seed = 1,
} = {}) {
  const rand = rng(seed);
  const img = new Uint8Array(width * height);
  const f = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  const cx = width / 2;
  const vh = horizon * height;
  const hoodY = hood * height;
  for (let y = 0; y < height; y++) {
    const row = new Float32Array(width);
    if (y <= vh) row.fill(175);
    else if (y >= hoodY) row.fill(28);
    else {
      for (let x = 0; x < width; x++) row[x] = 88 + (rand() - 0.5) * 24;
      const z = (f * camHeight) / (y + 0.5 - vh);
      for (const line of lines) {
        if (line.type === 'dashed' && ((z + traveled) % (dash + gap) + dash + gap) % (dash + gap) >= dash) continue;
        const u = cx + (f * (line.x - carX)) / z;
        const half = Math.max(0.35, (f * markWidth) / 2 / z);
        for (let x = Math.floor(u - half - 1); x <= Math.ceil(u + half + 1); x++) {
          if (x < 0 || x >= width) continue;
          const cover = Math.max(0, Math.min(x + 1, u + half) - Math.max(x, u - half));
          row[x] = row[x] * (1 - cover) + 215 * cover;
        }
      }
    }
    for (let x = 0; x < width; x++) img[y * width + x] = Math.max(0, Math.min(255, Math.round(row[x])));
  }
  return { gray: img, width, height, f };
}

/** Image x where a road line at lateral position lineX meets the bottom of the road area. */
export function expectedBottomX({ width = 320, height = 180, horizon = 0.5, hood = 0.94, hfovDeg = 66, camHeight = 1.3, carX = 0 }, lineXm) {
  const f = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  const y = Math.round(height * hood) - 1;
  const z = (f * camHeight) / (y + 0.5 - horizon * height);
  return width / 2 + (f * (lineXm - carX)) / z;
}
