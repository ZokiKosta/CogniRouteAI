// Copies the WebAssembly runtimes the app loads at run time (onnxruntime-web
// for YOLOv8, MediaPipe for the driver camera) from node_modules into
// public/vendor, so they are served from our own origin. Runs on `npm install`.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'public', 'vendor');

const sources = [
  {
    // The default `onnxruntime-web` build (JSEP) runs on WebGPU and on plain WASM.
    from: join(root, 'node_modules', 'onnxruntime-web', 'dist'),
    to: join(vendor, 'ort'),
    keep: (name) => /^ort-wasm-simd-threaded\.jsep\.(wasm|mjs)$/.test(name),
  },
  {
    // Classic-script loader with and without SIMD (FilesetResolver picks one).
    from: join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
    to: join(vendor, 'mediapipe'),
    keep: (name) => /^vision_wasm_(nosimd_)?internal\.(js|wasm)$/.test(name),
  },
];

for (const { from, to, keep } of sources) {
  if (!existsSync(from)) {
    console.warn(`[copy-vendor] skipped, not installed: ${from}`);
    continue;
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const files = readdirSync(from).filter(keep);
  for (const file of files) cpSync(join(from, file), join(to, file));
  console.log(`[copy-vendor] ${files.length} files -> ${to}`);
}
