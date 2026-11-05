import { createVerify } from 'node:crypto';
import { CURRENCY, getCreditPack } from './catalog.mjs';

const MAX_SIGNATURE_AGE_MS = 45 * 60 * 1000;

function parseSignatureHeader(header) {
  if (typeof header !== 'string') return null;
  const values = Object.create(null);
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    values[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return values.t && values.v1 ? values : null;
}

export function verifyWaffoWebhookSignature(rawBody, signatureHeader, publicKey, { nowMs = Date.now(), toleranceMs = MAX_SIGNATURE_AGE_MS } = {}) {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed || typeof rawBody !== 'string' || !publicKey) return false;
  const timestamp = Number(parsed.t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs - timestamp) > toleranceMs) return false;
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parsed.t}.${rawBody}`);
    return verifier.verify(publicKey, parsed.v1, 'base64');
  } catch {
    return false;
  }
}

function cents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function validateCompletedOrder(event, { environment, storeId, pendingOrder } = {}) {
  if (!event || event.eventType !== 'order.completed') return { ok: false, code: 'UNSUPPORTED_EVENT' };
  if (!['test', 'prod'].includes(environment) || event.mode !== environment) return { ok: false, code: 'ENVIRONMENT_MISMATCH' };
  if (!storeId || event.storeId !== storeId) return { ok: false, code: 'STORE_MISMATCH' };
  if (!pendingOrder || typeof pendingOrder !== 'object') return { ok: false, code: 'PENDING_ORDER_NOT_FOUND' };
  const data = event.data;
  if (!data || data.orderStatus !== 'completed' || data.paymentStatus !== 'succeeded' || data.currency !== CURRENCY) return { ok: false, code: 'PAYMENT_STATE_MISMATCH' };
  if (data.orderMerchantExternalId !== pendingOrder.orderId) return { ok: false, code: 'LOCAL_ORDER_MISMATCH' };
  const metadata = data.orderMetadata ?? data.productMetadata ?? {};
  if (metadata.localOrderId !== pendingOrder.orderId || metadata.userId !== pendingOrder.userId || metadata.packId !== pendingOrder.packId || metadata.productId !== pendingOrder.productId) return { ok: false, code: 'ORDER_METADATA_MISMATCH' };
  const pack = getCreditPack(pendingOrder.packId);
  if (!pack || pendingOrder.currency !== CURRENCY || pendingOrder.amountCents !== pack.amountCents) return { ok: false, code: 'PENDING_ORDER_SNAPSHOT_MISMATCH' };
  if (cents(data.chargedAmount ?? data.amount) !== pendingOrder.amountCents) return { ok: false, code: 'AMOUNT_MISMATCH' };
  if (data.listPrice?.total !== undefined && cents(data.listPrice.total) !== pendingOrder.amountCents) return { ok: false, code: 'LIST_PRICE_MISMATCH' };
  if (typeof data.paymentId !== 'string' || data.paymentId.length === 0) return { ok: false, code: 'PAYMENT_ID_MISSING' };
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) return { ok: false, code: 'EVENT_ID_MISSING' };
  return { ok: true, localOrderId: pendingOrder.orderId, userId: pendingOrder.userId, paymentId: data.paymentId, packId: pack.id, credits: pack.credits, eventKey: `${event.eventType}:${event.eventId}` };
}

/** repository.commitFulfillment must be one durable transaction with unique
 * paymentId and localOrderId constraints. It returns {duplicate:true} when
 * either key was committed and leaves state unchanged if it throws. */
export function createWebhookProcessor({ publicKey, environment, storeId, repository, onCommitted = async () => {} }) {
  if (!repository || typeof repository.getPendingOrder !== 'function' || typeof repository.commitFulfillment !== 'function') throw new TypeError('repository must provide getPendingOrder and atomic commitFulfillment methods');
  return async function process(rawBody, signatureHeader, options = {}) {
    if (!verifyWaffoWebhookSignature(rawBody, signatureHeader, publicKey, options)) return { ok: false, code: 'INVALID_SIGNATURE' };
    let event;
    try { event = JSON.parse(rawBody); } catch { return { ok: false, code: 'INVALID_JSON' }; }
    if (event.eventType !== 'order.completed') return { ok: false, code: 'UNSUPPORTED_EVENT', status: 'pending_review' };
    const pendingOrder = await repository.getPendingOrder(event.data?.orderMerchantExternalId);
    const validation = validateCompletedOrder(event, { environment, storeId, pendingOrder });
    if (!validation.ok) return validation;
    const committed = await repository.commitFulfillment({ paymentId: validation.paymentId, localOrderId: validation.localOrderId, userId: validation.userId, credits: validation.credits, eventKey: validation.eventKey, event });
    if (committed?.duplicate) return { ok: true, duplicate: true, paymentId: validation.paymentId, localOrderId: validation.localOrderId };
    await onCommitted({ event, ...validation });
    return { ok: true, duplicate: false, paymentId: validation.paymentId, localOrderId: validation.localOrderId, credits: validation.credits };
  };
}
