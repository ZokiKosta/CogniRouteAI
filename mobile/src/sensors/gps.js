// GPS position and speed.

export function watchGps(onFix, onError = () => {}) {
  if (!navigator.geolocation) {
    onError(new Error('Овој уред нема GPS / локација.'));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      onFix({
        t: pos.timestamp || Date.now(),
        lat: c.latitude,
        lon: c.longitude,
        speed: Number.isFinite(c.speed) ? c.speed : null,
        heading: Number.isFinite(c.heading) ? c.heading : null,
        accuracy: c.accuracy,
      });
    },
    (err) => onError(err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/** Simulated GPS for the demo mode (no car): a fixed speed along a straight road. */
export function simulateGps(onFix, getSpeedKmh) {
  let lat = 41.9965;
  let lon = 21.4314;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const v = getSpeedKmh() / 3.6;
    lon += (v * ((now - last) / 1000)) / (111320 * Math.cos((lat * Math.PI) / 180));
    last = now;
    onFix({ t: now, lat, lon, speed: v, heading: 90, accuracy: 5, simulated: true });
  }, 1000);
  return () => clearInterval(timer);
}
