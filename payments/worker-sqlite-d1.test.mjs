import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { handlePayments } from '../deploy/payments.mjs';

const migrationV2 = readFileSync(fileURLToPath(new URL('../migrations/0002_payments.sql', import.meta.url)), 'utf8');
const migrationV4 = readFileSync(fileURLToPath(new URL('../migrations/0004_paypal.sql', import.meta.url)), 'utf8');
const migration = `${migrationV2}\n${migrationV4}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

class SqliteD1 {
  constructor(path) { this.db = new DatabaseSync(path); this.db.exec(migration); this.failBatchAt = 0; this.failWebhookInsert = false; }
  prepare(sql) {
    const owner = this;
    return { bind(...args) {
      return {
        first: async () => owner.db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: owner.db.prepare(sql).all(...args) }),
        run: async () => { if (owner.failWebhookInsert && sql.includes('payment_webhook_events')) throw new Error('simulated webhook write failure'); return owner.db.prepare(sql).run(...args); },
        sql,
        args,
      };
    } };
  }
  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try { for (let index = 0; index < statements.length; index += 1) { if (this.failBatchAt === index + 1) throw new Error('simulated batch failure'); this.db.prepare(statements[index].sql).run(...statements[index].args); } this.db.exec('COMMIT'); return statements.map(() => ({ meta: { changes: 1 } })); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

function tempDb() { const directory = mkdtempSync(join(tmpdir(), 'fancycoffee-worker-')); return { directory, path: join(directory, 'billing.sqlite') }; }
function env(db) { return { WAFFO_MODE: 'test', WAFFO_ENABLED: 'true', BILLING_TEST_DB: db, WAFFO_TEST_MERCHANT_ID: 'MER_TEST', WAFFO_TEST_PRIVATE_KEY: privatePem, WAFFO_TEST_WEBHOOK_PUBLIC_KEY: publicPem, WAFFO_TEST_STORE_ID: 'STORE_TEST', WAFFO_TEST_PRODUCT_20: 'PROD_20', WAFFO_TEST_PRODUCT_60: 'PROD_60', WAFFO_TEST_PRODUCT_200: 'PROD_200' }; }
function auth(userId = 'USER_1') { return { getSession: () => ({ userId, email: `${userId.toLowerCase()}@example.com` }), requireSameOriginAndCsrf: () => true }; }
function checkoutRequest(requestId, packId = 'credits-20') { return new Request('https://fancycafeaivideo.pro/api/checkout', { method: 'POST', body: JSON.stringify({ requestId, packId }) }); }
function sign(raw) { const timestamp = String(Date.now()); return `t=${timestamp},v1=${createSign('RSA-SHA256').update(`${timestamp}.${raw}`).sign(privateKey, 'base64')}`; }
function completedEvent(order, { paymentId = 'PAY_1', eventId = paymentId, chargedAmount = '9.99', taxAmount = '0.00', total = '9.99' } = {}) { return { eventType: 'order.completed', eventId, mode: 'test', storeId: 'STORE_TEST', data: { orderMerchantExternalId: order.orderId, orderStatus: 'completed', paymentStatus: 'succeeded', paymentId, currency: 'USD', chargedAmount, orderMetadata: { localOrderId: order.orderId, userId: order.userId, packId: order.packId, productId: order.productId }, listPrice: { subtotal: '9.99', taxAmount, total, discountAmount: '0.00' } } }; }
async function postWebhook(db, event) { const raw = JSON.stringify(event); return handlePayments(new Request('https://fancycafeaivideo.pro/api/waffo/webhook/test', { method: 'POST', headers: { 'X-Waffo-Signature': sign(raw) }, body: raw }), env(db)); }

test('0004 preserves a pre-existing Waffo order with the default provider', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationV2);
  db.prepare('INSERT INTO payment_orders (order_id, request_id, user_id, pack_id, product_id, currency, amount_cents, environment, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('OLD_ORDER', 'old-request', 'USER_OLD', 'credits-20', 'PROD_20', 'USD', 999, 'test', 'pending', new Date().toISOString(), new Date().toISOString());
  db.exec(migrationV4);
  assert.equal(db.prepare('SELECT payment_provider FROM payment_orders WHERE order_id = ?').get('OLD_ORDER').payment_provider, 'waffo');
  db.close();
});

test('real SQLite D1 adapter allows one provider call for concurrent requestId and unknown retry', async () => {
  const temp = tempDb(); const db = new SqliteD1(temp.path); let calls = 0;
  try {
    const options = { auth: auth(), fetch: async () => { calls += 1; return new Response(JSON.stringify({ data: { sessionId: `CS_${calls}`, checkoutUrl: `https://checkout.waffo.ai/c/${calls}`, expiresAt: '2026-11-06T00:00:00Z' } }), { status: 200 }); } };
    const responses = await Promise.all([handlePayments(checkoutRequest('request-concurrent'), env(db), options), handlePayments(checkoutRequest('request-concurrent'), env(db), options)]);
    assert.equal(calls, 1); assert.equal(responses.filter((response) => response.status === 200).length, 2);
    db.db.prepare('UPDATE payment_orders SET expires_at = NULL WHERE request_id = ?').run('request-concurrent');
    const missingExpiry = await handlePayments(checkoutRequest('request-concurrent'), env(db), { ...options, fetch: async () => { calls += 1; return new Response(JSON.stringify({ data: { sessionId: 'CS_BAD', checkoutUrl: 'https://checkout.waffo.ai/c/bad', expiresAt: '2026-11-06T00:00:00Z' } }), { status: 200 }); } });
    assert.equal((await missingExpiry.json()).checkoutUrl, null); assert.equal(calls, 1);
    db.db.prepare('UPDATE payment_orders SET expires_at = ? WHERE request_id = ?').run('not-a-date', 'request-concurrent');
    const invalidExpiry = await handlePayments(checkoutRequest('request-concurrent'), env(db), options);
    assert.equal((await invalidExpiry.json()).checkoutUrl, null); assert.equal(calls, 1);
    let unknownCalls = 0; const unknown = { auth: auth(), fetch: async () => { unknownCalls += 1; throw new Error('timeout'); } };
    const first = await handlePayments(checkoutRequest('request-unknown'), env(db), unknown); const firstBody = await first.json(); const second = await handlePayments(checkoutRequest('request-unknown'), env(db), unknown); const secondBody = await second.json();
    assert.equal(first.status, 502); assert.equal(firstBody.code, 'CHECKOUT_UNKNOWN'); assert.ok(firstBody.orderId); assert.equal(secondBody.retryable, false); assert.equal(unknownCalls, 1);
  } finally { db.close(); rmSync(temp.directory, { recursive: true, force: true }); }
});

test('real SQLite D1 batch rollback, duplicate paid webhook, tax validation, cross-user 404, and refund failure are explicit', async () => {
  const temp = tempDb(); const db = new SqliteD1(temp.path);
  try {
    let calls = 0; const checkout = await handlePayments(checkoutRequest('request-paid'), env(db), { auth: auth(), fetch: async () => { calls += 1; return new Response(JSON.stringify({ data: { sessionId: 'CS_PAID', checkoutUrl: 'https://checkout.waffo.ai/c/paid', expiresAt: '2026-11-06T00:00:00Z' } }), { status: 200 }); } });
    const order = await db.db.prepare('SELECT order_id AS orderId, user_id AS userId, pack_id AS packId, product_id AS productId FROM payment_orders WHERE request_id = ?').get('request-paid');
    db.failBatchAt = 2; const failed = await postWebhook(db, completedEvent(order)); assert.equal(failed.status, 503); assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM payment_fulfillments').get().count, 0);
    db.failBatchAt = 0; const paid = await postWebhook(db, completedEvent(order)); const duplicate = await postWebhook(db, completedEvent(order)); assert.equal(paid.status, 200); assert.equal((await duplicate.json()).duplicate, true); assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM credit_ledger').get().count, 1);
    const paidCheckout = await handlePayments(checkoutRequest('request-paid'), env(db), { auth: auth(), fetch: async () => { calls += 1; return new Response(JSON.stringify({ data: { sessionId: 'CS_SHOULD_NOT_CREATE', checkoutUrl: 'https://checkout.waffo.ai/c/no', expiresAt: '2026-11-06T00:00:00Z' } }), { status: 200 }); } }); const paidCheckoutBody = await paidCheckout.json(); assert.equal(paidCheckoutBody.checkoutUrl, null); assert.equal(calls, 1);
    const taxMismatch = await postWebhook(db, completedEvent(order, { paymentId: 'PAY_TAX', eventId: 'PAY_TAX', chargedAmount: '0.00', taxAmount: '1.00', total: '10.99' })); assert.equal(taxMismatch.status, 400);
    const forbidden = await handlePayments(new Request(`https://fancycafeaivideo.pro/api/orders/${order.orderId}`), env(db), { auth: auth('USER_2') }); assert.equal(forbidden.status, 404);
    const refund = { eventType: 'refund.succeeded', eventId: 'REF_1', mode: 'test', storeId: 'STORE_TEST', data: { orderMerchantExternalId: order.orderId } }; db.failWebhookInsert = true; const refundFailed = await postWebhook(db, refund); assert.equal(refundFailed.status, 503); db.failWebhookInsert = false; const refundPending = await postWebhook(db, refund); assert.equal((await refundPending.json()).status, 'pending_review'); assert.equal(calls, 1);
  } finally { db.close(); rmSync(temp.directory, { recursive: true, force: true }); }
});
