import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { handlePayments } from '../deploy/payments.mjs';

const migration = `${readFileSync(new URL('../migrations/0002_payments.sql', import.meta.url), 'utf8')}\n${readFileSync(new URL('../migrations/0004_paypal.sql', import.meta.url), 'utf8')}`;

class SqliteD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(migration); }
  prepare(sql) { const owner = this; return { bind(...args) { return { sql, args, first: async () => owner.db.prepare(sql).get(...args) ?? null, all: async () => ({ results: owner.db.prepare(sql).all(...args) }), run: async () => owner.db.prepare(sql).run(...args) }; } }; }
  batch(statements) { this.db.exec('BEGIN IMMEDIATE'); try { const results = statements.map((statement) => this.db.prepare(statement.sql).run(...statement.args)); this.db.exec('COMMIT'); return Promise.resolve(results); } catch (error) { this.db.exec('ROLLBACK'); return Promise.reject(error); } }
  close() { this.db.close(); }
}

function env(db) {
  return { WAFFO_MODE: 'test', BILLING_PROVIDER: 'paypal', PAYPAL_ENABLED: 'true', BILLING_TEST_DB: db, PAYPAL_TEST_CLIENT_ID: 'client', PAYPAL_TEST_CLIENT_SECRET: 'secret', PAYPAL_TEST_MERCHANT_ID: 'MERCHANT_1', PAYPAL_TEST_WEBHOOK_ID: 'WH_1' };
}

function auth(userId) { return { getSession: () => ({ userId, email: `${userId}@example.com` }), requireSameOriginAndCsrf: () => true }; }
function request(path, method, body) { return new Request(`https://fancycafeaivideo.pro${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }); }

test('PayPal checkout/capture uses one isolated order and one atomic credit fulfillment', async () => {
  const db = new SqliteD1(); let captureCalls = 0; let localOrderId = null; let captured = false;
  const fetch = async (url, init) => {
    if (url.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
    if (url.endsWith('/v2/checkout/orders') && init.method === 'POST') return new Response(JSON.stringify({ id: 'PP_ORDER_1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP_ORDER_1' }] }), { status: 201 });
    if (url.endsWith('/capture')) { captureCalls += 1; captured = true; return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 201 }); }
    return new Response(JSON.stringify({ id: 'PP_ORDER_1', intent: 'CAPTURE', status: captured ? 'COMPLETED' : 'APPROVED', purchase_units: [{ reference_id: localOrderId, custom_id: localOrderId, invoice_id: localOrderId, amount: { currency_code: 'USD', value: '9.99' }, payee: { merchant_id: 'MERCHANT_1' }, ...(captured ? { payments: { captures: [{ id: 'PP_CAPTURE_1', status: 'COMPLETED', final_capture: true, amount: { currency_code: 'USD', value: '9.99' } }] } } : {}) }] }), { status: 200 });
  };
  try {
    const options = { auth: auth('USER_1'), fetch };
    const checkout = await handlePayments(request('/api/checkout', 'POST', { packId: 'credits-20', requestId: 'paypal-request-1' }), env(db), options);
    const checkoutBody = await checkout.json();
    assert.equal(checkout.status, 200); assert.equal(checkoutBody.provider, 'paypal'); assert.match(checkoutBody.checkoutUrl, /sandbox\.paypal\.com/);
    const order = db.db.prepare('SELECT order_id AS orderId FROM payment_orders').get();
    localOrderId = order.orderId;
    db.db.prepare('UPDATE payment_orders SET status = ? WHERE order_id = ?').run('refund_pending', order.orderId);
    const refundBlocked = await handlePayments(request('/api/paypal/capture', 'POST', { orderId: order.orderId }), env(db), options);
    assert.equal(refundBlocked.status, 409); assert.equal((await refundBlocked.json()).code, 'REFUND_PENDING');
    db.db.prepare('UPDATE payment_orders SET status = ? WHERE order_id = ?').run('pending', order.orderId);
    const disabledCapture = await handlePayments(request('/api/paypal/capture', 'POST', { orderId: order.orderId }), { ...env(db), PAYPAL_ENABLED: 'false' }, { ...options, fetch: async () => { throw new Error('disabled capture must not call provider'); } });
    assert.equal(disabledCapture.status, 503);
    const wrongUser = await handlePayments(request('/api/paypal/capture', 'POST', { orderId: order.orderId }), env(db), { auth: auth('USER_2'), fetch });
    assert.equal(wrongUser.status, 404);
    const captured = await handlePayments(request('/api/paypal/capture', 'POST', { orderId: order.orderId }), env(db), options);
    assert.equal(captured.status, 200); assert.equal((await captured.json()).credits, 20);
    const duplicate = await handlePayments(request('/api/paypal/capture', 'POST', { orderId: order.orderId }), env(db), options);
    assert.equal((await duplicate.json()).duplicate, true); assert.equal(captureCalls, 1);
    assert.equal(db.db.prepare('SELECT status FROM payment_orders WHERE order_id = ?').get(order.orderId).status, 'paid');
    assert.equal(db.db.prepare('SELECT COALESCE(SUM(credits), 0) AS credits FROM credit_ledger WHERE user_id = ?').get('USER_1').credits, 20);
  } finally { db.close(); }
});
