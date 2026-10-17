// Per-device settings and calibrations, kept in localStorage.
const KEY = 'cogniroute.settings.v1';

export const DEFAULT_SETTINGS = {
  driverId: null,
  driverName: '',
  consent: false,
  cameraMode: 'both', // both | road | driver | none
  quality: 'fast', // fast: 320 px frames, quality: 640 px (needs a fast phone or WebGPU)
  hfovDeg: 63,
  horizon: 0.5,
  hood: 0.92,
  centerX: 0.5,
  defaultLimit: 50,
  osmLimits: true,
  voice: true,
  serverUrl: '',
  gazeCalibration: null,
  blinkerTemplate: null,
  mountDone: false,
  greenWaveDemo: false, // use the Skopje demo signal corridor in a normal drive
  signals: [], // user-provided fixed-time signals for the green wave
};

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    stored = {};
  }
  cache = { ...DEFAULT_SETTINGS, ...stored };
  if (!cache.driverId) {
    cache.driverId = `drv-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    persist();
  }
  return cache;
}

export function saveSettings(patch) {
  cache = { ...loadSettings(), ...patch };
  persist();
  return cache;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // private mode / storage full: settings live for this session only
  }
}

export function apiBase() {
  const url = loadSettings().serverUrl?.trim();
  return url ? url.replace(/\/$/, '') : '';
}
