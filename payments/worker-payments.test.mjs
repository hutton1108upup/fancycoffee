import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import test from 'node:test';
import { getPaymentStatus, handlePayments, verifyWaffoWebhook } from '../deploy/payments.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const privatePkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

function signed(raw, timestamp = Date.now()) {
  const t = String(timestamp);
  const signature = createSign('RSA-SHA256').update(`${t}.${raw}`).sign(privatePem, 'base64');
  return `t=${t},v1=${signature}`;
}

test('credit packs are read-only and server mode selects the isolated test ledger', async () => {
  const response = await handlePayments(new Request('https://fancycafeaivideo.pro/api/credit-packs'), { WAFFO_MODE: 'test', WAFFO_ENABLED: 'false' });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.paymentMode.mode, 'test');
  assert.equal(body.paymentMode.checkoutEnabled, false);
  assert.deepEqual(body.packs.map((pack) => [pack.id, pack.amountCents, pack.credits]), [['credits-20', 999, 20], ['credits-60', 2499, 60], ['credits-200', 6999, 200]]);
  assert.deepEqual(getPaymentStatus({ WAFFO_MODE: 'production', WAFFO_ENABLED: 'true', WAFFO_PRODUCTION_ENABLED: 'false' }).mode, 'prod');
});

test('billing and checkout require the injected authenticated session and CSRF contract', async () => {
  const auth = { getSession: () => null, requireSameOriginAndCsrf: () => true };
  const billing = await handlePayments(new Request('https://fancycafeaivideo.pro/api/billing'), {}, { auth });
  assert.equal(billing.status, 401);
  const checkout = await handlePayments(new Request('https://fancycafeaivideo.pro/api/checkout', { method: 'POST', body: JSON.stringify({ packId: 'credits-20', requestId: 'request-1234' }) }), {}, { auth: { getSession: () => ({ userId: 'user-1' }), requireSameOriginAndCsrf: () => false } });
  assert.equal(checkout.status, 403);
});

test('verifies the documented raw-body Waffo signature and rejects forged or stale events', async () => {
  const raw = JSON.stringify({ eventType: 'order.completed', eventId: 'PAY_1' });
  assert.equal(await verifyWaffoWebhook(raw, signed(raw), publicPem), true);
  assert.equal(await verifyWaffoWebhook(raw, signed(`${raw}x`), publicPem), false);
  assert.equal(await verifyWaffoWebhook(raw, signed(raw, Date.now() - 46 * 60 * 1000), publicPem), false);
});

test('production webhook is unavailable while server mode is test', async () => {
  const response = await handlePayments(new Request('https://fancycafeaivideo.pro/api/waffo/webhook/production', { method: 'POST', body: '{}' }), { WAFFO_MODE: 'test', WAFFO_ENABLED: 'true', APP_DB: { prepare() {} } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'ENVIRONMENT_DISABLED');
});

class CheckoutDb {
  constructor() { this.runs = []; }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => { db.runs.push({ sql, args }); return { meta: { changes: 1 } }; },
        };
      },
    };
  }
  batch() { return Promise.resolve([]); }
}

test('checkout consumes nested Waffo data, persists redirect fields, and rejects a bad checkout host', async () => {
  const db = new CheckoutDb();
  const env = { WAFFO_MODE: 'test', WAFFO_ENABLED: 'true', BILLING_TEST_DB: db, WAFFO_TEST_MERCHANT_ID: 'MER_TEST', WAFFO_TEST_PRIVATE_KEY: privatePkcs1Pem, WAFFO_TEST_WEBHOOK_PUBLIC_KEY: publicPem, WAFFO_TEST_STORE_ID: 'STORE_TEST', WAFFO_TEST_PRODUCT_20: 'PROD_20', WAFFO_TEST_PRODUCT_60: 'PROD_60', WAFFO_TEST_PRODUCT_200: 'PROD_200' };
  const auth = { getSession: () => ({ userId: 'USER_1', email: 'user@example.com' }), requireSameOriginAndCsrf: () => true };
  let sent;
  const response = await handlePayments(new Request('https://fancycafeaivideo.pro/api/checkout', { method: 'POST', body: JSON.stringify({ packId: 'credits-20', requestId: 'request-1234' }) }), env, { auth, fetch: async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ data: { sessionId: 'cs_1', checkoutUrl: 'https://checkout.waffo.ai/session/cs_1', expiresAt: '2026-11-06T00:00:00Z' } }), { status: 200 }); } });
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.checkoutUrl, 'https://checkout.waffo.ai/session/cs_1'); assert.equal(body.expiresAt, '2026-11-06T00:00:00Z'); assert.equal(sent.buyerEmail, 'user@example.com'); assert.equal(sent.allowPromotionCodes, false); assert.match(sent.successUrl, /\/pricing\?order=/); assert.equal(db.runs.some((entry) => entry.sql.includes('checkout_url')), true);
  const bad = await handlePayments(new Request('https://fancycafeaivideo.pro/api/checkout', { method: 'POST', body: JSON.stringify({ packId: 'credits-20', requestId: 'request-5678' }) }), env, { auth, fetch: async () => new Response(JSON.stringify({ data: { sessionId: 'cs_2', checkoutUrl: 'https://evil.example/checkout' } }), { status: 200 }) });
  assert.equal(bad.status, 502); assert.equal((await bad.json()).code, 'CHECKOUT_UNKNOWN');
  const badPort = await handlePayments(new Request('https://fancycafeaivideo.pro/api/checkout', { method: 'POST', body: JSON.stringify({ packId: 'credits-20', requestId: 'request-9012' }) }), env, { auth, fetch: async () => new Response(JSON.stringify({ data: { sessionId: 'cs_3', checkoutUrl: 'https://user:pass@checkout.waffo.ai:8443/session' } }), { status: 200 }) });
  assert.equal(badPort.status, 502); assert.equal((await badPort.json()).code, 'CHECKOUT_UNKNOWN');
});
