// One drive: wires sensors -> detectors -> maneuver judge -> trip recorder,
// and turns warnings into short voice messages.
import { EVENT_TYPES } from '../../shared/events.js';
import { ManeuverJudge } from '../../shared/maneuvers.js';
import { MotionAnalyzer } from '../../shared/motion/analyzer.js';
import { SpeedMonitor } from '../../shared/motion/speed.js';
import { SpeedLimitService } from '../../shared/speed-limits.js';
import { DriverMonitor } from '../../shared/gaze.js';
import { TripRecorder } from '../../shared/trip.js';
import { makeEvent } from '../../shared/events.js';
import { watchMotion } from './sensors/motion.js';
import { simulateGps, watchGps } from './sensors/gps.js';
import { startAudioAnalysis } from './sensors/audio.js';
import { RoadVision } from './vision/road.js';
import { DriverVision } from './vision/driver.js';

// What the coach says out loud. {limit} is filled in for speeding.
const SAY = {
  harsh_brake: 'Нагло кочење. Гледај подалеку напред.',
  harsh_accel: 'Нежно со гасот.',
  harsh_corner: 'Намали брзина пред кривина.',
  solid_line_crossing: 'Полна линија! Не смее да се преминува.',
  lane_change_no_blinker: 'Мигавец пред менување лента.',
  turn_no_blinker: 'Мигавец пред свртување.',
  no_mirror_check: 'Погледни во ретровизор пред маневар.',
  reverse_no_check: 'При рикверц гледај назад.',
  stop_sign_violation: 'Кај знак стоп мора целосно да застанеш.',
  phone_use: 'Не користи телефон додека возиш.',
};
const ALERTS = {
  speeding: { text: 'Намали брзина. Ограничување {limit}.', cooldownMs: 45000 },
  tailgating: { text: 'Држи растојание, најмалку две секунди.', cooldownMs: 30000 },
  collision: { text: 'Внимание! Возило напред!', urgent: true, cooldownMs: 6000 },
  pedestrian: { text: 'Внимание, пешак!', urgent: true, cooldownMs: 8000 },
  animal: { text: 'Внимание, животно на патот!', urgent: true, cooldownMs: 8000 },
  siren: { text: 'Возило за итна помош! Тргни десно и направи простор.', urgent: true, cooldownMs: 20000 },
  distraction: { text: 'Гледај на патот!', urgent: true, cooldownMs: 10000 },
  drowsy: { text: 'Изгледаш поспано. Направи пауза.', urgent: true, cooldownMs: 30000 },
  break: { text: 'Време е за кратка пауза.', cooldownMs: 600000 },
};

export class DriveSession {
  /**
   * sources: { roadVideo, driverVideo, roadCanvas, micStream, demo: { speedKmh: () => n } }
   * hud: callbacks { onEvent(e), onAlert(a), onManeuver(m), onStatus(s) }
   */
  constructor({ settings, voice, hud = {} }) {
    this.settings = settings;
    this.voice = voice;
    this.hud = hud;
    this.stops = [];
    this.fix = null;
    this.limit = { limit: settings.defaultLimit, source: 'default' };
    this.blinkerOn = false;
    this.sirenActive = false;
  }

  get speed() {
    return this.fix && Date.now() - this.fix.t < 4000 ? this.fix.speed : null;
  }

  get where() {
    return this.fix ? { lat: this.fix.lat, lon: this.fix.lon } : {};
  }

  async start(sources) {
    const s = this.settings;
    const caps = {
      motion: !sources.demo && 'DeviceMotionEvent' in window,
      gps: true,
      roadCam: !!sources.roadVideo,
      driverCam: !!sources.driverVideo,
      audio: !!sources.micStream,
      demo: !!sources.demo,
    };
    this.caps = caps;
    this.recorder = new TripRecorder({
      driverId: s.driverId,
      driverName: s.driverName || null,
      capabilities: caps,
      settings: { hfovDeg: s.hfovDeg, quality: s.quality, cameraMode: s.cameraMode, gazeCalibrated: !!s.gazeCalibration, blinkerCalibrated: !!s.blinkerTemplate },
    });

    this.judge = new ManeuverJudge({
      onManeuver: (m) => {
        this.recorder.addManeuver(m);
        this.hud.onManeuver?.(m);
      },
      onEvent: (e) => this.event(e),
    });
    this.judge.setCapabilities({ audio: caps.audio, driverCam: caps.driverCam, calibratedGaze: !!s.gazeCalibration });
    const toJudge = (m) => this.judge.addManeuver({ ...this.where, ...m });

    this.motion = new MotionAnalyzer({ onEvent: (e) => this.event(e), onManeuver: toJudge, onStatus: (st) => this.hud.onStatus?.(st) });
    this.speedMonitor = new SpeedMonitor({
      onEvent: (e) => this.event(e),
      onAlert: (a) => this.alert({ kind: 'speeding', limit: a.limitKmh }),
    });
    this.limits = s.osmLimits && !sources.demo ? new SpeedLimitService() : null;

    if (caps.motion) this.stops.push(watchMotion((m) => this.motion.addMotion(m)));
    const onFix = (raw) => {
      this.motion.addGps(raw);
      // The analyzer fills in speed/heading when the phone does not report them.
      const fix = { ...raw, ...this.motion.fix };
      this.fix = fix;
      this.recorder.addFix(fix);
      if (this.limits) this.limits.update(fix).then((l) => l && (this.limit = l));
    };
    this.stops.push(sources.demo ? simulateGps(onFix, sources.demo.speedKmh) : watchGps(onFix, (err) => this.hud.onStatus?.({ type: 'gps_error', message: err.message })));

    if (caps.audio) {
      const audio = await startAudioAnalysis(sources.micStream, {
        blinkerTemplate: s.blinkerTemplate,
        onBlinker: (b) => {
          this.blinkerOn = b.on;
          this.judge.blinker(b);
          this.hud.onStatus?.({ type: 'blinker', on: b.on });
        },
        onSiren: (siren) => {
          this.sirenActive = true;
          this.event(makeEvent('emergency_vehicle', siren.t, { sirenType: siren.type, approaching: siren.approaching, source: 'audio' }));
          this.alert({ kind: 'siren' });
        },
        onSirenEnd: () => {
          this.sirenActive = false;
          this.hud.onStatus?.({ type: 'siren_end' });
        },
      });
      this.audio = audio;
      this.stops.push(() => audio.stop());
    }

    // The camera models take a while to load the first time (tens of MB);
    // sensors, GPS and the microphone already work in the meantime.
    this.ready = Promise.allSettled([caps.roadCam && this.startRoad(sources), caps.driverCam && this.startDriver(sources)]);

    this.ticker = setInterval(() => {
      const now = Date.now();
      this.judge.tick(now);
      this.speedMonitor.update(now, this.speed, this.limit?.limit, this.where);
    }, 1000);
    this.stops.push(() => clearInterval(this.ticker));
    this.startedAt = Date.now();
    return caps;
  }

  async startRoad(sources) {
    const caps = this.caps;
    this.road = new RoadVision({
      settings: this.settings,
      onLaneChange: (m) => this.judge.addManeuver({ ...this.where, ...m }),
      onEvent: (e) => this.event(e),
      onAlert: (a) => this.alert(a.kind === 'pedestrian' && a.cls !== 'person' && a.cls !== 'bicycle' ? { ...a, kind: 'animal' } : a),
      getSpeed: () => this.speed,
      getWhere: () => this.where,
    });
    try {
      const info = await this.road.init();
      if (this.stopped) return this.road.stop();
      this.road.start(sources.roadVideo, sources.roadCanvas);
      this.stops.push(() => this.road.stop());
      this.hud.onStatus?.({ type: 'road_ready', ...info });
    } catch (err) {
      this.road?.stop();
      this.road = null;
      caps.roadCam = false;
      this.hud.onStatus?.({ type: 'road_error', message: err.message });
    }
  }

  async startDriver(sources) {
    const caps = this.caps;
    this.driverMonitor = new DriverMonitor({
      calibration: this.settings.gazeCalibration,
      onEvent: (e) => this.event(e),
      onAlert: (a) => this.alert(a),
      onGaze: (t, zone) => this.judge.gaze(t, zone),
    });
    this.driver = new DriverVision();
    try {
      await this.driver.init();
      if (this.stopped) return this.driver.close();
      this.driver.start(sources.driverVideo, (features) => this.driverMonitor.update(Date.now(), features, this.speed, this.where));
      this.stops.push(() => this.driver.close());
      this.hud.onStatus?.({ type: 'driver_ready' });
    } catch (err) {
      this.driver.close();
      caps.driverCam = false;
      this.judge.setCapabilities({ driverCam: false });
      this.hud.onStatus?.({ type: 'driver_error', message: err.message });
    }
  }

  /** Taps on the screen while moving count as using the phone. */
  touched() {
    const v = this.speed;
    if (v != null && v > 3) this.event(makeEvent('phone_use', Date.now(), { speedKmh: Math.round(v * 3.6), detail: 'touch', source: 'app' }), { cooldownMs: 60000 });
  }

  event(e, { cooldownMs = 0 } = {}) {
    if (cooldownMs) {
      this.lastEventAt ??= {};
      if (Date.now() - (this.lastEventAt[e.type] ?? -Infinity) < cooldownMs) return;
      this.lastEventAt[e.type] = Date.now();
    }
    this.recorder.addEvent(e);
    this.hud.onEvent?.(e);
    const text = SAY[e.type];
    if (text) this.voice?.say(text, { key: e.type, cooldownMs: 20000 });
  }

  alert(a) {
    this.hud.onAlert?.(a);
    const spec = ALERTS[a.kind];
    if (!spec) return;
    this.voice?.say(spec.text.replace('{limit}', a.limit ?? this.limit?.limit ?? ''), { key: a.kind, cooldownMs: spec.cooldownMs, urgent: spec.urgent });
  }

  live() {
    return {
      speedKmh: this.speed != null ? Math.round(this.speed * 3.6) : null,
      limit: this.limit,
      ...this.recorder.live,
      motion: this.motion?.state,
      calibration: this.motion?.calibration,
      lead: this.road?.risk.state.lead,
      roadStats: this.road?.stats,
      gaze: this.driverMonitor?.state,
      blinker: this.blinkerOn,
      siren: this.sirenActive,
      audioLevel: this.audio?.analyzer.level,
    };
  }

  stop() {
    this.stopped = true;
    this.judge?.flush();
    this.speedMonitor?.flush();
    for (const stop of this.stops.splice(0)) {
      try {
        stop();
      } catch {
        // already stopped
      }
    }
    return this.recorder.finish();
  }
}

export const eventMeta = (type) => EVENT_TYPES[type] ?? { label: type, category: 'attention', penalty: 0 };
