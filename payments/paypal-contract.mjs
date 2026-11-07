import { CURRENCY, getCreditPack } from './catalog.mjs';

export const PAYPAL_PROVIDER = 'paypal';

export function validatePaypalOrderBinding(binding) {
  if (!binding || typeof binding !== 'object') return { ok: false, code: 'PAYPAL_BINDING_REQUIRED' };
  const pack = getCreditPack(binding.packId);
  if (!pack) return { ok: false, code: 'UNKNOWN_PACK' };
  if (![binding.localOrderId, binding.userId, binding.providerOrderId].every((value) => typeof value === 'string' && value.length > 0)) return { ok: false, code: 'PAYPAL_BINDING_ID_REQUIRED' };
  if (binding.currency !== CURRENCY || binding.amountCents !== pack.amountCents) return { ok: false, code: 'PAYPAL_BINDING_AMOUNT_MISMATCH' };
  if (!['test', 'prod'].includes(binding.environment)) return { ok: false, code: 'PAYPAL_BINDING_ENVIRONMENT_INVALID' };
  return { ok: true, pack };
}

/**
 * Validates the provider-independent facts before a PayPal capture or webhook
 * can enter the existing atomic fulfillment path. Provider response field
 * names and signature verification remain in paypal-adapter/webhook once the
 * official field contract is supplied.
 */
export function validatePaypalCaptureFacts(facts, expected) {
  const binding = validatePaypalOrderBinding(expected);
  if (!binding.ok) return binding;
  if (!facts || facts.provider !== PAYPAL_PROVIDER) return { ok: false, code: 'PAYPAL_PROVIDER_MISMATCH' };
  if (facts.environment !== expected.environment || facts.providerOrderId !== expected.providerOrderId) return { ok: false, code: 'PAYPAL_ORDER_MISMATCH' };
  if (facts.localOrderId !== expected.localOrderId || facts.userId !== expected.userId) return { ok: false, code: 'PAYPAL_LOCAL_BINDING_MISMATCH' };
  if (facts.currency !== CURRENCY || facts.amountCents !== expected.amountCents) return { ok: false, code: 'PAYPAL_AMOUNT_MISMATCH' };
  if (facts.captureStatus !== 'COMPLETED') return { ok: false, code: 'PAYPAL_CAPTURE_NOT_COMPLETE' };
  if (facts.partial === true) return { ok: false, code: 'PAYPAL_PARTIAL_CAPTURE_UNSUPPORTED' };
  if (typeof facts.paymentId !== 'string' || facts.paymentId.length === 0) return { ok: false, code: 'PAYPAL_CAPTURE_ID_REQUIRED' };
  return { ok: true, paymentId: facts.paymentId, credits: binding.pack.credits, packId: binding.pack.id };
}

export function paypalEnvironmentMatches(mode, providerEnvironment) {
  return (mode === 'test' && providerEnvironment === 'sandbox') || (mode === 'prod' && providerEnvironment === 'live');
}
