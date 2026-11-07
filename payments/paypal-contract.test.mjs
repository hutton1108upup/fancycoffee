import assert from 'node:assert/strict';
import test from 'node:test';
import { billingConfigStatus, billingDatabase, billingMode, billingProvider, paypalConfig } from '../deploy/billing-config.mjs';
import { validatePaypalCaptureFacts, validatePaypalOrderBinding, paypalEnvironmentMatches } from './paypal-contract.mjs';
import { getPaymentStatus } from '../deploy/payments.mjs';

const db = { prepare() {}, batch() {} };

test('PayPal config chooses isolated server ledger and sandbox/live base URL', () => {
  const testEnv = { WAFFO_MODE: 'test', BILLING_PROVIDER: 'paypal', PAYPAL_ENABLED: 'true', BILLING_TEST_DB: db, PAYPAL_TEST_CLIENT_ID: 'id', PAYPAL_TEST_CLIENT_SECRET: 'secret', PAYPAL_TEST_MERCHANT_ID: 'merchant', PAYPAL_TEST_WEBHOOK_ID: 'webhook' };
  assert.equal(billingMode(testEnv), 'test');
  assert.equal(billingDatabase(testEnv), db);
  assert.equal(billingProvider(testEnv), 'paypal');
  assert.equal(paypalConfig(testEnv).baseUrl, 'https://api-m.sandbox.paypal.com');
  assert.equal(billingConfigStatus(testEnv).configured, true);

  const productionEnv = { ...testEnv, WAFFO_MODE: 'production', PAYPAL_PRODUCTION_ENABLED: 'true', APP_DB: db, PAYPAL_PRODUCTION_CLIENT_ID: 'id', PAYPAL_PRODUCTION_CLIENT_SECRET: 'secret', PAYPAL_PRODUCTION_MERCHANT_ID: 'merchant', PAYPAL_PRODUCTION_WEBHOOK_ID: 'webhook' };
  assert.equal(billingMode(productionEnv), 'prod');
  assert.equal(billingDatabase(productionEnv), db);
  assert.equal(paypalConfig(productionEnv).baseUrl, 'https://api-m.paypal.com');
  assert.equal(billingConfigStatus(productionEnv).configured, true);
});

test('PayPal configuration is disabled by default and unknown providers are rejected', () => {
  assert.equal(billingConfigStatus({ WAFFO_MODE: 'test', BILLING_TEST_DB: db }).configured, false);
  assert.equal(billingProvider({ BILLING_PROVIDER: 'stripe' }), 'unsupported');
  const env = { WAFFO_MODE: 'test', BILLING_PROVIDER: 'paypal', PAYPAL_ENABLED: 'true', BILLING_TEST_DB: db, APP_DB: db, PAYPAL_TEST_CLIENT_ID: 'id', PAYPAL_TEST_CLIENT_SECRET: 'secret', PAYPAL_TEST_MERCHANT_ID: 'merchant', PAYPAL_TEST_WEBHOOK_ID: 'webhook' };
  const status = getPaymentStatus(env);
  assert.equal(status.provider, 'paypal'); assert.equal(status.paymentMode, 'test'); assert.equal(status.testConfigured, true); assert.equal(status.productionConfigured, false);
  assert.equal(getPaymentStatus({ BILLING_PROVIDER: 'stripe', BILLING_TEST_DB: db }).checkoutEnabled, false);
});

test('capture facts require exact local order, environment, USD amount and completed status', () => {
  const expected = { localOrderId: 'ORDER_1', userId: 'USER_1', packId: 'credits-20', providerOrderId: 'PP_ORDER_1', currency: 'USD', amountCents: 999, environment: 'test' };
  assert.equal(validatePaypalOrderBinding(expected).ok, true);
  const facts = { provider: 'paypal', environment: 'test', providerOrderId: 'PP_ORDER_1', localOrderId: 'ORDER_1', userId: 'USER_1', currency: 'USD', amountCents: 999, captureStatus: 'COMPLETED', paymentId: 'PP_CAPTURE_1', partial: false };
  assert.deepEqual(validatePaypalCaptureFacts(facts, expected), { ok: true, paymentId: 'PP_CAPTURE_1', credits: 20, packId: 'credits-20' });
  assert.equal(validatePaypalCaptureFacts({ ...facts, amountCents: 1 }, expected).ok, false);
  assert.equal(validatePaypalCaptureFacts({ ...facts, captureStatus: 'PENDING' }, expected).ok, false);
  assert.equal(validatePaypalCaptureFacts({ ...facts, partial: true }, expected).ok, false);
  assert.equal(paypalEnvironmentMatches('test', 'sandbox'), true);
  assert.equal(paypalEnvironmentMatches('test', 'live'), false);
});
