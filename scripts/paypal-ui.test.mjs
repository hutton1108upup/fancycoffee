import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function loadBilling({ search = '', fetchImpl = async () => new Response('{}') } = {}) {
  const source = readFileSync(new URL('../local-studio.js', import.meta.url), 'utf8');
  const body = { prepend() {}, append() {} };
  const created = [];
  const document = { addEventListener() {}, querySelector(selector) { if (selector === '[data-testid="check-paypal-status"]') return created.find((node) => node.dataset.testid === 'check-paypal-status') || null; return null; }, createElement() { const node = { className: '', textContent: '', dataset: {}, append() {}, addEventListener() {}, disabled: false }; created.push(node); return node; }, body };
  const context = { document, window: { location: { origin: 'https://fancycafeaivideo.pro', href: `https://fancycafeaivideo.pro/pricing${search}`, pathname: '/pricing', search, hash: '' }, history: { replaceState(_state, _title, value) { const next = new URL(value, context.window.location.origin); context.window.location.href = next.href; context.window.location.pathname = next.pathname; context.window.location.search = next.search; context.window.location.hash = next.hash; } } }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, sessionStorage: { setItem() {}, getItem() { return null; }, removeItem() {} }, fetch: fetchImpl, console };
  vm.runInNewContext(source, context);
  Object.defineProperty(context.__fancyCafeBilling, '__search', { get: () => context.window.location.search });
  Object.defineProperty(context.__fancyCafeBilling, '__created', { get: () => created });
  Object.defineProperty(context.__fancyCafeBilling, '__context', { value: context });
  return context.__fancyCafeBilling;
}

test('PayPal approved URL is strict and mode-aware', () => {
  const billing = loadBilling();
  billing.configure({ packsResult: { provider: 'paypal', paymentMode: { provider: 'paypal', mode: 'test' } } });
  assert.equal(billing.allowedPaypalCheckoutUrl('https://www.sandbox.paypal.com/checkoutnow?token=abc'), true);
  assert.equal(billing.allowedPaypalCheckoutUrl('https://www.paypal.com/checkoutnow?token=abc'), false);
  assert.equal(billing.allowedPaypalCheckoutUrl('http://www.sandbox.paypal.com/checkoutnow?token=abc'), false);
  assert.equal(billing.allowedPaypalCheckoutUrl('https://www.sandbox.paypal.com.evil.example/checkoutnow?token=abc'), false);
  assert.equal(billing.allowedPaypalCheckoutUrl('https://www.sandbox.paypal.com:8443/checkoutnow?token=abc'), false);
  assert.equal(billing.allowedPaypalCheckoutUrl('https://www.sandbox.paypal.com/checkoutnow'), false);
});

test('PayPal live URL is accepted only in production mode', () => {
  const billing = loadBilling();
  billing.configure({ packsResult: { provider: 'paypal', paymentMode: { provider: 'paypal', mode: 'prod' } } });
  assert.equal(billing.allowedPaypalCheckoutUrl('https://www.paypal.com/checkoutnow?token=live-token'), true);
  assert.equal(billing.allowedPaypalCheckoutUrl('https://www.sandbox.paypal.com/checkoutnow?token=test-token'), false);
});

test('PayPal return captures the same order, cleans temporary params, and refreshes paid status', async () => {
  const calls = [];
  const app = loadBilling({ search: '?order=ORDER_1&paypal_return=1&token=browser-token&PayerID=payer', fetchImpl: async (url, options = {}) => { calls.push({ url, options }); if (url === '/api/paypal/capture') return new Response(JSON.stringify({ ok: true }), { status: 200 }); if (url.startsWith('/api/orders/')) return new Response(JSON.stringify({ ok: true, order: { orderId: 'ORDER_1', status: 'paid' } }), { status: 200 }); if (url === '/api/billing') return new Response(JSON.stringify({ ok: true, credits: 20 }), { status: 200 }); return new Response('{}', { status: 200 }); } });
  app.configure({ auth: { authenticated: true, user: { id: 'user-1' } }, csrfToken: 'csrf', packsResult: { provider: 'paypal', paymentMode: { provider: 'paypal', mode: 'test' } } });
  assert.equal(await app.handlePaypalReturn(), true);
  const capture = calls.find((call) => call.url === '/api/paypal/capture');
  assert.ok(capture);
  assert.deepEqual(JSON.parse(capture.options.body), { orderId: 'ORDER_1' });
  assert.equal(capture.options.headers['X-CSRF-Token'], 'csrf');
  assert.match(appContextSearch(app), /order=ORDER_1/);
  assert.doesNotMatch(appContextSearch(app), /token|PayerID|paypal_return/);
});

test('PayPal cancel checks existing order and never calls capture', async () => {
  const calls = [];
  const app = loadBilling({ search: '?order=ORDER_2&paypal_cancel=1&token=browser-token', fetchImpl: async (url) => { calls.push(url); if (url.startsWith('/api/orders/')) return new Response(JSON.stringify({ ok: true, order: { orderId: 'ORDER_2', status: 'paid' } }), { status: 200 }); return new Response('{}', { status: 200 }); } });
  app.configure({ auth: { authenticated: true, user: { id: 'user-1' } }, csrfToken: 'csrf', packsResult: { provider: 'paypal', paymentMode: { provider: 'paypal', mode: 'test' } } });
  assert.equal(await app.handlePaypalReturn(), true);
  assert.equal(calls.some((url) => url === '/api/paypal/capture'), false);
  assert.equal(calls.some((url) => url.startsWith('/api/orders/ORDER_2')), true);
});

test('failed PayPal capture exposes Check payment and retries the same order only after click', async () => {
  let captureAttempts = 0;
  const calls = [];
  const app = loadBilling({ search: '?order=ORDER_3&paypal_return=1', fetchImpl: async (url) => { calls.push(url); if (url === '/api/paypal/capture') { captureAttempts += 1; if (captureAttempts === 1) throw new Error('network'); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } if (url.startsWith('/api/orders/')) return new Response(JSON.stringify({ ok: true, order: { orderId: 'ORDER_3', status: captureAttempts > 1 ? 'paid' : 'pending' } }), { status: 200 }); return new Response('{}', { status: 200 }); } });
  app.configure({ auth: { authenticated: true, user: { id: 'user-1' } }, csrfToken: 'csrf', packsResult: { provider: 'paypal', paymentMode: { provider: 'paypal', mode: 'test' } } });
  await app.handlePaypalReturn();
  const check = app.__created.find((node) => node.dataset.testid === 'check-paypal-status');
  assert.ok(check);
  await check.onclick();
  assert.equal(calls.includes('/api/checkout'), false);
  assert.equal(calls.filter((url) => url === '/api/paypal/capture').length, 2);
  assert.equal(calls.filter((url) => url.startsWith('/api/orders/ORDER_3')).length >= 2, true);
});

function appContextSearch(app) { return app.__search; }
