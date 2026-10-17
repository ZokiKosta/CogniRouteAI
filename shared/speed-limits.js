// Speed limits from OpenStreetMap (Overpass API), with defaults for North
// Macedonia when a road has no `maxspeed` tag: 50 km/h in settlements,
// 80 outside, 100 on expressways and 130 on motorways.
import { angleDiffDeg, bearing, haversine } from './math.js';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const ZONE_LIMITS = { urban: 50, rural: 80, trunk: 100, motorway: 130, living_street: 10, walk: 7 };
const HIGHWAY_DEFAULTS = { motorway: 130, trunk: 100, living_street: 10 };
const DRIVABLE = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$/;

/** Parses an OSM maxspeed value ("50", "30 mph", "MK:urban", "none") to km/h, or null. */
export function parseMaxspeed(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  const num = v.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?$/);
  if (num) return Math.round(parseFloat(num[1]) * (num[2] === 'mph' ? 1.609 : 1));
  const zone = v.match(/^[a-z]{2}:(\w+)$/);
  if (zone) return ZONE_LIMITS[zone[1]] ?? null;
  if (v === 'walk') return ZONE_LIMITS.walk;
  return null; // "none", "signals", "variable"...
}

/** Limit of one OSM way in km/h (null when it cannot be told). */
export function wayLimit(tags = {}) {
  const tagged = parseMaxspeed(tags['maxspeed:forward'] ?? tags.maxspeed);
  if (tagged) return { limit: tagged, source: 'osm' };
  const implicit = parseMaxspeed(tags['maxspeed:type'] ?? tags['source:maxspeed']);
  if (implicit) return { limit: implicit, source: 'osm-zone' };
  const road = (tags.highway ?? '').replace(/_link$/, '');
  if (HIGHWAY_DEFAULTS[road]) return { limit: HIGHWAY_DEFAULTS[road], source: 'road-type' };
  return null;
}

export function overpassQuery(lat, lon, radius = 30) {
  return `[out:json][timeout:10];way(around:${radius},${lat.toFixed(6)},${lon.toFixed(6)})[highway];out tags geom;`;
}

/**
 * Picks the way the car is most likely on: close to the position and, when
 * the heading is known, running in the same direction (either way along it).
 */
export function pickWay(ways, lat, lon, heading = null) {
  let best = null;
  for (const way of ways) {
    if (!DRIVABLE.test(way.tags?.highway ?? '') || !way.geometry?.length) continue;
    let nearest = { d: Infinity, bearing: null };
    for (let i = 0; i + 1 < way.geometry.length; i++) {
      const a = way.geometry[i];
      const b = way.geometry[i + 1];
      const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
      const d = Math.min(haversine(lat, lon, a.lat, a.lon), haversine(lat, lon, mid.lat, mid.lon), haversine(lat, lon, b.lat, b.lon));
      if (d < nearest.d) nearest = { d, bearing: bearing(a.lat, a.lon, b.lat, b.lon) };
    }
    let cost = nearest.d;
    if (heading != null && nearest.bearing != null) {
      const diff = Math.abs(angleDiffDeg(heading, nearest.bearing));
      cost += Math.min(diff, 180 - diff) * 0.5; // 0.5 m per degree off-axis
    }
    if (!best || cost < best.cost) best = { way, cost };
  }
  return best?.way ?? null;
}

/** Throttled lookups while driving: at most one request per `minIntervalMs` or `minDistanceM`. */
export class SpeedLimitService {
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), url = OVERPASS_URL, minIntervalMs = 15000, minDistanceM = 150 } = {}) {
    this.fetch = fetchImpl;
    this.url = url;
    this.minIntervalMs = minIntervalMs;
    this.minDistanceM = minDistanceM;
    this.last = null;
    this.current = null; // { limit, source, road }
    this.pending = false;
  }

  async update({ t, lat, lon, heading }) {
    if (!this.fetch || this.pending) return this.current;
    if (this.last && t - this.last.t < this.minIntervalMs && haversine(lat, lon, this.last.lat, this.last.lon) < this.minDistanceM) {
      return this.current;
    }
    this.pending = true;
    this.last = { t, lat, lon };
    try {
      const res = await this.fetch(this.url, {
        method: 'POST',
        body: new URLSearchParams({ data: overpassQuery(lat, lon) }),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const data = await res.json();
      const way = pickWay(data.elements ?? [], lat, lon, heading);
      const limit = way ? wayLimit(way.tags) : null;
      this.current = limit ? { ...limit, road: way.tags.name ?? way.tags.ref ?? null, highway: way.tags.highway } : null;
    } catch {
      // Offline or rate-limited: keep the previous value.
    } finally {
      this.pending = false;
    }
    return this.current;
  }
}
