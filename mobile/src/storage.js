// Trips are saved on the phone first (IndexedDB) and synced to the server
// when there is a connection.
import { apiBase } from './state.js';

const DB_NAME = 'cogniroute';
const STORE = 'trips';
let dbPromise = null;
const memory = new Map(); // fallback when IndexedDB is unavailable

function open() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const request = fn(t.objectStore(STORE));
    // A missing key resolves to undefined (not to the request object).
    t.oncomplete = () => resolve(request instanceof IDBRequest ? request.result : request);
    t.onerror = () => reject(t.error);
  });
}

export async function saveTrip(trip) {
  memory.set(trip.id, trip);
  await tx('readwrite', (store) => store?.put(trip));
  return trip;
}

export async function getTrip(id) {
  const found = await tx('readonly', (store) => store?.get(id));
  return found ?? memory.get(id) ?? null;
}

export async function listTrips() {
  const all = (await tx('readonly', (store) => store?.getAll())) ?? [...memory.values()];
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function deleteTrip(id) {
  memory.delete(id);
  await tx('readwrite', (store) => store?.delete(id));
}

/** Uploads a trip; returns the server's score or throws. */
export async function uploadTrip(trip) {
  const { synced, coaching, ...body } = trip;
  const res = await fetch(`${apiBase()}/api/trips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`server ${res.status}`);
  const answer = await res.json();
  await saveTrip({ ...trip, score: answer.score ?? trip.score, synced: true });
  return answer;
}

export async function syncPending() {
  let count = 0;
  for (const trip of await listTrips()) {
    if (trip.synced) continue;
    try {
      await uploadTrip(trip);
      count++;
    } catch {
      break; // offline or server down; try again later
    }
  }
  return count;
}

export async function fetchCoaching(tripId, refresh = false) {
  const res = await fetch(`${apiBase()}/api/trips/${encodeURIComponent(tripId)}/coach${refresh ? '?refresh=1' : ''}`, { method: 'POST' });
  if (!res.ok) throw new Error(`server ${res.status}`);
  return res.json();
}
