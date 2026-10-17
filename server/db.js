// SQLite storage (Node's built-in node:sqlite, no native modules to build).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  driver_id TEXT,
  driver_name TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  distance_km REAL,
  duration_s INTEGER,
  score INTEGER,
  data TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trips_driver ON trips (driver_id, started_at DESC);
CREATE TABLE IF NOT EXISTS coaching (
  trip_id TEXT PRIMARY KEY REFERENCES trips (id) ON DELETE CASCADE,
  source TEXT,
  model TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const q = {
    upsert: db.prepare(`
      INSERT INTO trips (id, driver_id, driver_name, started_at, ended_at, distance_km, duration_s, score, data, received_at)
      VALUES ($id, $driverId, $driverName, $startedAt, $endedAt, $distanceKm, $durationS, $score, $data, $receivedAt)
      ON CONFLICT (id) DO UPDATE SET
        driver_id = excluded.driver_id, driver_name = excluded.driver_name, started_at = excluded.started_at,
        ended_at = excluded.ended_at, distance_km = excluded.distance_km, duration_s = excluded.duration_s,
        score = excluded.score, data = excluded.data, received_at = excluded.received_at`),
    get: db.prepare('SELECT data FROM trips WHERE id = ?'),
    list: db.prepare(`SELECT id, driver_id, driver_name, started_at, ended_at, distance_km, duration_s, score, data FROM trips
      WHERE ($driverId IS NULL OR driver_id = $driverId) ORDER BY started_at DESC LIMIT $limit`),
    remove: db.prepare('DELETE FROM trips WHERE id = ?'),
    drivers: db.prepare(`SELECT driver_id, MAX(driver_name) AS driver_name, COUNT(*) AS trips, ROUND(SUM(distance_km), 1) AS km,
      ROUND(AVG(score)) AS avg_score, MAX(started_at) AS last_trip FROM trips GROUP BY driver_id ORDER BY last_trip DESC`),
    coachingGet: db.prepare('SELECT source, model, content, created_at FROM coaching WHERE trip_id = ?'),
    coachingSet: db.prepare(`INSERT INTO coaching (trip_id, source, model, content, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (trip_id) DO UPDATE SET source = excluded.source, model = excluded.model, content = excluded.content, created_at = excluded.created_at`),
  };

  return {
    raw: db,
    saveTrip(trip) {
      q.upsert.run({
        $id: trip.id,
        $driverId: trip.driverId ?? null,
        $driverName: trip.driverName ?? null,
        $startedAt: trip.startedAt,
        $endedAt: trip.endedAt ?? null,
        $distanceKm: trip.distanceKm ?? null,
        $durationS: trip.durationS ?? null,
        $score: trip.score?.overall ?? null,
        $data: JSON.stringify(trip),
        $receivedAt: Date.now(),
      });
    },
    getTrip(id) {
      const row = q.get.get(id);
      return row ? JSON.parse(row.data) : null;
    },
    /** Trip summaries, newest first (route and raw events left out). */
    listTrips({ driverId = null, limit = 50 } = {}) {
      return q.list.all({ $driverId: driverId, $limit: limit }).map((r) => {
        const t = JSON.parse(r.data);
        return {
          id: r.id,
          driverId: r.driver_id,
          driverName: r.driver_name,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          distanceKm: r.distance_km,
          durationS: r.duration_s,
          score: r.score,
          categories: t.score?.categories ?? null,
          stats: t.stats ?? null,
          capabilities: t.capabilities ?? {},
          eventCount: t.events?.length ?? 0,
        };
      });
    },
    deleteTrip(id) {
      return q.remove.run(id).changes > 0;
    },
    drivers() {
      return q.drivers.all().map((r) => ({
        id: r.driver_id,
        name: r.driver_name,
        trips: r.trips,
        km: r.km,
        avgScore: r.avg_score,
        lastTrip: r.last_trip,
      }));
    },
    getCoaching(tripId) {
      const row = q.coachingGet.get(tripId);
      return row ? { ...JSON.parse(row.content), source: row.source, model: row.model, createdAt: row.created_at } : null;
    },
    saveCoaching(tripId, coaching) {
      const { source = null, model = null, ...content } = coaching;
      q.coachingSet.run(tripId, source, model, JSON.stringify(content), Date.now());
    },
    close() {
      db.close();
    },
  };
}
