import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const port = 18766 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['local-server.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function get(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

test('local server exposes only the read-only catalog boundary', async () => {
  try {
    await once(child.stdout, 'data');
    const result = await get('/api/credit-packs');
    assert.equal(result.status, 200);
    assert.equal(result.body.paymentMode, 'unconfigured');
    assert.deepEqual(result.body.packs.map(({ id, credits, amountCents, currency, billingType }) => ({ id, credits, amountCents, currency, billingType })), [
      { id: 'credits-20', credits: 20, amountCents: 999, currency: 'USD', billingType: 'one_time' },
      { id: 'credits-60', credits: 60, amountCents: 2499, currency: 'USD', billingType: 'one_time' },
      { id: 'credits-200', credits: 200, amountCents: 6999, currency: 'USD', billingType: 'one_time' },
    ]);

    const unknown = await get('/api/waffo/webhook');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'NOT_FOUND');

    const health = await get('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.providers.payments, 'unconfigured');
  } finally {
    child.kill();
  }
});
