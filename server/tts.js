// Macedonian text-to-speech through Azure AI Speech (neural voices
// mk-MK-MarijaNeural and mk-MK-AleksandarNeural). Phones rarely ship a
// Macedonian voice, so the app plays these recordings instead. Results are
// cached on disk, so each sentence is synthesized only once.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_VOICE = 'mk-MK-MarijaNeural';

const escapeXml = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

export function createTts({
  key = process.env.AZURE_SPEECH_KEY,
  region = process.env.AZURE_SPEECH_REGION,
  voice = process.env.AZURE_SPEECH_VOICE || DEFAULT_VOICE,
  cacheDir = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const enabled = !!(key && region);
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });

  /** MP3 audio (Buffer) for a Macedonian sentence. */
  async function synth(text) {
    if (!enabled) throw new Error('TTS not configured (AZURE_SPEECH_KEY, AZURE_SPEECH_REGION)');
    const file = cacheDir && join(cacheDir, `${createHash('sha1').update(`${voice}|${text}`).digest('hex')}.mp3`);
    if (file && existsSync(file)) return readFileSync(file);
    const ssml = `<speak version="1.0" xml:lang="mk-MK"><voice name="${voice}"><prosody rate="+5%">${escapeXml(text)}</prosody></voice></speak>`;
    const res = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'CogniRouteAI',
      },
      body: ssml,
    });
    if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (file) writeFileSync(file, audio);
    return audio;
  }

  return { enabled, voice, synth };
}
