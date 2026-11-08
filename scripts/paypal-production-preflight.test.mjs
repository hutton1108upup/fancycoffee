import assert from 'node:assert/strict';
import test from 'node:test';
import { CALLBACK_URL, REQUIRED_EVENTS, main, runProductionPreflight, validateConfig } from './paypal-production-preflight.mjs';

const config = { environment: 'production', clientId: 'client', clientSecret: 'secret', merchantId: 'merchant', webhookId: 'webhook', webhookUrl: CALLBACK_URL };
const events = REQUIRED_EVENTS.map((name) => ({ name }));

function fetchMock({ tokenStatus = 200, webhookStatus = 200, webhook = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'hidden-token' }), { status: tokenStatus });
    return new Response(JSON.stringify(webhook), { status: webhookStatus });
  };
  return { fetchImpl, calls };
}

test('rejects missing config, wrong environment, and wrong callback without network', async () => {
  assert.equal(validateConfig(null).code, 'invalid_environment');
  assert.equal(validateConfig({ ...config, environment: 'test' }).code, 'invalid_environment');
  assert.equal(validateConfig({ ...config, webhookUrl: 'https://evil.example/callback' }).code, 'callback_url_mismatch');
  const mock = fetchMock();
  const result = await runProductionPreflight({ ...config, webhookUrl: 'https://evil.example/callback' }, { fetchImpl: mock.fetchImpl });
  assert.equal(result.exitCode, 1); assert.equal(mock.calls.length, 0);
});

test('fails safely on OAuth HTTP errors without exposing token or config', async () => {
  const result = await runProductionPreflight(config, { fetchImpl: fetchMock({ tokenStatus: 401 }).fetchImpl });
  assert.equal(result.ok, false); assert.equal(result.status, 401); assert.equal('clientSecret' in result, false); assert.equal('access_token' in result, false);
});

test('main without arguments returns exit code 2 and missing fields fail closed', async () => {
  assert.equal(await main([], fetchMock().fetchImpl), 2);
  const result = await runProductionPreflight({ environment: 'production', clientId: 'client' }, { fetchImpl: fetchMock().fetchImpl });
  assert.equal(result.code, 'invalid_config'); assert.equal(result.exitCode, 2);
});

test('network errors expose only a safe code and never response secrets', async () => {
  const result = await runProductionPreflight(config, { fetchImpl: async () => { throw new Error('secret-token-body-should-not-appear'); } });
  const serialized = JSON.stringify(result);
  assert.equal(result.error, 'network_error'); assert.equal(serialized.includes('secret-token-body-should-not-appear'), false); assert.equal(serialized.includes('clientSecret'), false);
});

test('accepts exact webhook URL and seven events without creating payment requests', async () => {
  const mock = fetchMock({ webhook: { id: 'webhook', url: CALLBACK_URL, event_types: events } });
  const result = await runProductionPreflight(config, { fetchImpl: mock.fetchImpl });
  assert.equal(result.ok, true); assert.equal(result.merchantOwnershipVerified, false); assert.deepEqual(result.missingEvents, []); assert.deepEqual(result.unexpectedEvents, []); assert.equal(mock.calls.length, 2); assert.match(mock.calls[0].url, /oauth2\/token$/); assert.match(mock.calls[1].url, /notifications\/webhooks\/webhook$/); assert.equal(mock.calls.some((call) => call.url.includes('/orders') || call.url.includes('/capture') || call.url.includes('/refund')), false);
});

test('rejects webhook mismatch, unexpected event, and redirect responses', async () => {
  const mismatch = await runProductionPreflight(config, { fetchImpl: fetchMock({ webhook: { id: 'other', url: CALLBACK_URL, event_types: events } }).fetchImpl });
  assert.equal(mismatch.ok, false); assert.equal(mismatch.webhookIdMatches, false);
  const unexpected = await runProductionPreflight(config, { fetchImpl: fetchMock({ webhook: { id: 'webhook', url: CALLBACK_URL, event_types: [...events, { name: 'PAYMENT.CAPTURE.REVERSED_EXTRA' }] } }).fetchImpl });
  assert.equal(unexpected.ok, false); assert.deepEqual(unexpected.unexpectedEvents, ['PAYMENT.CAPTURE.REVERSED_EXTRA']);
  const redirect = await runProductionPreflight(config, { fetchImpl: async (url) => new Response(null, { status: url.endsWith('/oauth2/token') ? 302 : 200, headers: { location: 'https://evil.example' } }) });
  assert.equal(redirect.ok, false); assert.equal(redirect.status, 302);
});
