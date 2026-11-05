import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const studio = readFileSync(new URL('../local-studio.js', import.meta.url), 'utf8');
const builder = readFileSync(new URL('./build-static.mjs', import.meta.url), 'utf8');
const storage = new Map();
const context = { document: { addEventListener() {}, querySelector() { return null; } }, URL, setTimeout, clearTimeout, sessionStorage: { setItem: (k, v) => storage.set(k, v), getItem: (k) => storage.get(k) || null, removeItem: (k) => storage.delete(k) }, console };
vm.runInNewContext(studio, context);
const billing = context.__fancyCafeBilling;

test('only approved HTTPS Waffo checkout hosts pass', () => {
  assert.equal(billing.allowedCheckoutUrl('https://checkout.waffo.ai/session/1'), true);
  assert.equal(billing.allowedCheckoutUrl('https://pancake.waffo.ai/session/1'), true);
  assert.equal(billing.allowedCheckoutUrl('http://checkout.waffo.ai/session/1'), false);
  assert.equal(billing.allowedCheckoutUrl('https://evil.example/session/1'), false);
});

test('order result only confirms paid or fulfilled', () => {
  assert.match(billing.renderOrderResult({ status: 'paid', packId: 'credits-20' }), /Payment confirmed/);
  assert.match(billing.renderOrderResult({ status: 'fulfilled' }), /Payment confirmed/);
  assert.match(billing.renderOrderResult({ status: 'pending' }), /not confirmed/);
  assert.match(billing.renderOrderResult({ status: 'checkout_unknown' }), /not confirmed/);
});

test('pending checkout reuses requestId and orderId', () => {
  billing.setPending({ packId: 'credits-20', requestId: 'same-request', orderId: 'order-1' });
  assert.equal(JSON.stringify(billing.getPending()), JSON.stringify({ packId: 'credits-20', requestId: 'same-request', orderId: 'order-1' }));
  billing.setPending(null);
  assert.equal(billing.getPending(), null);
});

test('static build injects the shared script once per HTML page', () => {
  assert.equal(builder.includes('function injectStudioScript'), true);
  assert.equal(builder.includes('injectStudioScript(readFileSync'), true);
  assert.equal(studio.includes('X-CSRF-Token'), true);
  assert.equal(studio.includes('/api/orders'), true);
});

function runtime({ fetchImpl, storageImpl = new Map() } = {}) {
  const listeners = [];
  const changeCounts = { lead: 0, regular: 0 };
  const inputs = { lead: { disabled: true, dataset: {}, removeAttribute() {}, addEventListener() { changeCounts.lead += 1; } }, regular: { disabled: true, dataset: {}, removeAttribute() {}, addEventListener() { changeCounts.regular += 1; } } };
  const eventCounts = { style: 0 };
  const status = { textContent: '' };
  const makeNode = () => ({ dataset: {}, style: {}, children: [], append(...items) { this.children.push(...items); }, prepend(...items) { this.children.unshift(...items); }, removeChild() {}, setAttribute() {}, removeAttribute() {}, closest() { return null; }, addEventListener() {}, className: '', textContent: '' });
  const standard = makeNode(); standard.addEventListener = () => { eventCounts.style += 1; };
  const closer = makeNode(); closer.addEventListener = () => { eventCounts.style += 1; };
  const document = { addEventListener(name, callback) { if (name === 'DOMContentLoaded') listeners.push(callback); }, getElementById(id) { return id === 'photo-lead' ? inputs.lead : inputs.regular; }, querySelector(selector) { return selector === '#service-status' ? status : selector === '[data-testid="video-style-standard"]' ? standard : selector === '[data-testid="video-style-closer"]' ? closer : null; }, querySelectorAll() { return []; }, createElement: makeNode, head: makeNode(), body: makeNode() };
  const storage = { setItem: (key, value) => { if (storageImpl.setItem) return storageImpl.setItem(key, value); storageImpl.set(key, value); }, getItem: (key) => { if (storageImpl.getItem) return storageImpl.getItem(key); return storageImpl.get(key) || null; }, removeItem: (key) => { if (storageImpl.removeItem) return storageImpl.removeItem(key); storageImpl.delete(key); } };
  const context = { document, window: { location: { pathname: '/', search: '', hash: '', assign() {} } }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, sessionStorage: storage, fetch: fetchImpl || (async () => ({ ok: false, status: 503, json: async () => ({}) })), console };
  vm.runInNewContext(studio, context);
  return { context, billing: context.__fancyCafeBilling, listeners, inputs, changeCounts, eventCounts, status };
}

test('DOMContentLoaded enables local upload before network promises settle', async () => {
  let resolveFetch;
  const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
  const app = runtime({ fetchImpl: () => pendingFetch });
  assert.equal(app.listeners.length, 1);
  const event = app.listeners[0]();
  assert.equal(app.inputs.lead.disabled, false);
  assert.equal(app.inputs.regular.disabled, false);
  assert.equal(JSON.stringify(app.changeCounts), JSON.stringify({ lead: 1, regular: 1 }));
  assert.equal(app.eventCounts.style, 2);
  resolveFetch({ ok: false, status: 503, json: async () => ({}) });
  await event;
});

test('unknown checkout reuses the same requestId and bad storage does not throw', async () => {
  const bodies = [];
  const app = runtime({ fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: false, status: 502, json: async () => ({ code: 'CHECKOUT_UNKNOWN' }) }; } });
  const configured = app.billing.configure({ auth: { authenticated: true, user: { id: 'user-1' } }, csrfToken: 'csrf' });
  assert.equal(configured.csrfToken, 'csrf');
  const button = { disabled: false, closest() { return null; } };
  await app.billing.checkout('credits-20', button);
  await app.billing.checkout('credits-20', button);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].requestId, bodies[1].requestId);
  assert.equal(app.billing.renderOrderResult({ status: 'checkout_unknown' }).includes('Payment is not confirmed'), true);
  const brokenBodies = [];
  const broken = runtime({ storageImpl: { setItem() { throw new Error('quota'); }, getItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }, fetchImpl: async (_url, options) => { brokenBodies.push(JSON.parse(options.body)); return { ok: false, status: 502, json: async () => ({ code: 'CHECKOUT_UNKNOWN' }) }; } });
  broken.billing.configure({ auth: { authenticated: true, user: { id: 'user-1' } }, csrfToken: 'csrf' });
  await assert.doesNotReject(() => broken.billing.checkout('credits-20', { disabled: false, closest() { return null; } }));
  await assert.doesNotReject(() => broken.billing.checkout('credits-20', { disabled: false, closest() { return null; } }));
  assert.equal(brokenBodies.length, 2);
  assert.equal(brokenBodies[0].requestId, brokenBodies[1].requestId);
});

test('502 response orderId is retained for later verification', async () => {
  const app = runtime({ fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ code: 'CHECKOUT_FAILED', order: { orderId: 'order-keep' } }) }) });
  app.billing.configure({ auth: { authenticated: true, user: { id: 'user-1' } }, csrfToken: 'csrf' });
  await app.billing.checkout('credits-20', { disabled: false, closest() { return null; } });
  assert.equal(app.billing.getPending().orderId, 'order-keep');
});

test('service banner lists only unavailable capabilities and marks test checkout', () => {
  const app = runtime();
  assert.doesNotThrow(() => app.billing.updateServiceStatus(null, null));
  app.billing.updateServiceStatus({ providers: { auth: 'configured', ai: 'unconfigured' } }, { paymentMode: { mode: 'test', testConfigured: true } });
  assert.equal(app.status.textContent.includes('video generation'), true);
  assert.equal(app.status.textContent.includes('Google sign-in'), false);
  assert.equal(app.status.textContent.includes('Checkout is in test mode; no real charges.'), true);
  app.billing.updateServiceStatus({ providers: { auth: 'configured', ai: 'configured' } }, { paymentMode: { mode: 'prod', productionConfigured: false, checkoutEnabled: false } });
  assert.equal(app.status.textContent.includes('purchases'), true);
  assert.equal(app.status.textContent.includes('video generation'), false);
  assert.equal(app.status.textContent.includes('Google sign-in'), false);
});
