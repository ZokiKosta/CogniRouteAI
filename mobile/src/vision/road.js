// Road camera pipeline on the main thread: grabs downscaled frames for the
// worker, tracks lane lines over time, judges distances/pedestrians/STOP
// signs and draws the overlay (boxes, lane lines, distance to the car ahead).
import { LaneTracker } from '../../../shared/vision/lanes.js';
import { RoadRiskMonitor } from '../../../shared/vision/road-risk.js';
import { ROAD_CLASSES, VEHICLE_CLASSES, VULNERABLE_CLASSES } from '../../../shared/vision/yolo.js';

export class RoadVision {
  constructor({ settings, onLaneChange = () => {}, onEvent = () => {}, onAlert = () => {}, getSpeed = () => null, getWhere = () => ({}) }) {
    this.settings = settings;
    this.getSpeed = getSpeed;
    this.getWhere = getWhere;
    this.tracker = new LaneTracker({ onLaneChange, options: { centerX: settings.centerX } });
    this.risk = new RoadRiskMonitor({ onEvent, onAlert, camera: this.camera() });
    this.worker = null;
    this.busy = false;
    this.latest = null;
    this.frameId = 0;
    this.stats = { fps: 0, inferMs: 0, backend: null, frames: 0 };
    this.running = false;
  }

  camera() {
    const s = this.settings;
    return { hfovDeg: s.hfovDeg, horizon: s.horizon, hood: s.hood, centerX: s.centerX };
  }

  frameWidth() {
    return this.settings.quality === 'quality' ? 640 : 320;
  }

  /** Loads the model in the worker; resolves with { backend, threads }. */
  init({ timeoutMs = 90000 } = {}) {
    this.worker = new Worker(new URL('./road.worker.js', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Моделот YOLOv8 не се вчита навреме.')), timeoutMs);
      this.worker.onmessage = (e) => {
        if (e.data.type === 'ready') {
          clearTimeout(timer);
          this.stats.backend = e.data.backend;
          this.stats.laneModel = e.data.laneModel;
          this.worker.onmessage = (ev) => this.onMessage(ev.data);
          resolve(e.data);
        } else if (e.data.type === 'error') {
          clearTimeout(timer);
          reject(new Error(e.data.message));
        }
      };
      this.worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || 'worker error'));
      };
      this.worker.postMessage({
        type: 'init',
        modelUrl: '/models/yolov8n.onnx',
        metaUrl: '/models/yolov8n.json',
        laneModelUrl: '/models/lanes.onnx',
        laneMetaUrl: '/models/lanes.json',
        wasmPath: '/vendor/ort/',
        webgpu: true, // falls back to WebAssembly when the phone has no WebGPU
        lanes: { horizon: this.settings.horizon, hood: this.settings.hood },
      });
    });
  }

  configure(settings) {
    this.settings = { ...this.settings, ...settings };
    this.tracker.configure({ centerX: this.settings.centerX });
    this.risk.configure(this.camera());
    this.worker?.postMessage({ type: 'config', lanes: { horizon: this.settings.horizon, hood: this.settings.hood } });
  }

  start(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.running = true;
    this.canvasEl = document.createElement('canvas');
    this.ctx2d = this.canvasEl.getContext('2d', { willReadFrequently: true });
    const loop = () => {
      if (!this.running) return;
      this.grab();
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.worker?.terminate();
    this.worker = null;
  }

  grab() {
    const v = this.video;
    if (this.busy || !this.worker || !v || v.readyState < 2 || !v.videoWidth) return;
    const w = this.frameWidth();
    const h = Math.round((w * v.videoHeight) / v.videoWidth / 2) * 2;
    if (this.canvasEl.width !== w || this.canvasEl.height !== h) {
      this.canvasEl.width = w;
      this.canvasEl.height = h;
    }
    this.ctx2d.drawImage(v, 0, 0, w, h);
    const { data } = this.ctx2d.getImageData(0, 0, w, h);
    this.busy = true;
    this.sentAt = performance.now();
    this.worker.postMessage({ type: 'frame', id: ++this.frameId, t: Date.now(), width: w, height: h, buffer: data.buffer }, [data.buffer]);
  }

  onMessage(msg) {
    if (msg.type === 'frame-error') {
      this.busy = false;
      return;
    }
    if (msg.type !== 'result') return;
    this.busy = false;
    const now = performance.now();
    const dt = now - (this.lastResultAt ?? now - 1000);
    this.lastResultAt = now;
    this.stats.fps = 0.8 * this.stats.fps + 0.2 * (1000 / Math.max(1, dt));
    this.stats.inferMs = msg.inferMs;
    this.stats.frames++;
    const speed = this.getSpeed();
    this.tracker.update(msg.t, msg.lanes.lines, msg.width, speed);
    const lane = this.tracker.egoLane(msg.width);
    this.risk.update(msg.t, { detections: msg.detections, frameW: msg.width, frameH: msg.height, lane, speed, where: this.getWhere() });
    this.latest = msg;
  }

  /** Maps frame coordinates to the on-screen <video> (object-fit: cover). */
  mapper() {
    const v = this.video;
    const el = this.canvas;
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(rect.width * dpr) || el.height !== Math.round(rect.height * dpr)) {
      el.width = Math.round(rect.width * dpr);
      el.height = Math.round(rect.height * dpr);
    }
    const fw = this.latest.width;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const scale = Math.max(rect.width / vw, rect.height / vh) * dpr;
    const ox = (rect.width * dpr - vw * scale) / 2;
    const oy = (rect.height * dpr - vh * scale) / 2;
    const k = (vw / fw) * scale;
    return { x: (x) => ox + x * k, y: (y) => oy + y * k, k, dpr };
  }

  draw() {
    const ctx = this.canvas?.getContext('2d');
    if (!ctx || !this.latest || !this.video?.videoWidth) return;
    const m = this.mapper();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.lineJoin = 'round';
    const font = Math.round(13 * m.dpr);

    for (const tr of this.tracker.tracks) {
      if (tr.missed > 2 || tr.top == null) continue;
      const solid = tr.type === 'solid';
      ctx.strokeStyle = solid ? 'rgba(255, 92, 92, 0.95)' : tr.type === 'dashed' ? 'rgba(255, 255, 255, 0.9)' : 'rgba(180, 190, 200, 0.6)';
      ctx.lineWidth = (solid ? 5 : 3) * m.dpr;
      ctx.setLineDash(tr.type === 'dashed' ? [14 * m.dpr, 12 * m.dpr] : []);
      ctx.beginPath();
      ctx.moveTo(m.x(tr.xt), m.y(tr.top));
      ctx.lineTo(m.x(tr.xb), m.y(tr.bottom));
      ctx.stroke();
      if (tr.type !== 'unknown') {
        ctx.setLineDash([]);
        ctx.font = `600 ${font}px system-ui, sans-serif`;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(solid ? 'полна' : 'испрекината', m.x((tr.xt + tr.xb) / 2) + 6 * m.dpr, m.y((tr.top + tr.bottom) / 2));
      }
    }
    ctx.setLineDash([]);

    const lead = this.risk.state.lead;
    for (const d of this.latest.detections) {
      const [x1, y1, x2, y2] = d.box;
      const isLead = lead && lead.box === d.box;
      const color = VULNERABLE_CLASSES.has(d.cls) ? '#ff5c5c' : VEHICLE_CLASSES.has(d.cls) ? (isLead ? '#ffc94d' : '#4dd2ff') : d.cls === 'stop sign' ? '#ff5c5c' : '#ffe066';
      ctx.strokeStyle = color;
      ctx.lineWidth = (isLead ? 4 : 2.5) * m.dpr;
      ctx.strokeRect(m.x(x1), m.y(y1), m.x(x2) - m.x(x1), m.y(y2) - m.y(y1));
      let label = ROAD_CLASSES[d.cls] ?? d.cls;
      if (isLead && lead.distance) label += ` · ${Math.round(lead.distance)} m${lead.headway ? ` · ${lead.headway.toFixed(1)} s` : ''}`;
      ctx.font = `600 ${font}px system-ui, sans-serif`;
      const tw = ctx.measureText(label).width + 10 * m.dpr;
      ctx.fillStyle = color;
      ctx.fillRect(m.x(x1), m.y(y1) - font - 8 * m.dpr, tw, font + 8 * m.dpr);
      ctx.fillStyle = '#0b1726';
      ctx.fillText(label, m.x(x1) + 5 * m.dpr, m.y(y1) - 6 * m.dpr);
    }

    // Car centre line marker at the bottom of the road area.
    const fw = this.latest.width;
    const fh = this.latest.height;
    ctx.strokeStyle = 'rgba(61, 220, 151, 0.9)';
    ctx.lineWidth = 3 * m.dpr;
    const cx = m.x(fw * this.settings.centerX);
    const by = m.y(fh * this.settings.hood);
    ctx.beginPath();
    ctx.moveTo(cx, by);
    ctx.lineTo(cx, by - 18 * m.dpr);
    ctx.stroke();
  }
}
