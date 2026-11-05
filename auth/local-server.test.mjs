import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

test('local HTTP auth boundary and static allowlist', async (t) => {
  const port = 18766;
  const child = spawn(process.execPath, ['local-server.mjs'], { cwd: dirname(dirname(fileURLToPath(import.meta.url))), env: { ...process.env, PORT: String(port), GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REDIRECT_URI: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 5000); child.stdout.on('data', (chunk) => { if (String(chunk).includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } }); child.on('error', reject); });
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`); assert.equal(health.status, 200); assert.equal((await health.json()).providers.auth, 'unconfigured');
  const start = await fetch(`${base}/auth/google/start`); assert.equal(start.status, 503); assert.equal((await start.json()).code, 'AUTH_CONFIGURATION_MISSING');
  assert.equal((await fetch(`${base}/auth/google.mjs`)).status, 404);
  const logout = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.example' } }); assert.equal(logout.status, 403); assert.equal((await fetch(`${base}/auth/me`, { headers: { cookie: '%broken=%%' } })).status, 200);
  assert.equal((await fetch(`${base}/index.html`)).status, 200);
  assert.equal((await fetch(`${base}/about/`)).status, 200);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
});
