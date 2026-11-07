import { CURRENCY, getCreditPack } from '../payments/catalog.mjs';
import { billingMode, paypalConfig } from './billing-config.mjs';

const API_TIMEOUT_MS = 10_000;

function timeoutSignal(timeoutMs) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
}

function jsonOrNull(response) {
  return response.json().catch(() => null);
}

function requireString(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

export function validatePaypalPendingOrder(order) {
  const pack = getCreditPack(order?.packId);
  if (!pack) return { ok: false, code: 'UNKNOWN_PACK' };
  if (![order.orderId, order.userId].every((value) => typeof value === 'string' && value.length > 0)) return { ok: false, code: 'ORDER_IDENTITY_INVALID' };
  if (order.currency !== CURRENCY || order.amountCents !== pack.amountCents) return { ok: false, code: 'ORDER_AMOUNT_MISMATCH' };
  if (order.environment !== 'test' && order.environment !== 'prod') return { ok: false, code: 'ORDER_ENVIRONMENT_INVALID' };
  return { ok: true, pack };
}

export function buildPaypalCreateOrderBody(order, options = {}) {
  const valid = validatePaypalPendingOrder(order);
  if (!valid.ok) return valid;
  const returnUrl = options.returnUrl ?? order.returnUrl;
  const cancelUrl = options.cancelUrl ?? order.cancelUrl;
  if (typeof order.merchantId !== 'string' || order.merchantId.length === 0) return { ok: false, code: 'PAYPAL_MERCHANT_ID_MISSING' };
  if (![returnUrl, cancelUrl].every((value) => typeof value === 'string' && value.startsWith('https://'))) return { ok: false, code: 'RETURN_URL_INVALID' };
  return {
    ok: true,
    body: {
      intent: 'CAPTURE',
      payment_source: {
        paypal: {
          experience_context: {
            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
      purchase_units: [{
        reference_id: order.orderId,
        custom_id: order.orderId,
        invoice_id: order.orderId,
        amount: { currency_code: CURRENCY, value: (order.amountCents / 100).toFixed(2) },
        payee: { merchant_id: order.merchantId },
        description: `Fancy Cafe AI - ${valid.pack.credits} credits`,
      }],
    },
  };
}

function payerActionLink(order, environment, providerOrderId) {
  const host = environment === 'prod' ? 'www.paypal.com' : 'www.sandbox.paypal.com';
  const link = Array.isArray(order?.links) ? order.links.find((item) => item?.rel === 'payer-action') : null;
  if (!link?.href) return null;
  try {
    const url = new URL(link.href);
    return url.protocol === 'https:' && url.hostname === host && url.pathname === '/checkoutnow' && url.searchParams.get('token') === providerOrderId && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

export function parsePaypalCreateOrderResponse(payload, environment) {
  const id = payload?.id;
  const checkoutUrl = payerActionLink(payload, environment, id);
  if (typeof id !== 'string' || payload.status !== 'PAYER_ACTION_REQUIRED' || !checkoutUrl) return { ok: false, code: 'PAYPAL_CREATE_RESPONSE_INVALID' };
  return { ok: true, providerOrderId: id, checkoutUrl, status: payload.status };
}

export function validatePaypalOrderSnapshot(order, expected) {
  if (!order || order.id !== expected.providerOrderId || order.intent !== 'CAPTURE') return { ok: false, code: 'PAYPAL_ORDER_MISMATCH' };
  if (order.status !== 'APPROVED' && order.status !== 'COMPLETED') return { ok: false, code: 'PAYPAL_ORDER_NOT_APPROVED' };
  if (order.payment_source && !order.payment_source.paypal) return { ok: false, code: 'PAYPAL_PAYMENT_SOURCE_MISMATCH' };
  if (!Array.isArray(order.purchase_units) || order.purchase_units.length !== 1) return { ok: false, code: 'PAYPAL_PURCHASE_UNIT_MISMATCH' };
  const unit = order.purchase_units[0];
  if (unit.reference_id !== expected.orderId || unit.custom_id !== expected.orderId || unit.invoice_id !== expected.orderId) return { ok: false, code: 'PAYPAL_ORDER_BINDING_MISMATCH' };
  if (unit.payee?.merchant_id !== expected.merchantId) return { ok: false, code: 'PAYPAL_MERCHANT_MISMATCH' };
  if (unit.amount?.currency_code !== CURRENCY || unit.amount?.value !== (expected.amountCents / 100).toFixed(2)) return { ok: false, code: 'PAYPAL_AMOUNT_MISMATCH' };
  return { ok: true, unit };
}

export function parsePaypalCaptureResponse(payload, expected) {
  const units = payload?.purchase_units;
  const captures = units?.length === 1 ? units[0]?.payments?.captures : null;
  if (payload?.status !== 'COMPLETED' || !Array.isArray(captures) || captures.length !== 1) return { ok: false, code: 'PAYPAL_CAPTURE_RESPONSE_INVALID' };
  const capture = captures[0];
  if (capture.status !== 'COMPLETED' || capture.final_capture !== true || capture.amount?.currency_code !== CURRENCY || capture.amount?.value !== (expected.amountCents / 100).toFixed(2)) return { ok: false, code: 'PAYPAL_CAPTURE_AMOUNT_INVALID' };
  if (typeof capture.id !== 'string' || capture.id.length === 0) return { ok: false, code: 'PAYPAL_CAPTURE_ID_MISSING' };
  return { ok: true, paymentId: capture.id, credits: getCreditPack(expected.packId)?.credits ?? 0 };
}

export function createPaypalAdapter(env, { fetchImpl = globalThis.fetch, timeoutMs = API_TIMEOUT_MS } = {}) {
  const mode = billingMode(env);
  const config = paypalConfig(env, mode);
  async function requestToken() {
    const auth = btoa(`${requireString(config.clientId, 'PAYPAL_CLIENT_ID_MISSING')}:${requireString(config.clientSecret, 'PAYPAL_CLIENT_SECRET_MISSING')}`);
    const response = await fetchImpl(`${config.baseUrl}/v1/oauth2/token`, { method: 'POST', redirect: 'manual', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: timeoutSignal(timeoutMs) });
    const payload = await jsonOrNull(response);
    if (!response.ok || typeof payload?.access_token !== 'string') throw new Error('PAYPAL_TOKEN_FAILED');
    return payload.access_token;
  }
  async function api(path, options = {}) {
    const token = await requestToken();
    const response = await fetchImpl(`${config.baseUrl}${path}`, { ...options, redirect: 'manual', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers || {}) }, signal: options.signal ?? timeoutSignal(timeoutMs) });
    return { response, payload: await jsonOrNull(response) };
  }
  return {
    config,
    getAccessToken: requestToken,
    async createOrder(order) {
      const body = buildPaypalCreateOrderBody(order, { returnUrl: order.returnUrl, cancelUrl: order.cancelUrl });
      if (!body.ok) return body;
      try {
        const result = await api('/v2/checkout/orders', { method: 'POST', headers: { 'PayPal-Request-Id': `create-${order.orderId}`, Prefer: 'return=representation' }, body: JSON.stringify(body.body) });
        if (!result.response.ok) return { ok: false, code: 'PAYPAL_CREATE_FAILED', status: result.response.status };
        return parsePaypalCreateOrderResponse(result.payload, mode);
      } catch (error) { return { ok: false, code: 'PAYPAL_CREATE_UNKNOWN', retryable: false, message: error instanceof Error ? error.message : 'PayPal create result is unknown.' }; }
    },
    async captureOrder(order) {
      if (typeof order.providerOrderId !== 'string' || !order.providerOrderId) return { ok: false, code: 'PAYPAL_ORDER_ID_MISSING' };
      const expected = { ...order, merchantId: config.merchantId, providerOrderId: order.providerOrderId };
      const snapshotResult = await this.getOrder(order.providerOrderId);
      if (!snapshotResult.ok) return snapshotResult;
      const precheck = validatePaypalOrderSnapshot(snapshotResult.order, expected);
      if (!precheck.ok) return precheck;
      if (snapshotResult.order?.status === 'COMPLETED') {
        const recovered = parseCompletedCaptureFromOrder(snapshotResult.order, order);
        return recovered.ok ? recovered : { ok: false, code: 'PAYPAL_CAPTURE_NOT_COMPLETE', retryable: false };
      }
      let captureResponse = null;
      try {
        const capture = await api(`/v2/checkout/orders/${encodeURIComponent(order.providerOrderId)}/capture`, { method: 'POST', headers: { 'PayPal-Request-Id': `capture-${order.orderId}`, Prefer: 'return=representation' }, body: '{}' });
        if (capture.response.ok) captureResponse = capture.payload;
      } catch { /* The follow-up GET below is authoritative after a timeout. */ }
      const after = await this.getOrder(order.providerOrderId);
      if (!after.ok) return { ok: false, code: 'PAYPAL_CAPTURE_UNKNOWN', retryable: false };
      const validOrder = validatePaypalOrderSnapshot(after.order, expected);
      if (!validOrder.ok) return validOrder;
      const recovered = parseCompletedCaptureFromOrder(after.order, order);
      if (!recovered.ok) return { ok: false, code: 'PAYPAL_CAPTURE_FAILED', retryable: false };
      if (captureResponse) {
        const announced = parsePaypalCaptureResponse(captureResponse, order);
        if (announced.ok && announced.paymentId !== recovered.paymentId) return { ok: false, code: 'PAYPAL_CAPTURE_ID_MISMATCH', retryable: false };
      }
      return recovered;
    },
    async getOrder(providerOrderId) {
      if (typeof providerOrderId !== 'string' || providerOrderId.length === 0) return { ok: false, code: 'PAYPAL_ORDER_ID_MISSING' };
      try {
        const result = await api(`/v2/checkout/orders/${encodeURIComponent(providerOrderId)}`, { method: 'GET' });
        return result.response.ok ? { ok: true, order: result.payload } : { ok: false, code: 'PAYPAL_ORDER_LOOKUP_FAILED', status: result.response.status };
      } catch (error) { return { ok: false, code: 'PAYPAL_ORDER_LOOKUP_UNKNOWN', retryable: false, message: error instanceof Error ? error.message : 'PayPal order lookup is unknown.' }; }
    },
  };
}

export function parseCompletedCaptureFromOrder(order, expected) {
  const units = order?.purchase_units;
  const captures = units?.length === 1 ? units[0]?.payments?.captures : null;
  const capture = Array.isArray(captures) && captures.length === 1 ? captures[0] : null;
  if (!capture) return { ok: false, code: 'PAYPAL_CAPTURE_NOT_FOUND' };
  return parsePaypalCaptureResponse({ status: 'COMPLETED', purchase_units: [{ payments: { captures: [capture] } }] }, expected);
}
