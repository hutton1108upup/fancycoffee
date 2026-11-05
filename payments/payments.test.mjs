import assert from 'node:assert/strict';
import test from 'node:test';
import { CREDIT_PACKS, CURRENCY, listCreditPacks } from './catalog.mjs';
import { PaymentNotificationDedupe } from './dedupe.mjs';
import { PaymentValidationError, validateCheckoutRequest, validatePaymentNotification } from './validation.mjs';

test('declares exactly the requested one-time USD packs', () => {
  assert.deepEqual(listCreditPacks().map(({ id, credits, amountCents, currency, billingType }) => ({ id, credits, amountCents, currency, billingType })), [
    { id: 'credits-20', credits: 20, amountCents: 999, currency: CURRENCY, billingType: 'one_time' },
    { id: 'credits-60', credits: 60, amountCents: 2499, currency: CURRENCY, billingType: 'one_time' },
    { id: 'credits-200', credits: 200, amountCents: 6999, currency: CURRENCY, billingType: 'one_time' },
  ]);
  assert.equal(CREDIT_PACKS.length, 3);
});

test('validates a known pack and rejects unknown or subscription selections', () => {
  assert.deepEqual(validateCheckoutRequest({ packId: 'credits-60' }), { packId: 'credits-60', currency: 'USD', amountCents: 2499, credits: 60, billingType: 'one_time' });
  assert.throws(() => validateCheckoutRequest({ packId: 'credits-999' }), (error) => error instanceof PaymentValidationError && error.code === 'UNKNOWN_PACK');
  assert.throws(() => validateCheckoutRequest({ packId: 'credits-20', billingType: 'subscription' }), (error) => error.code === 'SUBSCRIPTIONS_DISABLED');
});

test('only accepts successful notifications with an exact amount', () => {
  assert.deepEqual(validatePaymentNotification({ paymentRequestId: 'req-1', packId: 'credits-20', amountCents: 999, currency: 'USD', billingType: 'one_time', status: 'SUCCESS' }).credits, 20);
  assert.throws(() => validatePaymentNotification({ paymentRequestId: 'req-2', packId: 'credits-20', amountCents: 998, currency: 'USD', billingType: 'one_time', status: 'SUCCESS' }), (error) => error.code === 'AMOUNT_MISMATCH');
  assert.throws(() => validatePaymentNotification({ paymentRequestId: 'req-3', packId: 'credits-20', amountCents: 999, currency: 'USD', billingType: 'one_time', status: 'PENDING' }), (error) => error.code === 'PAYMENT_NOT_SUCCESSFUL');
  assert.throws(() => validatePaymentNotification({ paymentRequestId: 'req-4', packId: 'credits-20', amountCents: 999, status: 'SUCCESS' }), (error) => error.code === 'INVALID_CURRENCY');
  assert.throws(() => validatePaymentNotification({ paymentRequestId: 'req-5', packId: 'credits-20', amountCents: 999, currency: 'USD', status: 'SUCCESS' }), (error) => error.code === 'SUBSCRIPTIONS_DISABLED');
});

test('dedupes the same payment request ID without crediting anything', () => {
  const dedupe = new PaymentNotificationDedupe();
  assert.deepEqual(dedupe.claim('req-1'), { accepted: true, duplicate: false });
  assert.deepEqual(dedupe.claim('req-1'), { accepted: false, duplicate: true });
  assert.equal(dedupe.size(), 1);
});
