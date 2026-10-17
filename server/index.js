// Starts the CogniRouteAI server: API on /api, website on / and /dashboard,
// mobile app on /app/ (the last two need `npm run build` first).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, lanUrls } from './app.js';
import { createCoach } from './coach.js';
import { openDb } from './db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // no .env file
}

const port = Number(process.env.PORT ?? 3000);
const db = openDb(process.env.DB_FILE ?? join(ROOT, 'server', 'data', 'cogniroute.db'));
const { coach, aiEnabled, model } = createCoach();
const app = createApp({ db, coach, aiEnabled, model, port });

app.listen(port, '0.0.0.0', () => {
  console.log(`CogniRouteAI server: http://localhost:${port}`);
  for (const url of lanUrls(port)) console.log(`  на мрежата: ${url}`);
  console.log(aiEnabled ? `AI совети: Claude (${model})` : 'AI совети: според правила (постави ANTHROPIC_API_KEY за Claude)');
});
