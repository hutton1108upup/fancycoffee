import { CURRENCY, getCreditPack } from './catalog.mjs';

export class PaymentValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PaymentValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PaymentValidationError(code, message);
}

export function validateCheckoutRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', 'A checkout request object is required.');
  const pack = getCreditPack(input.packId);
  if (!pack) fail('UNKNOWN_PACK', 'The selected credit pack is not available.');
  if (input.currency !== undefined && input.currency !== CURRENCY) fail('INVALID_CURRENCY', 'Only USD credit packs are configured.');
  if (input.billingType !== undefined && input.billingType !== 'one_time') fail('SUBSCRIPTIONS_DISABLED', 'Subscriptions are not configured.');
  return { packId: pack.id, currency: pack.currency, amountCents: pack.amountCents, credits: pack.credits, billingType: pack.billingType };
}

export function validatePaymentNotification(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_NOTIFICATION', 'A payment notification object is required.');
  if (typeof input.paymentRequestId !== 'string' || input.paymentRequestId.trim() === '') fail('INVALID_PAYMENT_ID', 'paymentRequestId is required.');
  if (input.status !== 'SUCCESS') fail('PAYMENT_NOT_SUCCESSFUL', 'Only successful payment notifications can be considered for fulfillment.');
  if (input.currency !== CURRENCY) fail('INVALID_CURRENCY', 'Payment notifications must explicitly declare USD.');
  if (input.billingType !== 'one_time') fail('SUBSCRIPTIONS_DISABLED', 'Payment notifications must explicitly declare one_time billing.');
  const expected = validateCheckoutRequest({ packId: input.packId, currency: input.currency, billingType: input.billingType });
  if (input.amountCents !== expected.amountCents) fail('AMOUNT_MISMATCH', 'The notification amount does not match the configured pack.');
  return { ...expected, paymentRequestId: input.paymentRequestId.trim(), status: 'SUCCESS' };
}
