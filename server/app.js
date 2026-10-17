// HTTP API for trips, statistics and AI coaching, plus the built website and
// mobile app (from dist/) in production.
import express from 'express';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreTrip } from '../shared/scoring.js';
import { driverStats } from '../shared/stats.js';
import { tripStats } from '../shared/trip.js';
import { isolationHeadersFor, pageFor } from './pages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function validateTrip(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'trip must be an object';
  if (typeof t.id !== 'string' || !/^[\w-]{6,100}$/.test(t.id)) return 'invalid id';
  if (!Number.isFinite(t.startedAt)) return 'invalid startedAt';
  for (const key of ['events', 'maneuvers', 'route']) if (t[key] != null && !Array.isArray(t[key])) return `${key} must be an array`;
  if ((t.events?.length ?? 0) > 5000) return 'too many events';
  if ((t.maneuvers?.length ?? 0) > 5000) return 'too many maneuvers';
  if ((t.route?.length ?? 0) > 20000) return 'route too long';
  if (t.driverName != null && (typeof t.driverName !== 'string' || t.driverName.length > 80)) return 'invalid driverName';
  return null;
}

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export function lanUrls(port, protocol = 'http') {
  return lanAddresses().map((ip) => `${protocol}://${ip}:${port}`);
}

/** Simple per-IP limiter so a public deployment cannot burn through the API key. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= max) return res.status(429).json({ error: 'Премногу барања, обиди се повторно за неколку минути.' });
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

const topEvents = (summary) =>
  Object.entries(summary.stats?.events ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, n]) => `${type}×${n}`);

export function createApp({ db, coach, aiEnabled = false, model = null, distDir = join(ROOT, 'dist'), port = 3000 }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // The native (Capacitor) build of the app calls the API from another origin.
  app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api', express.json({ limit: '8mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true, ai: aiEnabled, model: aiEnabled ? model : null }));
  // The landing page builds a QR code for phones on the same Wi-Fi from these.
  app.get('/api/info', (req, res) => res.json({ addresses: lanAddresses(), ai: aiEnabled }));

  app.get('/api/drivers', (req, res) => res.json(db.drivers()));

  app.get('/api/trips', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    res.json(db.listTrips({ driverId: req.query.driverId || null, limit }));
  });

  app.post('/api/trips', (req, res) => {
    const trip = req.body;
    const problem = validateTrip(trip);
    if (problem) return res.status(400).json({ error: problem });
    trip.events ??= [];
    trip.maneuvers ??= [];
    trip.route ??= [];
    // Recompute derived numbers so every client is scored the same way.
    trip.stats = tripStats(trip);
    trip.score = scoreTrip(trip);
    db.saveTrip(trip);
    res.status(201).json({ id: trip.id, score: trip.score });
  });

  app.get('/api/trips/:id', (req, res) => {
    const trip = db.getTrip(req.params.id);
    if (!trip) return res.status(404).json({ error: 'not found' });
    res.json({ ...trip, coaching: db.getCoaching(trip.id) });
  });

  app.delete('/api/trips/:id', (req, res) => {
    res.status(db.deleteTrip(req.params.id) ? 204 : 404).end();
  });

  app.post('/api/trips/:id/coach', rateLimit({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res) => {
    const trip = db.getTrip(req.params.id);
    if (!trip) return res.status(404).json({ error: 'not found' });
    const cached = db.getCoaching(trip.id);
    if (cached && !req.query.refresh) return res.json(cached);
    const history = db
      .listTrips({ driverId: trip.driverId ?? null, limit: 6 })
      .filter((t) => t.id !== trip.id && t.startedAt < trip.startedAt)
      .slice(0, 5)
      .map((t) => ({ score: t.score, distanceKm: t.distanceKm, topEvents: topEvents(t) }));
    const result = await coach(trip, history);
    db.saveCoaching(trip.id, result);
    res.json(db.getCoaching(trip.id));
  });

  app.get('/api/stats', (req, res) => {
    res.json(driverStats(db.listTrips({ driverId: req.query.driverId || null, limit: 500 })));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  if (existsSync(distDir)) {
    app.use((req, res, next) => {
      if (req.path === '/app') return res.redirect(301, '/app/'); // keep the PWA scope
      res.set(isolationHeadersFor(req.path));
      const page = pageFor(req.path);
      if (page) return res.sendFile(join(distDir, page));
      next();
    });
    app.use(
      express.static(distDir, {
        index: false,
        setHeaders(res, file) {
          if (file.includes(`${join(distDir, 'assets')}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
  } else {
    app.get('/', (req, res) => res.type('text/plain').send('CogniRouteAI API. Run "npm run build" to serve the website and app, or use "npm run dev".'));
  }

  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'trip too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
