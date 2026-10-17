// Collects everything that happened during one drive into the trip record
// that is stored on the phone, synced to the server and shown on the website.
import { haversine } from './math.js';
import { scoreTrip } from './scoring.js';

export const TRIP_VERSION = 1;

export function newTripId(now = Date.now()) {
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  return `trip-${now.toString(36)}-${rand}`;
}

export class TripRecorder {
  constructor({ id = newTripId(), driverId = null, driverName = null, startedAt = Date.now(), capabilities = {}, settings = {} } = {}) {
    this.trip = {
      version: TRIP_VERSION,
      id,
      driverId,
      driverName,
      startedAt,
      endedAt: null,
      capabilities,
      settings,
      route: [],
      events: [],
      maneuvers: [],
    };
    this.distance = 0;
    this.maxSpeed = 0;
    this.movingMs = 0;
    this.lastFix = null;
    this.lastRoutePoint = null;
  }

  get lastPosition() {
    return this.lastFix ? { lat: this.lastFix.lat, lon: this.lastFix.lon } : {};
  }

  addFix({ t, lat, lon, speed = null, accuracy = null }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (accuracy != null && accuracy > 30) return;
    const prev = this.lastFix;
    if (prev) {
      const d = haversine(prev.lat, prev.lon, lat, lon);
      const dt = (t - prev.t) / 1000;
      if (dt <= 0 || d / dt > 70) return; // GPS jump
      if (d > 1.5 || (speed ?? 0) > 1) this.distance += d; // ignore jitter while parked
      if ((speed ?? d / dt) > 1) this.movingMs += t - prev.t;
    }
    if (speed != null) this.maxSpeed = Math.max(this.maxSpeed, speed);
    this.lastFix = { t, lat, lon, speed };
    const rp = this.lastRoutePoint;
    if (!rp || t - rp.t > 10000 || haversine(rp.lat, rp.lon, lat, lon) > 25) {
      this.lastRoutePoint = { t, lat, lon };
      if (this.trip.route.length < 5000) {
        this.trip.route.push([round(lat, 6), round(lon, 6), speed != null ? Math.round(speed * 3.6) : null, t - this.trip.startedAt]);
      }
    }
  }

  addEvent(e) {
    this.trip.events.push({ ...this.lastPosition, ...e });
  }

  addManeuver(m) {
    this.trip.maneuvers.push({ ...this.lastPosition, ...m });
  }

  /** Live numbers for the HUD. */
  get live() {
    const events = this.trip.events;
    return {
      distanceKm: this.distance / 1000,
      score: scoreTrip({ events, distanceKm: this.distance / 1000, capabilities: this.trip.capabilities }).overall,
      events: events.length,
    };
  }

  finish(endedAt = Date.now()) {
    const t = this.trip;
    t.endedAt = endedAt;
    t.durationS = Math.round((endedAt - t.startedAt) / 1000);
    t.distanceKm = round(this.distance / 1000, 2);
    t.movingS = Math.round(this.movingMs / 1000);
    t.maxSpeedKmh = Math.round(this.maxSpeed * 3.6);
    t.avgSpeedKmh = t.movingS > 0 ? Math.round((this.distance / t.movingS) * 3.6) : 0;
    t.events.sort((a, b) => a.t - b.t);
    t.maneuvers.sort((a, b) => a.tStart - b.tStart);
    t.stats = tripStats(t);
    t.score = scoreTrip(t);
    return t;
  }
}

export function tripStats(trip) {
  const byType = {};
  for (const e of trip.events) byType[e.type] = (byType[e.type] ?? 0) + 1;
  const m = trip.maneuvers;
  const judged = (key) => m.filter((x) => x[key] != null);
  const withBlinker = judged('blinker');
  const withMirrors = judged('mirrors');
  return {
    events: byType,
    maneuvers: {
      total: m.length,
      laneChanges: m.filter((x) => x.type === 'lane_change').length,
      turns: m.filter((x) => x.type === 'turn').length,
      reverses: m.filter((x) => x.type === 'reverse').length,
      blinkerRate: withBlinker.length ? round(withBlinker.filter((x) => x.blinker).length / withBlinker.length, 2) : null,
      mirrorRate: withMirrors.length ? round(withMirrors.filter((x) => x.mirrors === 'full').length / withMirrors.length, 2) : null,
    },
  };
}

function round(v, digits) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
