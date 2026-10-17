// Accelerometer + gyroscope through DeviceMotionEvent.
const DEG = Math.PI / 180;

/** iOS asks for permission (from a tap); other browsers allow it directly. */
export async function requestMotionPermission() {
  const DME = globalThis.DeviceMotionEvent;
  if (!DME) return 'unsupported';
  if (typeof DME.requestPermission === 'function') {
    try {
      return (await DME.requestPermission()) === 'granted' ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  }
  return 'granted';
}

/** Calls onSample({ t, acc, accG, gyro }) ~60 times per second; returns stop(). */
export function watchMotion(onSample) {
  const handler = (e) => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    const a = e.acceleration;
    const r = e.rotationRate;
    onSample({
      t: Date.now(),
      accG: [g.x, g.y, g.z],
      acc: a && a.x != null ? [a.x, a.y, a.z] : null,
      // rotationRate: alpha around z, beta around x, gamma around y (deg/s)
      gyro: r && r.alpha != null ? [r.beta * DEG, r.gamma * DEG, r.alpha * DEG] : null,
    });
  };
  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}

/** Single reading of gravity, used for the "is the phone level?" indicator. */
export function watchGravity(onGravity) {
  return watchMotion((s) => onGravity(s.acc ? s.accG.map((v, i) => v - s.acc[i]) : s.accG));
}
