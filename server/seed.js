// Fills the database with demo trips around Skopje so the dashboard can be
// tried without driving. Usage: npm run seed  (re-running replaces them).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEvent } from '../shared/events.js';
import { DEG } from '../shared/math.js';
import { TripRecorder } from '../shared/trip.js';
import { openDb } from './db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DRIVERS = [
  { id: 'demo-ana', name: 'Ана (демо)', trips: 12, skill: 0.55 },
  { id: 'demo-marko', name: 'Марко – ученик (демо)', trips: 8, skill: 0.25 },
];

const CAPS = { motion: true, gps: true, roadCam: true, driverCam: true, audio: true };

/** One synthetic drive; `progress` 0..1 makes later trips cleaner. */
export function demoTrip({ driver, index, startedAt, progress, rand }) {
  const rec = new TripRecorder({ id: `demo-${driver.id}-${index}`, driverId: driver.id, driverName: driver.name, startedAt, capabilities: CAPS });
  let lat = 41.9965 + (rand() - 0.5) * 0.02;
  let lon = 21.4314 + (rand() - 0.5) * 0.03;
  let heading = rand() * 360;
  const seconds = 600 + Math.floor(rand() * 900);
  const fixes = [];
  for (let s = 0; s <= seconds; s++) {
    const cruise = 9 + 6 * Math.sin(s / 90 + index) + rand() * 2; // 30-60 km/h
    const speed = s < 20 ? (cruise * s) / 20 : Math.max(0, cruise);
    if (rand() < 0.02) heading += (rand() < 0.5 ? -1 : 1) * 90; // turn at a junction
    heading += (rand() - 0.5) * 6;
    lat += (speed * Math.cos(heading * DEG)) / 111320;
    lon += (speed * Math.sin(heading * DEG)) / (111320 * Math.cos(lat * DEG));
    const fix = { t: startedAt + s * 1000, lat, lon, speed, accuracy: 6 };
    fixes.push(fix);
    rec.addFix(fix);
  }
  const at = () => fixes[5 + Math.floor(rand() * (fixes.length - 10))];
  const mistakes = (1 - progress * 0.8) * (1 - driver.skill);
  const count = (rate) => Math.floor(rate * mistakes * (1 + rand() * 2));
  const add = (type, fields) => {
    const f = at();
    rec.addEvent(makeEvent(type, f.t, { lat: f.lat, lon: f.lon, speedKmh: Math.round(f.speed * 3.6), ...fields }));
  };
  for (let i = 0; i < count(5); i++) add('harsh_brake', { value: Math.round((0.36 + rand() * 0.2) * 100) / 100, unit: 'g', source: 'imu' });
  for (let i = 0; i < count(3); i++) add('harsh_accel', { value: Math.round((0.31 + rand() * 0.12) * 100) / 100, unit: 'g', source: 'imu' });
  for (let i = 0; i < count(2); i++) add('harsh_corner', { value: 0.45, unit: 'g', dir: rand() < 0.5 ? 'left' : 'right', source: 'imu' });
  for (let i = 0; i < count(4); i++) add('speeding', { value: 11 + Math.floor(rand() * 20), unit: 'km/h', limitKmh: 50, durationS: 6 + Math.floor(rand() * 30), source: 'gps' });
  for (let i = 0; i < count(3); i++) add('tailgating', { value: Math.round((0.7 + rand() * 1.1) * 10) / 10, unit: 's', durationS: 4 + Math.floor(rand() * 10), source: 'road_cam' });
  for (let i = 0; i < count(1.5); i++) add('phone_use', { source: 'app' });
  for (let i = 0; i < count(2); i++) add('distraction', { durationS: 2.4, zone: 'down', source: 'driver_cam' });
  if (rand() < 0.2 * mistakes) add('solid_line_crossing', { dir: 'left', source: 'judge' });
  if (rand() < 0.5) add('pedestrian_alert', { cls: 'person', distanceM: 14, source: 'road_cam' });
  if (rand() < 0.15) add('emergency_vehicle', { sirenType: 'wail', source: 'audio' });

  const maneuvers = 6 + Math.floor(rand() * 8);
  for (let i = 0; i < maneuvers; i++) {
    const f = at();
    const type = rand() < 0.55 ? 'lane_change' : rand() < 0.85 ? 'turn' : 'reverse';
    const blinker = type === 'reverse' ? null : rand() > mistakes * 0.6;
    const mirrorRoll = rand();
    const mirrors = mirrorRoll > mistakes * 0.9 ? 'full' : mirrorRoll > mistakes * 0.4 ? 'partial' : 'none';
    rec.addManeuver({ lat: f.lat, lon: f.lon, type, dir: rand() < 0.5 ? 'left' : 'right', tStart: f.t, tEnd: f.t + 4000, blinker, mirrors, order: blinker && mirrors !== 'none' ? (rand() > mistakes ? 'mirror_first' : 'blinker_first') : undefined, sources: ['imu'] });
    const where = { lat: f.lat, lon: f.lon, source: 'judge' };
    if (type !== 'reverse' && blinker === false) rec.addEvent(makeEvent(type === 'turn' ? 'turn_no_blinker' : 'lane_change_no_blinker', f.t, where));
    if (mirrors === 'none') rec.addEvent(makeEvent(type === 'reverse' ? 'reverse_no_check' : 'no_mirror_check', f.t, where));
  }
  return rec.finish(startedAt + seconds * 1000);
}

export function seed(db, now = Date.now()) {
  const rand = rng(2026);
  let n = 0;
  for (const driver of DRIVERS) {
    for (let i = 0; i < driver.trips; i++) {
      const daysAgo = (driver.trips - i) * (21 / driver.trips);
      const startedAt = Math.round(now - daysAgo * 86400000 + (7 + rand() * 12) * 3600000);
      db.saveTrip(demoTrip({ driver, index: i, startedAt, progress: i / Math.max(1, driver.trips - 1), rand }));
      n++;
    }
  }
  return n;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(process.env.DB_FILE ?? join(ROOT, 'server', 'data', 'cogniroute.db'));
  console.log(`Додадени ${seed(db)} демо возења.`);
  db.close();
}
