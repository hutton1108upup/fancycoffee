import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const API_ORIGIN = 'https://api-m.paypal.com';
export const CALLBACK_URL = 'https://fancycafeaivideo.pro/api/paypal/webhook/production';
export const REQUIRED_EVENTS = Object.freeze([
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
]);

function failure(error, details = {}) {
  return Object.assign(new Error(error), { code: error }, details);
}

export function validateConfig(config) {
  if (!config || (config.environment !== 'production' && config.environment !== 'live')) return { ok: false, code: 'invalid_environment' };
  const required = ['clientId', 'clientSecret', 'merchantId', 'webhookId', 'webhookUrl'];
  if (!required.every((key) => typeof config[key] === 'string' && config[key].length > 0)) return { ok: false, code: 'invalid_config' };
  if (config.webhookUrl !== CALLBACK_URL) return { ok: false, code: 'callback_url_mismatch' };
  return { ok: true };
}

async function responseError(response) {
  try { await response.json(); } catch { return { status: response.status, error: 'invalid_response' }; }
  return { status: response.status, error: 'http_error' };
}

async function paypalFetch(fetchImpl, url, options = {}) {
  let response;
  try { response = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(10_000) }); }
  catch (error) { throw failure(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network_error'); }
  if (!response.ok || response.status >= 300) throw failure('paypal_request_failed', await responseError(response));
  return response;
}

export async function runProductionPreflight(config, { fetchImpl = globalThis.fetch } = {}) {
  const valid = validateConfig(config);
  if (!valid.ok) return { ok: false, code: valid.code, exitCode: valid.code === 'invalid_config' || valid.code === 'invalid_environment' ? 2 : 1 };
  try {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64');
    const tokenResponse = await paypalFetch(fetchImpl, `${API_ORIGIN}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: 'grant_type=client_credentials' });
    const tokenBody = await tokenResponse.json().catch(() => null);
    if (typeof tokenBody?.access_token !== 'string' || tokenBody.access_token.length === 0) throw failure('invalid_response', { status: tokenResponse.status });
    const webhookResponse = await paypalFetch(fetchImpl, `${API_ORIGIN}/v1/notifications/webhooks/${encodeURIComponent(config.webhookId)}`, { headers: { authorization: `Bearer ${tokenBody.access_token}`, accept: 'application/json' } });
    const webhook = await webhookResponse.json().catch(() => null);
    if (!webhook || typeof webhook !== 'object') throw failure('invalid_response', { status: webhookResponse.status });
    const eventNames = Array.isArray(webhook.event_types) ? webhook.event_types.map((item) => item?.name).filter((name) => typeof name === 'string') : [];
    const missingEvents = REQUIRED_EVENTS.filter((eventName) => !eventNames.includes(eventName));
    const unexpectedEvents = eventNames.filter((eventName) => !REQUIRED_EVENTS.includes(eventName));
    const result = { ok: webhook.id === config.webhookId && webhook.url === CALLBACK_URL && missingEvents.length === 0 && unexpectedEvents.length === 0, live: true, tokenValid: true, webhookHttpStatus: webhookResponse.status, webhookIdMatches: webhook.id === config.webhookId, webhookUrlMatches: webhook.url === CALLBACK_URL, merchantOwnershipVerified: false, eventNames, missingEvents, unexpectedEvents };
    return { ...result, exitCode: result.ok ? 0 : 1 };
  } catch (error) {
    return { ok: false, exitCode: 1, status: Number.isInteger(error?.status) ? error.status : null, error: typeof error?.code === 'string' ? error.code : 'request_failed' };
  }
}

export async function main(argv = process.argv.slice(2), fetchImpl = globalThis.fetch) {
  if (argv.includes('--help')) { console.log('Usage: node scripts/paypal-production-preflight.mjs <production-config-json>'); return 0; }
  const file = argv[0];
  if (!file || argv.length !== 1) { console.log(JSON.stringify({ ok: false, error: 'config_path_required' })); return 2; }
  let config;
  try { config = JSON.parse(await readFile(resolve(file), 'utf8')); } catch { console.log(JSON.stringify({ ok: false, error: 'invalid_config' })); return 2; }
  const result = await runProductionPreflight(config, { fetchImpl });
  console.log(JSON.stringify(result));
  return result.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) process.exitCode = await main();
