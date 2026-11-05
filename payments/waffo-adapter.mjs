import { createHash, createSign } from 'node:crypto';
import { CURRENCY, getCreditPack } from './catalog.mjs';

const API_ORIGIN = 'https://api.waffo.ai';
const CHECKOUT_PATH = '/v1/actions/checkout/create-session';

export function getWaffoConfigStatus(config = {}) {
  const missing = [];
  if (config.enabled !== true) missing.push('enabled=true');
  if (config.accountConfirmed !== true) missing.push('accountConfirmed=true');
  if (!config.merchantId) missing.push('merchantId');
  if (!config.privateKey) missing.push('privateKey');
  if (!['test', 'prod'].includes(config.environment)) missing.push('environment(test|prod)');
  if (!config.productIds || typeof config.productIds !== 'object') missing.push('productIds');
  return { configured: missing.length === 0, missing };
}

export function validatePendingOrder(order) {
  if (!order || typeof order !== 'object') return { ok: false, code: 'PENDING_ORDER_REQUIRED' };
  const pack = getCreditPack(order.packId);
  if (!pack) return { ok: false, code: 'PENDING_ORDER_PACK_INVALID' };
  if (![order.orderId, order.userId, order.productId].every((value) => typeof value === 'string' && value.length > 0)) return { ok: false, code: 'PENDING_ORDER_IDENTITY_INVALID' };
  if (order.currency !== CURRENCY || order.amountCents !== pack.amountCents || order.productId.length === 0) return { ok: false, code: 'PENDING_ORDER_SNAPSHOT_MISMATCH' };
  return { ok: true, pack };
}

function signApiRequest(method, path, timestamp, body, privateKey) {
  const bodyHash = createHash('sha256').update(body).digest('base64');
  const canonical = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
  return createSign('RSA-SHA256').update(canonical).sign(privateKey, 'base64');
}

export function buildCheckoutRequest(config, input, { nowMs = Date.now(), apiOrigin = API_ORIGIN } = {}) {
  const status = getWaffoConfigStatus(config);
  if (!status.configured) return { ok: false, code: 'PAYMENTS_UNCONFIGURED', missing: status.missing };
  const pending = validatePendingOrder(input?.pendingOrder);
  if (!pending.ok) return pending;
  const { pack } = pending;
  const productId = config.productIds[pack.id];
  if (typeof productId !== 'string' || productId.length === 0 || productId !== input.pendingOrder.productId) return { ok: false, code: 'PRODUCT_RESOURCE_MISMATCH', packId: pack.id };

  const body = JSON.stringify({
    productId,
    currency: CURRENCY,
    orderMerchantExternalId: input.pendingOrder.orderId,
    metadata: {
      localOrderId: input.pendingOrder.orderId,
      userId: input.pendingOrder.userId,
      packId: pack.id,
      productId,
      currency: CURRENCY,
      amountCents: pack.amountCents,
    },
  });
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    ok: true,
    url: `${apiOrigin}${CHECKOUT_PATH}`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Merchant-Id': config.merchantId,
      'X-Timestamp': timestamp,
      'X-Signature': signApiRequest('POST', CHECKOUT_PATH, timestamp, body, config.privateKey),
    },
    body,
    environment: config.environment,
    pendingOrder: { ...input.pendingOrder },
  };
}

export function createWaffoAdapter(config, { fetchImpl = globalThis.fetch, apiOrigin = API_ORIGIN } = {}) {
  return {
    status: () => getWaffoConfigStatus(config),
    async createCheckout(input, options = {}) {
      const request = buildCheckoutRequest(config, input, { ...options, apiOrigin });
      if (!request.ok) return request;
      if (typeof fetchImpl !== 'function') return { ok: false, code: 'HTTP_CLIENT_UNAVAILABLE' };
      try {
        const timeoutMs = options.timeoutMs ?? 10_000;
        const signal = options.signal ?? (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
        const response = await fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body, signal });
        const raw = await response.text();
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        return { ok: response.ok, status: response.status, data, environment: request.environment };
      } catch (error) {
        return { ok: false, code: 'CHECKOUT_UNKNOWN', retryable: false, message: error instanceof Error ? error.message : 'Checkout result is unknown.' };
      }
    },
  };
}
