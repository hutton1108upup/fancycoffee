import test from 'node:test';
import assert from 'node:assert/strict';
import { createApimartSeedanceClient, estimate, estimateCostUsd, normalizeGenerationRequest, requestHash } from './apimart-seedance.mjs';
const lead = { url: 'asset://approved-lead' };
test('builds the official APIMart model payload without local metadata', () => {
  const result = estimate({ style: 'closer', resolution: '720p', lead, regular: { url: 'https://example.test/regular.jpg' } });
  assert.equal(result.payload.model, 'seedance-2.0');
  assert.equal(result.payload.size, '9:16'); assert.equal(result.payload.duration, 15);
  assert.deepEqual(result.payload.image_urls, [lead.url, 'https://example.test/regular.jpg']);
  assert.match(result.payload.prompt, /fancy cafe/); assert.match(result.payload.prompt, /real people identities/);
  assert.equal('meta' in result.payload, false); assert.equal(result.dryRun, true);
  assert.equal(estimateCostUsd('480p'), 0.99); assert.equal(estimateCostUsd('720p'), 2.13);
});
test('requires one lead photo and recognizes only URL or asset references', () => {
  assert.throws(() => normalizeGenerationRequest({ style: 'standard', resolution: '480p' }), { code: 'LEAD_PHOTO_REQUIRED' });
  assert.throws(() => normalizeGenerationRequest({ style: 'standard', resolution: '480p', lead: { url: 'file:///tmp/a.jpg' } }), { code: 'LEAD_PHOTO_REQUIRED' });
  assert.throws(() => normalizeGenerationRequest({ style: 'standard', resolution: '480p', lead: { url: 'asset://bad path' } }), { code: 'LEAD_PHOTO_REQUIRED' });
});
test('fails closed by default: no client path can perform a paid request', async () => {
  const client = createApimartSeedanceClient();
  const prepared = client.prepare({ style: 'standard', resolution: '480p', lead });
  assert.equal(prepared.dryRun, true);
  await assert.rejects(() => client.submit({ style: 'standard', resolution: '480p', lead }), { code: 'REAL_RUN_NOT_AUTHORIZED' });
  await assert.rejects(() => client.getTask('task_123'), { code: 'REAL_RUN_NOT_AUTHORIZED' });
});

test('authorized mock submission sends only provider fields and parses task ID', async () => {
  const calls = [];
  const input = { style: 'standard', resolution: '480p', lead };
  const quote = { currency: 'CNY', amountCny: 8, expiresAt: '2099-01-01T00:00:00Z', requestHash: requestHash(normalizeGenerationRequest(input)) };
  const client = createApimartSeedanceClient({ apiKey: 'test-key', accountConfirmed: true, configVerified: true, explicitRun: true, cnyQuote: quote, fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ data: [{ status: 'submitted', task_id: 'task_123' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const result = await client.submit(input);
  assert.equal(result.taskId, 'task_123'); assert.equal(client.state, 'submitted');
  const body = JSON.parse(calls[0].options.body); assert.equal(body.model, 'seedance-2.0'); assert.equal('meta' in body, false); assert.equal('quote' in body, false);
  await assert.rejects(() => client.submit(input), { code: 'ALREADY_SUBMITTED' });
});

test('rejects missing, expired, or over-limit CNY quotes', async () => {
  const base = { apiKey: 'test-key', accountConfirmed: true, configVerified: true, explicitRun: true, fetchImpl: async () => { throw new Error('must not call'); } };
  for (const cnyQuote of [undefined, { currency: 'CNY', amountCny: 8.01, expiresAt: '2099-01-01T00:00:00Z' }, { currency: 'CNY', amountCny: 8, expiresAt: '2020-01-01T00:00:00Z' }]) await assert.rejects(() => createApimartSeedanceClient({ ...base, cnyQuote }).submit({ style: 'standard', resolution: '480p', lead }), { code: 'REAL_RUN_NOT_AUTHORIZED' });
});

test('marks timeout or 5xx unknown and forbids retry', async () => {
  let calls = 0;
  const input = { style: 'standard', resolution: '480p', lead };
  const client = createApimartSeedanceClient({ apiKey: 'test-key', accountConfirmed: true, configVerified: true, explicitRun: true, cnyQuote: { currency: 'CNY', amountCny: 1, expiresAt: '2099-01-01T00:00:00Z', requestHash: requestHash(normalizeGenerationRequest(input)) }, fetchImpl: async () => { calls += 1; return new Response('{}', { status: 503 }); } });
  await assert.rejects(() => client.submit(input), { code: 'PROVIDER_UNKNOWN' });
  assert.equal(client.state, 'unknown'); assert.equal(calls, 1);
  await assert.rejects(() => client.submit(input), { code: 'UNCERTAIN_NO_RETRY' }); assert.equal(calls, 1);
});

test('quote is bound to exact normalized request', async () => {
  const first = { style: 'standard', resolution: '480p', lead }; const second = { ...first, resolution: '720p' };
  const client = createApimartSeedanceClient({ apiKey: 'test-key', accountConfirmed: true, configVerified: true, explicitRun: true, cnyQuote: { currency: 'CNY', amountCny: 1, expiresAt: '2099-01-01T00:00:00Z', requestHash: requestHash(normalizeGenerationRequest(first)) }, fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(() => client.submit(second), { code: 'QUOTE_MISMATCH' });
});

test('concurrent submits lock before await and malformed 2xx is uncertain', async () => {
  const input = { style: 'standard', resolution: '480p', lead }; const quote = { currency: 'CNY', amountCny: 1, expiresAt: '2099-01-01T00:00:00Z', requestHash: requestHash(normalizeGenerationRequest(input)) };
  let release; const pending = new Promise((resolve) => { release = resolve; }); let calls = 0;
  const client = createApimartSeedanceClient({ apiKey: 'test-key', accountConfirmed: true, configVerified: true, explicitRun: true, cnyQuote: quote, fetchImpl: async () => { calls += 1; await pending; return new Response('{bad', { status: 200 }); } });
  const first = client.submit(input); await assert.rejects(() => client.submit(input), { code: 'SUBMISSION_IN_PROGRESS' }); release(); await assert.rejects(() => first, { code: 'PROVIDER_UNKNOWN' }); assert.equal(client.state, 'unknown'); assert.equal(calls, 1);
});
