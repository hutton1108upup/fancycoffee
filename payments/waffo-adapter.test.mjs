import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import test from 'node:test';
import { buildCheckoutRequest, createWaffoAdapter } from './waffo-adapter.mjs';
import { createWebhookProcessor, validateCompletedOrder } from './waffo-webhook.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const config = { enabled: true, accountConfirmed: true, merchantId: 'MER_test', privateKey: privatePem, environment: 'test', storeId: 'STORE_test', productIds: { 'credits-20': 'PROD_20', 'credits-60': 'PROD_60', 'credits-200': 'PROD_200' } };
const pendingOrder = { orderId: 'ORDER_local_1', userId: 'USER_1', packId: 'credits-20', productId: 'PROD_20', currency: 'USD', amountCents: 999 };

test('is disabled by default and requires a trusted pending order', () => {
  assert.equal(buildCheckoutRequest({}, { pendingOrder }).code, 'PAYMENTS_UNCONFIGURED');
  assert.equal(buildCheckoutRequest(config, { packId: 'credits-20' }).code, 'PENDING_ORDER_REQUIRED');
});

test('builds the signed request with local order identity and never retries', async () => {
  let captured;
  let calls = 0;
  const adapter = createWaffoAdapter(config, { fetchImpl: async (url, init) => { calls += 1; captured = { url, init }; return new Response(JSON.stringify({ sessionId: 'cs_test', checkoutUrl: 'https://checkout.test/session' }), { status: 200 }); } });
  const result = await adapter.createCheckout({ pendingOrder }, { nowMs: 1705312200000 });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(captured.init.body), { productId: 'PROD_20', currency: 'USD', orderMerchantExternalId: 'ORDER_local_1', metadata: { localOrderId: 'ORDER_local_1', userId: 'USER_1', packId: 'credits-20', productId: 'PROD_20', currency: 'USD', amountCents: 999 } });
  assert.equal(captured.init.headers['X-Merchant-Id'], 'MER_test');
  assert.match(captured.init.headers['X-Signature'], /^[A-Za-z0-9+/]+=*$/);
  const unknown = await createWaffoAdapter(config, { fetchImpl: async () => { calls += 1; throw new Error('timeout'); } }).createCheckout({ pendingOrder });
  assert.equal(unknown.code, 'CHECKOUT_UNKNOWN');
  assert.equal(unknown.retryable, false);
});

function signedEvent(event, timestamp = Date.now()) {
  const raw = JSON.stringify(event);
  const t = String(timestamp);
  const signature = createSign('RSA-SHA256').update(`${t}.${raw}`).sign(privatePem, 'base64');
  return { raw, header: `t=${t},v1=${signature}` };
}

function orderEvent(overrides = {}, dataOverrides = {}) {
  return { id: 'PAY_1', timestamp: new Date().toISOString(), eventType: 'order.completed', eventId: 'PAY_1', storeId: 'STORE_test', mode: 'test', data: { orderId: 'ORDER_WAFFO', orderMerchantExternalId: 'ORDER_local_1', orderStatus: 'completed', currency: 'USD', chargedAmount: '9.99', amount: '9.99', listPrice: { total: '9.99' }, paymentStatus: 'succeeded', paymentId: 'PAYMENT_1', orderMetadata: { localOrderId: 'ORDER_local_1', userId: 'USER_1', packId: 'credits-20', productId: 'PROD_20' }, ...overrides, ...dataOverrides } };
}

function makeRepository({ pending = pendingOrder, failCommit = false } = {}) {
  const committedPayments = new Set();
  const committedOrders = new Set();
  let shouldFail = failCommit;
  return {
    committedPayments,
    committedOrders,
    async getPendingOrder(orderId) { return orderId === pending.orderId ? pending : null; },
    async commitFulfillment(record) {
      if (shouldFail) { shouldFail = false; throw new Error('temporary repository failure'); }
      if (committedPayments.has(record.paymentId) || committedOrders.has(record.localOrderId)) return { duplicate: true };
      committedPayments.add(record.paymentId); committedOrders.add(record.localOrderId); return { duplicate: false };
    },
  };
}

test('rejects forged or mismatched environment, store, user, order, product, and amount', async () => {
  const repository = makeRepository();
  const processor = createWebhookProcessor({ publicKey: publicPem, environment: 'test', storeId: 'STORE_test', repository });
  const valid = signedEvent(orderEvent());
  assert.deepEqual(await processor(valid.raw, `${valid.header.slice(0, valid.header.indexOf('v1='))}v1=forged`), { ok: false, code: 'INVALID_SIGNATURE' });
  assert.equal(validateCompletedOrder(orderEvent(), { environment: 'prod', storeId: 'STORE_test', pendingOrder }).code, 'ENVIRONMENT_MISMATCH');
  assert.equal(validateCompletedOrder(orderEvent(), { environment: 'test', storeId: 'OTHER', pendingOrder }).code, 'STORE_MISMATCH');
  assert.equal(validateCompletedOrder(orderEvent({ orderMerchantExternalId: 'OTHER' }), { environment: 'test', storeId: 'STORE_test', pendingOrder }).code, 'LOCAL_ORDER_MISMATCH');
  assert.equal(validateCompletedOrder(orderEvent({}), { environment: 'test', storeId: 'STORE_test', pendingOrder: { ...pendingOrder, userId: 'OTHER' } }).code, 'ORDER_METADATA_MISMATCH');
  assert.equal(validateCompletedOrder(orderEvent({}, { orderMetadata: { localOrderId: pendingOrder.orderId, userId: pendingOrder.userId, packId: pendingOrder.packId, productId: 'PROD_OTHER' } }), { environment: 'test', storeId: 'STORE_test', pendingOrder }).code, 'ORDER_METADATA_MISMATCH');
  assert.equal(validateCompletedOrder(orderEvent({ chargedAmount: '24.99' }), { environment: 'test', storeId: 'STORE_test', pendingOrder }).code, 'AMOUNT_MISMATCH');
});

test('atomically dedupes concurrent deliveries by payment and local order, including different event IDs', async () => {
  const repository = makeRepository();
  const processor = createWebhookProcessor({ publicKey: publicPem, environment: 'test', storeId: 'STORE_test', repository });
  const first = signedEvent(orderEvent());
  const second = signedEvent(orderEvent({ paymentId: 'PAYMENT_1' }, { eventId: 'PAY_2', id: 'PAY_2' }));
  const results = await Promise.all([processor(first.raw, first.header), processor(second.raw, second.header)]);
  assert.equal(results.filter((result) => result.duplicate === false).length, 1);
  assert.equal(results.filter((result) => result.duplicate === true).length, 1);
  assert.deepEqual([...repository.committedPayments], ['PAYMENT_1']);
});

test('a failed atomic commit can be retried without a lost order, while refund ordering stays pending review', async () => {
  const repository = makeRepository({ failCommit: true });
  const processor = createWebhookProcessor({ publicKey: publicPem, environment: 'test', storeId: 'STORE_test', repository });
  const valid = signedEvent(orderEvent());
  await assert.rejects(() => processor(valid.raw, valid.header), /temporary repository failure/);
  const retried = await processor(valid.raw, valid.header);
  assert.equal(retried.duplicate, false);
  const refund = signedEvent({ ...orderEvent(), eventType: 'refund.succeeded', eventId: 'REF_1' });
  assert.deepEqual(await processor(refund.raw, refund.header), { ok: false, code: 'UNSUPPORTED_EVENT', status: 'pending_review' });
});
