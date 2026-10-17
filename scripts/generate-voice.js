// Records every phrase of shared/voice-phrases.js with a Macedonian Azure
// voice into public/voice/mk/, so the app speaks Macedonian offline.
// Usage: AZURE_SPEECH_KEY=... AZURE_SPEECH_REGION=westeurope npm run voice
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHRASES } from '../shared/voice-phrases.js';
import { createTts } from '../server/tts.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(root, '.env'));
} catch {
  // no .env
}

const tts = createTts();
if (!tts.enabled) {
  console.error('Постави AZURE_SPEECH_KEY и AZURE_SPEECH_REGION (во .env или во терминалот).');
  process.exit(1);
}
const out = join(root, 'public', 'voice', 'mk');
mkdirSync(out, { recursive: true });
const manifest = { voice: tts.voice, phrases: {} };
for (const [key, text] of Object.entries(PHRASES)) {
  const file = `${key}.mp3`;
  writeFileSync(join(out, file), await tts.synth(text));
  manifest.phrases[key] = { file, text };
  console.log(`✓ ${key}: ${text}`);
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`${Object.keys(manifest.phrases).length} фрази во ${out}`);
