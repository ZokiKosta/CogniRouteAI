// Driver camera: MediaPipe Face Landmarker -> head pose, eye gaze, blinks.
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { extractFaceFeatures } from '../../../shared/gaze.js';

export class DriverVision {
  constructor() {
    this.landmarker = null;
    this.timer = null;
    this.stats = { fps: 0, delegate: null };
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe');
    const options = {
      baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    };
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options);
      this.stats.delegate = 'GPU';
    } catch {
      options.baseOptions.delegate = 'CPU';
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options);
      this.stats.delegate = 'CPU';
    }
    return this.stats;
  }

  /** Calls onFeatures(features | null, rawResult) about `fps` times per second. */
  start(video, onFeatures, fps = 12) {
    this.video = video;
    let last = performance.now();
    this.timer = setInterval(() => {
      if (!this.landmarker || video.readyState < 2) return;
      const now = performance.now();
      let result = null;
      try {
        result = this.landmarker.detectForVideo(video, now);
      } catch {
        return;
      }
      this.stats.fps = 0.8 * this.stats.fps + 0.2 * (1000 / Math.max(1, now - last));
      last = now;
      onFeatures(extractFaceFeatures(result), result);
    }, 1000 / fps);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  close() {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
  }
}
