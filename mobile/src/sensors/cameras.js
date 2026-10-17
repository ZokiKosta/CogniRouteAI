// Road camera (rear, looks through the windshield) and driver camera
// (front/selfie, looks at the driver). Many phones can only run one camera
// at a time; then the setting decides which one is used.

const ROAD = { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
const DRIVER = { facingMode: { ideal: 'user' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (stream) => stream?.getVideoTracks().some((t) => t.readyState === 'live');

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * mode: 'both' | 'road' | 'driver' | 'none'. Resolves to
 * { road, driver, note } where a missing camera is null and `note` explains why.
 */
export async function openCameras(mode) {
  if (mode === 'none' || !navigator.mediaDevices?.getUserMedia) return { road: null, driver: null, note: null };
  let road = null;
  let driver = null;
  let note = null;
  if (mode === 'both' || mode === 'road') {
    road = await navigator.mediaDevices.getUserMedia({ video: ROAD, audio: false });
  }
  if (mode === 'both' || mode === 'driver') {
    try {
      driver = await navigator.mediaDevices.getUserMedia({ video: DRIVER, audio: false });
    } catch (err) {
      if (mode === 'driver') throw err;
      note = 'Телефонот не дозволува две камери истовремено – се користи само камерата кон патот.';
    }
    if (road && driver) {
      await sleep(700);
      if (!alive(road)) {
        // Opening the selfie camera stopped the rear one: keep the road camera.
        stopStream(driver);
        driver = null;
        stopStream(road);
        road = await navigator.mediaDevices.getUserMedia({ video: ROAD, audio: false });
        note = 'Телефонот не дозволува две камери истовремено – се користи само камерата кон патот.';
      }
    }
  }
  return { road, driver, note };
}

/** Plays a stream (or a video file URL) in a <video> element and waits until frames arrive. */
export async function attach(video, source) {
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  if (typeof source === 'string') {
    video.srcObject = null;
    video.src = source;
    video.loop = true;
  } else {
    video.srcObject = source;
  }
  await video.play().catch(() => {});
  if (video.readyState < 2) await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
  return video;
}
