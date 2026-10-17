// Speeding episodes: over the limit by more than the tolerance for a few seconds.
import { makeEvent } from '../events.js';

export class SpeedMonitor {
  constructor({ onEvent = () => {}, onAlert = () => {}, toleranceKmh = 10, minDurationMs = 5000, alertAfterMs = 3000 } = {}) {
    this.onEvent = onEvent;
    this.onAlert = onAlert;
    this.toleranceKmh = toleranceKmh;
    this.minDurationMs = minDurationMs;
    this.alertAfterMs = alertAfterMs;
    this.episode = null;
  }

  /** speed in m/s, limit in km/h; `where` is { lat, lon }. */
  update(t, speed, limitKmh, where = {}) {
    if (speed == null || !limitKmh) {
      this.flush();
      return;
    }
    const kmh = speed * 3.6;
    const over = kmh - limitKmh;
    if (over > this.toleranceKmh) {
      const ep = (this.episode ??= { start: t, last: t, maxOver: over, maxSpeed: kmh, limit: limitKmh, alerted: false, ...where });
      ep.last = t;
      if (over > ep.maxOver) Object.assign(ep, { maxOver: over, maxSpeed: kmh, limit: limitKmh });
      if (!ep.alerted && t - ep.start >= this.alertAfterMs) {
        ep.alerted = true;
        this.onAlert({ t, speedKmh: Math.round(kmh), limitKmh });
      }
    } else if (this.episode && over < this.toleranceKmh - 3) {
      this.flush();
    }
  }

  flush() {
    const ep = this.episode;
    this.episode = null;
    if (!ep || ep.last - ep.start < this.minDurationMs) return;
    this.onEvent(
      makeEvent('speeding', ep.start, {
        tEnd: ep.last,
        value: Math.round(ep.maxOver),
        unit: 'km/h',
        speedKmh: Math.round(ep.maxSpeed),
        limitKmh: ep.limit,
        durationS: Math.round((ep.last - ep.start) / 1000),
        lat: ep.lat,
        lon: ep.lon,
        source: 'gps',
      }),
    );
  }
}
