import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { handlePayments } from '../deploy/payments.mjs';
import { verifyPaypalWebhook } from '../deploy/paypal-webhook.mjs';

const migration = `${readFileSync(new URL('../migrations/0002_payments.sql', import.meta.url), 'utf8')}\n${readFileSync(new URL('../migrations/0004_paypal.sql', import.meta.url), 'utf8')}`;
class SqliteD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(migration); }
  prepare(sql) { const owner = this; return { bind(...args) { return { sql, args, first: async () => owner.db.prepare(sql).get(...args) ?? null, all: async () => ({ results: owner.db.prepare(sql).all(...args) }), run: async () => owner.db.prepare(sql).run(...args) }; } }; }
  batch(statements) { this.db.exec('BEGIN IMMEDIATE'); try { const result = statements.map((statement) => this.db.prepare(statement.sql).run(...statement.args)); this.db.exec('COMMIT'); return Promise.resolve(result); } catch (error) { this.db.exec('ROLLBACK'); return Promise.reject(error); } }
  close() { this.db.close(); }
}
function env(db) { return { WAFFO_MODE: 'test', BILLING_PROVIDER: 'paypal', PAYPAL_ENABLED: 'true', BILLING_TEST_DB: db, PAYPAL_TEST_CLIENT_ID: 'client', PAYPAL_TEST_CLIENT_SECRET: 'secret', PAYPAL_TEST_MERCHANT_ID: 'MERCHANT_1', PAYPAL_TEST_WEBHOOK_ID: 'WH_1' }; }

test('webhook uses official verify API, GETs the complete order, and fulfills only completed capture once', async () => {
  const db = new SqliteD1(); const orderId = 'LOCAL_ORDER_1';
  db.db.prepare('INSERT INTO payment_orders (order_id, request_id, user_id, pack_id, product_id, currency, amount_cents, environment, status, payment_provider, provider_order_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(orderId, 'request-1', 'USER_1', 'credits-20', 'paypal', 'USD', 999, 'test', 'pending', 'paypal', 'PP_ORDER_1', new Date().toISOString(), new Date().toISOString());
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
    if (url.endsWith('/verify-webhook-signature')) return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 });
    return new Response(JSON.stringify({ id: 'PP_ORDER_1', intent: 'CAPTURE', status: 'COMPLETED', purchase_units: [{ reference_id: orderId, custom_id: orderId, invoice_id: orderId, amount: { currency_code: 'USD', value: '9.99' }, payee: { merchant_id: 'MERCHANT_1' }, payments: { captures: [{ id: 'PP_CAPTURE_1', status: 'COMPLETED', final_capture: true, amount: { currency_code: 'USD', value: '9.99' } }] } }] }), { status: 200 });
  };
  const event = { id: 'WH_EVENT_1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'PP_CAPTURE_1', status: 'COMPLETED', final_capture: true, amount: { currency_code: 'USD', value: '9.99' }, supplementary_data: { related_ids: { order_id: 'PP_ORDER_1' } } } };
  const request = (payload) => new Request('https://fancycafeaivideo.pro/api/paypal/webhook/test', { method: 'POST', headers: { 'content-length': String(JSON.stringify(payload).length), 'PAYPAL-AUTH-ALGO': 'SHA256withRSA', 'PAYPAL-CERT-URL': 'https://evil.example/cert', 'PAYPAL-TRANSMISSION-ID': 'T1', 'PAYPAL-TRANSMISSION-SIG': 'SIG', 'PAYPAL-TRANSMISSION-TIME': new Date().toISOString() }, body: JSON.stringify(payload) });
  try {
    const missingHeaders = await handlePayments(new Request('https://fancycafeaivideo.pro/api/paypal/webhook/test', { method: 'POST', body: '{}' }), env(db), { fetch: async () => { throw new Error('must not fetch token'); } }); assert.equal(missingHeaders.status, 401);
    const first = await handlePayments(request(event), env(db), { fetch }); const firstBody = await first.json();
    assert.equal(first.status, 200); assert.equal(firstBody.credits, 20); assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM credit_ledger').get().count, 1);
    const verifyCall = calls.find((call) => call.url.endsWith('/verify-webhook-signature'));
    const verifyBody = JSON.parse(verifyCall.init.body); assert.equal(verifyBody.webhook_id, 'WH_1'); assert.deepEqual(verifyBody.webhook_event, event); assert.equal(verifyBody.cert_url, 'https://evil.example/cert');
    const secondEvent = { ...event, id: 'WH_EVENT_2' }; const second = await handlePayments(request(secondEvent), env(db), { fetch }); assert.equal((await second.json()).duplicate, true); assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM credit_ledger').get().count, 1);
    const refund = { id: 'WH_REFUND_1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF_1', supplementary_data: { related_ids: { order_id: 'PP_ORDER_1', capture_id: 'PP_CAPTURE_1' } } } }; const refundResponse = await handlePayments(request(refund), env(db), { fetch }); assert.equal((await refundResponse.json()).status, 'pending_review'); assert.equal(db.db.prepare('SELECT status FROM payment_orders WHERE order_id = ?').get(orderId).status, 'refund_pending'); assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM credit_ledger').get().count, 1);
    const lateCompletion = await handlePayments(request({ ...event, id: 'WH_LATE_COMPLETION' }), env(db), { fetch }); assert.equal(lateCompletion.status, 409); assert.equal((await lateCompletion.json()).code, 'REFUND_PENDING');
    db.db.prepare('DELETE FROM credit_ledger').run(); db.db.prepare('DELETE FROM payment_fulfillments').run(); db.db.prepare('UPDATE payment_orders SET status = ?, provider_capture_id = NULL WHERE order_id = ?').run('pending', orderId);
    const refundFirst = await handlePayments(request({ ...refund, id: 'WH_REFUND_FIRST' }), env(db), { fetch }); assert.equal((await refundFirst.json()).status, 'pending_review');
    const oldCompletion = await handlePayments(request({ ...event, id: 'WH_OLD_COMPLETION' }), env(db), { fetch }); assert.equal(oldCompletion.status, 409); assert.equal((await oldCompletion.json()).code, 'REFUND_PENDING');
  } finally { db.close(); }
});

test('webhook verification requires PayPal SUCCESS and never trusts a client certificate fetch', async () => {
  const result = await verifyPaypalWebhook('{}', new Headers({ 'PAYPAL-AUTH-ALGO': 'A', 'PAYPAL-CERT-URL': 'https://example.invalid/cert', 'PAYPAL-TRANSMISSION-ID': 'T', 'PAYPAL-TRANSMISSION-SIG': 'S', 'PAYPAL-TRANSMISSION-TIME': '2026-11-07T00:00:00Z' }), { baseUrl: 'https://api-m.sandbox.paypal.com', webhookId: 'WH' }, { accessToken: 'token', fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); assert.equal(body.webhook_id, 'WH'); return new Response(JSON.stringify({ verification_status: 'FAILURE' }), { status: 200 }); } });
  assert.equal(result.ok, false); assert.equal(result.code, 'INVALID_SIGNATURE');
});
