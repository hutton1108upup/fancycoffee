import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPaypalCreateOrderBody, createPaypalAdapter, parsePaypalCreateOrderResponse, parsePaypalCaptureResponse, validatePaypalOrderSnapshot } from '../deploy/paypal-adapter.mjs';

const order = { orderId: 'ORDER_123', userId: 'USER_1', packId: 'credits-20', currency: 'USD', amountCents: 999, environment: 'test', merchantId: 'MERCHANT_1', returnUrl: 'https://fancycafeaivideo.pro/pricing?order=ORDER_123&paypal_return=1', cancelUrl: 'https://fancycafeaivideo.pro/pricing?order=ORDER_123&paypal_cancel=1' };

test('builds one-time CAPTURE order with stable local bindings and no shipping', () => {
  const result = buildPaypalCreateOrderBody(order);
  assert.equal(result.ok, true);
  assert.equal(result.body.intent, 'CAPTURE');
  assert.equal(result.body.purchase_units.length, 1);
  assert.deepEqual(result.body.purchase_units[0], { reference_id: 'ORDER_123', custom_id: 'ORDER_123', invoice_id: 'ORDER_123', amount: { currency_code: 'USD', value: '9.99' }, payee: { merchant_id: 'MERCHANT_1' }, description: 'Fancy Cafe AI - 20 credits' });
  assert.equal(result.body.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');
});

test('accepts only environment-matching payer-action URL', () => {
  assert.equal(parsePaypalCreateOrderResponse({ id: 'PP_1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP_1' }] }, 'test').ok, true);
  assert.equal(parsePaypalCreateOrderResponse({ id: 'PP_1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=PP_1' }] }, 'test').ok, false);
  assert.equal(parsePaypalCreateOrderResponse({ id: 'PP_1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://user:pass@www.sandbox.paypal.com/checkoutnow' }] }, 'test').ok, false);
});

test('requires full server GET snapshot before accepting capture', () => {
  const snapshot = { id: 'PP_1', intent: 'CAPTURE', status: 'APPROVED', purchase_units: [{ reference_id: 'ORDER_123', custom_id: 'ORDER_123', invoice_id: 'ORDER_123', amount: { currency_code: 'USD', value: '9.99' }, payee: { merchant_id: 'MERCHANT_1' } }] };
  assert.equal(validatePaypalOrderSnapshot(snapshot, { ...order, providerOrderId: 'PP_1' }).ok, true);
  assert.equal(validatePaypalOrderSnapshot({ ...snapshot, purchase_units: [{ ...snapshot.purchase_units[0], payee: { merchant_id: 'OTHER' } }] }, { ...order, providerOrderId: 'PP_1' }).ok, false);
  const capture = { status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP_1', status: 'COMPLETED', final_capture: true, amount: { currency_code: 'USD', value: '9.99' } }] } }] };
  assert.deepEqual(parsePaypalCaptureResponse(capture, order), { ok: true, paymentId: 'CAP_1', credits: 20 });
  assert.equal(parsePaypalCaptureResponse({ ...capture, purchase_units: [{ payments: { captures: [{ ...capture.purchase_units[0].payments.captures[0], final_capture: false }] } }] }, order).ok, false);
});

test('adapter uses OAuth, create, capture, then trusted GET with stable idempotency keys', async () => {
  const calls = []; let captureCompleted = false;
  const env = { WAFFO_MODE: 'test', BILLING_PROVIDER: 'paypal', PAYPAL_ENABLED: 'true', PAYPAL_TEST_CLIENT_ID: 'client', PAYPAL_TEST_CLIENT_SECRET: 'secret', PAYPAL_TEST_MERCHANT_ID: 'MERCHANT_1', PAYPAL_TEST_WEBHOOK_ID: 'WH_1' };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
    if (url.endsWith('/v2/checkout/orders') && init.method === 'POST') return new Response(JSON.stringify({ id: 'PP_1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP_1' }] }), { status: 201 });
    if (url.endsWith('/capture')) { captureCompleted = true; return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 201 }); }
    return new Response(JSON.stringify({ id: 'PP_1', intent: 'CAPTURE', status: captureCompleted ? 'COMPLETED' : 'APPROVED', purchase_units: [{ reference_id: 'ORDER_123', custom_id: 'ORDER_123', invoice_id: 'ORDER_123', amount: { currency_code: 'USD', value: '9.99' }, payee: { merchant_id: 'MERCHANT_1' }, ...(captureCompleted ? { payments: { captures: [{ id: 'CAP_1', status: 'COMPLETED', final_capture: true, amount: { currency_code: 'USD', value: '9.99' } }] } } : {}) }] }), { status: 200 });
  };
  const adapter = createPaypalAdapter(env, { fetchImpl });
  const created = await adapter.createOrder(order);
  assert.equal(created.providerOrderId, 'PP_1');
  const captured = await adapter.captureOrder({ ...order, providerOrderId: 'PP_1' });
  assert.equal(captured.paymentId, 'CAP_1');
  const createCall = calls.find((call) => call.url.endsWith('/v2/checkout/orders') && call.init.method === 'POST');
  assert.equal(createCall.init.headers['PayPal-Request-Id'], 'create-ORDER_123');
  const captureCall = calls.find((call) => call.url.endsWith('/capture'));
  assert.equal(captureCall.init.headers['PayPal-Request-Id'], 'capture-ORDER_123');
  assert.equal(calls.some((call) => call.url.endsWith('/v2/checkout/orders/PP_1')), true);
});
