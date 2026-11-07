import { getCreditPack, listCreditPacks } from '../payments/catalog.mjs';
import { getGenerationBalance } from './generation-store.mjs';
import { billingConfigStatus, billingProvider, paypalConfig } from './billing-config.mjs';
import { createPaypalAdapter, parseCompletedCaptureFromOrder, validatePaypalOrderSnapshot } from './paypal-adapter.mjs';
import { extractPaypalWebhookResource, hashWebhookBody, paypalWebhookHeadersComplete, SUPPORTED_EVENTS, verifyPaypalWebhook, webhookBodySizeAllowed } from './paypal-webhook.mjs';

const API_ORIGIN = 'https://api.waffo.ai';
const CHECKOUT_PATH = '/v1/actions/checkout/create-session';
const SIGNATURE_AGE_MS = 45 * 60 * 1000;
const CANONICAL_HOST = 'fancycafeaivideo.pro';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function nowIso() { return new Date().toISOString(); }
function activeMode(env) { return env?.WAFFO_MODE === 'production' || env?.WAFFO_MODE === 'prod' ? 'prod' : 'test'; }
function databaseForMode(env, mode) { return mode === 'test' ? env?.BILLING_TEST_DB : env?.APP_DB; }
function enabled(env, production = false) { return env?.WAFFO_ENABLED === 'true' && (!production || env?.WAFFO_PRODUCTION_ENABLED === 'true'); }
function config(env, mode) {
  const production = mode === 'prod';
  const prefix = production ? 'WAFFO_PRODUCTION_' : 'WAFFO_TEST_';
  return {
    mode,
    enabled: enabled(env, production),
    merchantId: env?.[`${prefix}MERCHANT_ID`],
    privateKey: env?.[`${prefix}PRIVATE_KEY`],
    publicKey: env?.[`${prefix}WEBHOOK_PUBLIC_KEY`],
    storeId: env?.[`${prefix}STORE_ID`],
    products: { 'credits-20': env?.[`${prefix}PRODUCT_20`], 'credits-60': env?.[`${prefix}PRODUCT_60`], 'credits-200': env?.[`${prefix}PRODUCT_200`] },
  };
}
function dbReady(env, mode) { const db = databaseForMode(env, mode); return db && typeof db.prepare === 'function' && typeof db.batch === 'function'; }
function dbError() { return json({ ok: false, code: 'PAYMENTS_UNCONFIGURED', message: 'Payment storage is not configured.' }, 503); }
function centsString(value) { if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null; const [whole, fraction = ''] = value.split('.'); return Number(whole) * 100 + Number(fraction.padEnd(2, '0')); }
function allowedCheckoutUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443') && ['checkout.waffo.ai', 'pancake.waffo.ai'].includes(url.hostname); } catch { return false; } }
function reusableCheckout(order) { if (order?.status !== 'pending' || !allowedCheckoutUrl(order.checkoutUrl)) return false; const expiresAt = Date.parse(order.expiresAt ?? ''); return Number.isFinite(expiresAt) && expiresAt > Date.now(); }

export function getPaymentStatus(env = {}) {
  const mode = activeMode(env);
  const provider = billingProvider(env);
  if (provider === 'paypal') {
    const status = billingConfigStatus(env);
    const test = billingConfigStatus({ ...env, WAFFO_MODE: 'test' });
    const production = billingConfigStatus({ ...env, WAFFO_MODE: 'production' });
    return { mode, provider: 'paypal', paymentMode: status.configured ? mode : 'disabled', checkoutEnabled: status.configured, missing: status.missing, testDatabaseConfigured: Boolean(env.BILLING_TEST_DB), productionDatabaseConfigured: Boolean(env.APP_DB), testConfigured: test.configured, productionConfigured: production.configured };
  }
  if (provider === 'unsupported') return { mode, provider, paymentMode: 'disabled', checkoutEnabled: false, testDatabaseConfigured: Boolean(env.BILLING_TEST_DB), productionDatabaseConfigured: Boolean(env.APP_DB), testConfigured: false, productionConfigured: false };
  const cfg = config(env, mode);
  const productsReady = Object.values(cfg.products).every((value) => typeof value === 'string' && value.length > 0);
  const configured = cfg.enabled && Boolean(cfg.merchantId && cfg.privateKey && cfg.publicKey && cfg.storeId && productsReady && dbReady(env, mode));
  const complete = (candidate, candidateMode) => candidate.enabled && Boolean(candidate.merchantId && candidate.privateKey && candidate.publicKey && candidate.storeId && Object.values(candidate.products).every((value) => typeof value === 'string' && value.length > 0) && dbReady(env, candidateMode));
  return { mode, provider: 'waffo', paymentMode: configured ? mode : 'disabled', checkoutEnabled: configured, testDatabaseConfigured: Boolean(env.BILLING_TEST_DB), productionDatabaseConfigured: Boolean(env.APP_DB), testConfigured: complete(config(env, 'test'), 'test'), productionConfigured: complete(config(env, 'prod'), 'prod') };
}

function allowedPaypalCheckoutUrl(value, mode) {
  try {
    const url = new URL(value);
    const expectedHost = mode === 'prod' ? 'www.paypal.com' : 'www.sandbox.paypal.com';
    return url.protocol === 'https:' && url.hostname === expectedHost && !url.username && !url.password && !url.port;
  } catch { return false; }
}

function paypalReusableCheckout(order, mode) {
  if (order?.paymentProvider !== 'paypal' || order.status !== 'pending' || !order.providerOrderId || !allowedPaypalCheckoutUrl(order.checkoutUrl, mode)) return false;
  try { return new URL(order.checkoutUrl).searchParams.get('token') === order.providerOrderId; } catch { return false; }
}

function base64(bytes) { let result = ''; for (let i = 0; i < bytes.length; i += 0x8000) result += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(result); }
function fromBase64(value) { const raw = atob(value.replace(/\s/g, '')); return Uint8Array.from(raw, (char) => char.charCodeAt(0)); }
function pemBytes(pem) { return fromBase64(pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, '')); }
function derLength(length) { if (length < 128) return Uint8Array.of(length); const bytes = []; for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 255); return Uint8Array.from([0x80 | bytes.length, ...bytes]); }
function pkcs1ToPkcs8(pem) { const body = pemBytes(pem); const algorithm = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]); const version = Uint8Array.of(0x02, 0x01, 0x00); const octetLength = derLength(body.length); const octet = Uint8Array.from([0x04, ...octetLength, ...body]); const content = Uint8Array.from([...version, ...algorithm, ...octet]); return Uint8Array.from([0x30, ...derLength(content.length), ...content]); }
function privateKeyBytes(pem) { return /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1ToPkcs8(pem) : pemBytes(pem); }
async function signRequest(body, modeConfig, timestamp, cryptoImpl = globalThis.crypto) {
  const key = await cryptoImpl.subtle.importKey('pkcs8', privateKeyBytes(modeConfig.privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const canonical = `POST\n${CHECKOUT_PATH}\n${timestamp}\n${base64(new Uint8Array(digest))}`;
  const signature = await cryptoImpl.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(canonical));
  return base64(new Uint8Array(signature));
}
function parseSignature(header) { const result = {}; for (const pair of String(header || '').split(',')) { const index = pair.indexOf('='); if (index > 0) result[pair.slice(0, index).trim()] = pair.slice(index + 1).trim(); } return result.t && result.v1 ? result : null; }
export async function verifyWaffoWebhook(rawBody, signatureHeader, publicKey, { now = Date.now(), cryptoImpl = globalThis.crypto } = {}) {
  const parsed = parseSignature(signatureHeader);
  if (!parsed || !publicKey) return false;
  const timestamp = Number(parsed.t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > SIGNATURE_AGE_MS) return false;
  try {
    const key = await cryptoImpl.subtle.importKey('spki', pemBytes(publicKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return cryptoImpl.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64(parsed.v1), new TextEncoder().encode(`${parsed.t}.${rawBody}`));
  } catch { return false; }
}
async function authDependency(deps) { if (deps?.auth) return deps.auth; try { return await import('./auth.mjs'); } catch { return null; } }
async function sessionFor(request, env, deps) { const auth = await authDependency(deps); return auth?.getSession ? auth.getSession(request, env) : null; }
async function csrfFor(request, session, env, deps) { const auth = await authDependency(deps); if (!auth?.requireSameOriginAndCsrf) return false; const result = await auth.requireSameOriginAndCsrf(request, session, env); return result === true || result?.ok === true; }
function sessionUser(session) { return typeof session?.userId === 'string' && session.userId ? session.userId : null; }

async function createPaypalCheckout(db, mode, env, session, body, deps) {
  const pack = getCreditPack(body?.packId);
  if (!pack || typeof body?.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(body.requestId)) return json({ ok: false, code: 'INVALID_REQUEST' }, 400);
  const existing = await db.prepare('SELECT order_id AS orderId, pack_id AS packId, user_id AS userId, payment_provider AS paymentProvider, provider_order_id AS providerOrderId, status, checkout_url AS checkoutUrl FROM payment_orders WHERE user_id = ? AND request_id = ?').bind(session.userId, body.requestId).first();
  if (existing) {
    if (existing.packId !== pack.id) return json({ ok: false, code: 'REQUEST_ID_PACK_MISMATCH' }, 409);
    if (existing.paymentProvider !== 'paypal') return json({ ok: false, code: 'PAYMENT_PROVIDER_MISMATCH' }, 409);
    return json({ ok: true, provider: 'paypal', order: existing, checkoutUrl: paypalReusableCheckout(existing, mode) ? existing.checkoutUrl : null, retryable: false, duplicate: true });
  }
  const orderId = crypto.randomUUID();
  const merchantId = env[mode === 'prod' ? 'PAYPAL_PRODUCTION_MERCHANT_ID' : 'PAYPAL_TEST_MERCHANT_ID'];
  const now = nowIso();
  try {
    await db.prepare('INSERT INTO payment_orders (order_id, request_id, user_id, pack_id, product_id, currency, amount_cents, environment, status, payment_provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(orderId, body.requestId, session.userId, pack.id, 'paypal', 'USD', pack.amountCents, mode, 'pending', 'paypal', now, now).run();
  } catch {
    const raced = await db.prepare('SELECT order_id AS orderId, pack_id AS packId, user_id AS userId, payment_provider AS paymentProvider, provider_order_id AS providerOrderId, status, checkout_url AS checkoutUrl FROM payment_orders WHERE user_id = ? AND request_id = ?').bind(session.userId, body.requestId).first();
    if (!raced) return json({ ok: false, code: 'ORDER_CREATE_RETRY' }, 503);
    if (raced.packId !== pack.id) return json({ ok: false, code: 'REQUEST_ID_PACK_MISMATCH' }, 409);
    return json({ ok: true, provider: 'paypal', order: raced, checkoutUrl: paypalReusableCheckout(raced, mode) ? raced.checkoutUrl : null, retryable: false, duplicate: true });
  }
  const adapter = createPaypalAdapter(env, { fetchImpl: deps?.fetch ?? fetch });
  const result = await adapter.createOrder({ orderId, userId: session.userId, packId: pack.id, currency: 'USD', amountCents: pack.amountCents, environment: mode, merchantId, returnUrl: `https://${CANONICAL_HOST}/pricing?order=${encodeURIComponent(orderId)}&paypal_return=1`, cancelUrl: `https://${CANONICAL_HOST}/pricing?order=${encodeURIComponent(orderId)}&paypal_cancel=1` });
  if (!result.ok) {
    await db.prepare('UPDATE payment_orders SET status = ?, updated_at = ? WHERE order_id = ?').bind('checkout_unknown', nowIso(), orderId).run();
    return json({ ok: false, code: result.code, retryable: false, orderId }, 502);
  }
  await db.prepare('UPDATE payment_orders SET provider_order_id = ?, checkout_url = ?, updated_at = ? WHERE order_id = ?').bind(result.providerOrderId, result.checkoutUrl, nowIso(), orderId).run();
  return json({ ok: true, provider: 'paypal', checkoutUrl: result.checkoutUrl, order: { orderId, packId: pack.id, amountCents: pack.amountCents, currency: 'USD', providerOrderId: result.providerOrderId } });
}

export async function commitPaypalCapture(db, row, capture, mode) {
  const duplicate = await db.prepare('SELECT payment_id AS paymentId, order_id AS orderId, user_id AS userId FROM payment_fulfillments WHERE payment_id = ? OR order_id = ?').bind(capture.paymentId, row.order_id).first();
  if (duplicate) {
    if (duplicate.paymentId !== capture.paymentId || duplicate.orderId !== row.order_id || duplicate.userId !== row.user_id) return { ok: false, code: 'FULFILLMENT_CONFLICT', status: 409 };
    return { ok: true, duplicate: true, paymentId: capture.paymentId };
  }
  const now = nowIso();
  try {
    await db.batch([
      db.prepare('INSERT INTO payment_fulfillments (payment_id, order_id, user_id, credits, event_type, event_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM payment_orders WHERE order_id = ? AND environment = ? AND payment_provider = \'paypal\' AND status IN (\'pending\', \'checkout_unknown\'))').bind(capture.paymentId, row.order_id, row.user_id, capture.credits, 'paypal.capture.completed', capture.paymentId, now, row.order_id, mode),
      db.prepare('INSERT INTO credit_ledger (user_id, order_id, payment_id, credits, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM payment_fulfillments WHERE payment_id = ? AND order_id = ?)').bind(row.user_id, row.order_id, capture.paymentId, capture.credits, now, capture.paymentId, row.order_id),
      db.prepare('UPDATE payment_orders SET status = ?, provider_capture_id = ?, updated_at = ? WHERE order_id = ? AND environment = ? AND payment_provider = \'paypal\' AND status IN (\'pending\', \'checkout_unknown\')').bind('paid', capture.paymentId, now, row.order_id, mode),
    ]);
    const after = await db.prepare('SELECT payment_id AS paymentId, order_id AS orderId, user_id AS userId FROM payment_fulfillments WHERE payment_id = ? OR order_id = ?').bind(capture.paymentId, row.order_id).first();
    if (!after) {
      const current = await db.prepare('SELECT status FROM payment_orders WHERE order_id = ? AND environment = ?').bind(row.order_id, mode).first();
      return current?.status === 'refund_pending' ? { ok: false, code: 'REFUND_PENDING', status: 409 } : { ok: false, code: 'FULFILLMENT_RETRY', status: 503 };
    }
    return { ok: true, duplicate: false, paymentId: capture.paymentId, credits: capture.credits };
  } catch {
    const after = await db.prepare('SELECT payment_id AS paymentId, order_id AS orderId, user_id AS userId FROM payment_fulfillments WHERE payment_id = ? OR order_id = ?').bind(capture.paymentId, row.order_id).first();
    if (!after) return { ok: false, code: 'FULFILLMENT_RETRY', status: 503 };
    if (after.paymentId !== capture.paymentId || after.orderId !== row.order_id || after.userId !== row.user_id) return { ok: false, code: 'FULFILLMENT_CONFLICT', status: 409 };
    return { ok: true, duplicate: true, paymentId: capture.paymentId };
  }
}

async function recordPaypalWebhook(db, event, mode, rawBody, resource, row, status) {
  const payloadHash = await hashWebhookBody(rawBody);
  try {
    await db.prepare('INSERT INTO paypal_webhook_events (event_id, event_type, resource_id, local_order_id, user_id, environment, status, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(event.id, event.event_type, resource.captureId, row?.order_id ?? null, row?.user_id ?? null, mode, status, payloadHash, nowIso()).run();
    return { duplicate: false };
  } catch {
    const existing = await db.prepare('SELECT event_id FROM paypal_webhook_events WHERE event_id = ?').bind(event.id).first();
    if (existing) return { duplicate: true };
    throw new Error('PAYPAL_WEBHOOK_RECORD_RETRY');
  }
}

async function markPaypalRefundPending(db, event, mode, rawBody, resource, row) {
  if (!row || !resource.captureId) return { ok: false, code: 'PAYPAL_REFUND_BINDING_MISSING', status: 400 };
  if (row.provider_capture_id && row.provider_capture_id !== resource.captureId) return { ok: false, code: 'PAYPAL_CAPTURE_MISMATCH', status: 400 };
  const payloadHash = await hashWebhookBody(rawBody);
  try {
    await db.batch([
      db.prepare('INSERT INTO paypal_webhook_events (event_id, event_type, resource_id, local_order_id, user_id, environment, status, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(event.id, event.event_type, resource.captureId, row.order_id, row.user_id, mode, 'pending_review', payloadHash, nowIso()),
      db.prepare('UPDATE payment_orders SET status = ? WHERE order_id = ? AND payment_provider = ? AND environment = ? AND status IN (\'pending\', \'checkout_unknown\', \'paid\', \'refund_pending\')').bind('refund_pending', row.order_id, 'paypal', mode),
    ]);
    return { ok: true, duplicate: false };
  } catch {
    const existing = await db.prepare('SELECT event_id FROM paypal_webhook_events WHERE event_id = ?').bind(event.id).first();
    if (existing) return { ok: true, duplicate: true };
    return { ok: false, code: 'WEBHOOK_RECORD_RETRY', status: 503 };
  }
}

async function paypalWebhook(request, env, mode, deps) {
  if (activeMode(env) !== mode) return json({ ok: false, code: 'ENVIRONMENT_DISABLED' }, 409);
  if (billingProvider(env) !== 'paypal') return json({ ok: false, code: 'PAYMENTS_UNCONFIGURED' }, 503);
  const db = databaseForMode(env, mode);
  if (!dbReady(env, mode)) return dbError();
  if (!webhookBodySizeAllowed(request)) return json({ ok: false, code: 'PAYLOAD_TOO_LARGE' }, 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 256 * 1024) return json({ ok: false, code: 'PAYLOAD_TOO_LARGE' }, 413);
  if (!paypalWebhookHeadersComplete(request.headers)) return json({ ok: false, code: 'PAYPAL_WEBHOOK_HEADERS_MISSING' }, 401);
  const adapter = createPaypalAdapter(env, { fetchImpl: deps?.fetch ?? fetch });
  let token;
  try { token = await adapter.getAccessToken(); } catch { return json({ ok: false, code: 'PAYPAL_VERIFY_UNAVAILABLE' }, 503); }
  let verified;
  try { verified = await verifyPaypalWebhook(rawBody, request.headers, adapter.config, { fetchImpl: deps?.fetch ?? fetch, accessToken: token }); } catch { return json({ ok: false, code: 'PAYPAL_VERIFY_UNAVAILABLE' }, 503); }
  if (!verified.ok) return json({ ok: false, code: verified.code }, verified.code === 'INVALID_JSON' ? 400 : 401);
  const event = verified.event;
  if (typeof event?.id !== 'string' || typeof event.event_type !== 'string') return json({ ok: false, code: 'INVALID_EVENT' }, 400);
  const resource = extractPaypalWebhookResource(event, mode);
  let row = resource.providerOrderId ? await db.prepare('SELECT * FROM payment_orders WHERE provider_order_id = ? AND payment_provider = ? AND environment = ?').bind(resource.providerOrderId, 'paypal', mode).first() : null;
  if (!row && resource.captureId) row = await db.prepare('SELECT o.* FROM payment_orders o LEFT JOIN payment_fulfillments f ON f.order_id = o.order_id WHERE o.payment_provider = ? AND o.environment = ? AND (o.provider_capture_id = ? OR f.payment_id = ?)').bind('paypal', mode, resource.captureId, resource.captureId).first();
  if (!SUPPORTED_EVENTS.has(event.event_type)) {
    try { const recorded = await recordPaypalWebhook(db, event, mode, rawBody, resource, row, 'pending_review'); return json({ ok: true, status: 'pending_review', duplicate: recorded.duplicate }); } catch { return json({ ok: false, code: 'WEBHOOK_RECORD_RETRY' }, 503); }
  }
  if (!row && event.event_type === 'PAYMENT.CAPTURE.COMPLETED') return json({ ok: false, code: 'ORDER_MISMATCH' }, 400);
  if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
    if (event.event_type.includes('REFUND') || event.event_type.endsWith('REVERSED')) {
      const refunded = await markPaypalRefundPending(db, event, mode, rawBody, resource, row);
      return refunded.ok ? json({ ok: true, status: 'pending_review', duplicate: refunded.duplicate }) : json({ ok: false, code: refunded.code }, refunded.status ?? 503);
    }
    try { const recorded = await recordPaypalWebhook(db, event, mode, rawBody, resource, row, 'pending_review'); return json({ ok: true, status: 'pending_review', duplicate: recorded.duplicate }); } catch { return json({ ok: false, code: 'WEBHOOK_RECORD_RETRY' }, 503); }
  }
  if (row.status === 'refund_pending') return json({ ok: false, code: 'REFUND_PENDING' }, 409);
  const fullOrder = await adapter.getOrder(resource.providerOrderId);
  if (!fullOrder.ok) return json({ ok: false, code: fullOrder.code, retryable: false }, 502);
  const snapshot = validatePaypalOrderSnapshot(fullOrder.order, { orderId: row.order_id, providerOrderId: row.provider_order_id, amountCents: row.amount_cents, merchantId: adapter.config.merchantId });
  if (!snapshot.ok) return json({ ok: false, code: snapshot.code }, 400);
  const capture = parseCompletedCaptureFromOrder(fullOrder.order, { ...row, orderId: row.order_id, providerOrderId: row.provider_order_id, packId: row.pack_id, amountCents: row.amount_cents, merchantId: adapter.config.merchantId });
  if (!capture.ok || capture.paymentId !== resource.captureId) return json({ ok: false, code: capture.ok ? 'PAYPAL_CAPTURE_ID_MISMATCH' : capture.code }, 400);
  const committed = await commitPaypalCapture(db, row, capture, mode);
  if (!committed.ok) return json({ ok: false, code: committed.code }, committed.status ?? 503);
  try { const recorded = await recordPaypalWebhook(db, event, mode, rawBody, resource, row, 'processed'); return json({ ok: true, duplicate: committed.duplicate || recorded.duplicate, paymentId: capture.paymentId, credits: committed.credits ?? getCreditPack(row.pack_id).credits }); } catch { return json({ ok: false, code: 'WEBHOOK_RECORD_RETRY' }, 503); }
}

async function capturePaypalOrder(request, env, session, deps) {
  const body = await request.json().catch(() => null);
  if (typeof body?.orderId !== 'string' || body.orderId.length === 0) return json({ ok: false, code: 'INVALID_REQUEST' }, 400);
  const mode = activeMode(env); const db = databaseForMode(env, mode);
  if (!dbReady(env, mode)) return dbError();
  const paypal = paypalConfig(env, mode);
  if (!paypal.enabled) return json({ ok: false, code: 'PAYMENTS_UNCONFIGURED' }, 503);
  const row = await db.prepare('SELECT * FROM payment_orders WHERE order_id = ? AND user_id = ? AND environment = ? AND payment_provider = ?').bind(body.orderId, session.userId, mode, 'paypal').first();
  if (!row) return json({ ok: false, code: 'NOT_FOUND' }, 404);
  if (row.status === 'refund_pending') return json({ ok: false, code: 'REFUND_PENDING' }, 409);
  if (row.status === 'paid') return json({ ok: true, provider: 'paypal', duplicate: true, orderId: row.order_id, status: row.status });
  if (!row.provider_order_id) return json({ ok: false, code: 'PAYPAL_ORDER_NOT_READY' }, 409);
  const adapter = createPaypalAdapter(env, { fetchImpl: deps?.fetch ?? fetch });
  const result = await adapter.captureOrder({ orderId: row.order_id, userId: row.user_id, packId: row.pack_id, currency: row.currency, amountCents: row.amount_cents, environment: mode, providerOrderId: row.provider_order_id });
  if (!result.ok) return json({ ok: false, code: result.code, retryable: result.retryable ?? false }, result.code.endsWith('UNKNOWN') ? 502 : 400);
  const committed = await commitPaypalCapture(db, row, result, mode);
  return json({ ok: committed.ok, provider: 'paypal', ...committed, orderId: row.order_id }, committed.status ?? 200);
}

async function createCheckout(request, env, session, deps) {
  const mode = activeMode(env); const db = databaseForMode(env, mode); const cfg = config(env, mode);
  if (!dbReady(env, mode)) return dbError();
  const body = await request.json().catch(() => null); const pack = getCreditPack(body?.packId);
  if (!pack || typeof body?.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(body.requestId)) return json({ ok: false, code: 'INVALID_REQUEST' }, 400);
  if (!getPaymentStatus(env).checkoutEnabled) return json({ ok: false, code: 'PAYMENTS_UNCONFIGURED' }, 503);
  if (billingProvider(env) === 'paypal') return createPaypalCheckout(db, mode, env, session, body, deps);
  const existing = await db.prepare('SELECT order_id AS orderId, pack_id AS packId, payment_provider AS paymentProvider, status, checkout_session_id AS checkoutSessionId, checkout_url AS checkoutUrl, expires_at AS expiresAt FROM payment_orders WHERE user_id = ? AND request_id = ?').bind(session.userId, body.requestId).first();
  if (existing) {
    if (existing.packId !== pack.id) return json({ ok: false, code: 'REQUEST_ID_PACK_MISMATCH' }, 409);
    if (existing.paymentProvider && existing.paymentProvider !== 'waffo') return json({ ok: false, code: 'PAYMENT_PROVIDER_MISMATCH' }, 409);
    return json({ ok: true, order: existing, checkoutUrl: reusableCheckout(existing) ? existing.checkoutUrl : null, retryable: false, duplicate: true });
  }
  let orderId = existing?.orderId ?? crypto.randomUUID();
  if (!existing) {
    try { await db.prepare('INSERT INTO payment_orders (order_id, request_id, user_id, pack_id, product_id, currency, amount_cents, environment, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(orderId, body.requestId, session.userId, pack.id, cfg.products[pack.id], 'USD', pack.amountCents, mode, 'pending', nowIso(), nowIso()).run(); }
    catch { const raced = await db.prepare('SELECT order_id AS orderId, pack_id AS packId, payment_provider AS paymentProvider, status, checkout_session_id AS checkoutSessionId, checkout_url AS checkoutUrl, expires_at AS expiresAt FROM payment_orders WHERE user_id = ? AND request_id = ?').bind(session.userId, body.requestId).first(); if (!raced) return json({ ok: false, code: 'ORDER_CREATE_RETRY' }, 503); if (raced.packId !== pack.id) return json({ ok: false, code: 'REQUEST_ID_PACK_MISMATCH' }, 409); if (raced.paymentProvider && raced.paymentProvider !== 'waffo') return json({ ok: false, code: 'PAYMENT_PROVIDER_MISMATCH' }, 409); return json({ ok: true, order: raced, checkoutUrl: reusableCheckout(raced) ? raced.checkoutUrl : null, retryable: false, duplicate: true }); }
  }
  const payload = JSON.stringify({ productId: cfg.products[pack.id], currency: 'USD', buyerEmail: session.email, successUrl: `https://${CANONICAL_HOST}/pricing?order=${encodeURIComponent(orderId)}`, allowPromotionCodes: false, orderMerchantExternalId: orderId, metadata: { localOrderId: orderId, userId: session.userId, packId: pack.id, productId: cfg.products[pack.id], amountCents: pack.amountCents, currency: 'USD' } });
  const stamp = String(Math.floor(Date.now() / 1000)); let response;
  try { const signature = await signRequest(payload, cfg, stamp, deps?.crypto ?? globalThis.crypto); const signal = deps?.signal ?? (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined); response = await (deps?.fetch ?? fetch)(`${API_ORIGIN}${CHECKOUT_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Merchant-Id': cfg.merchantId, 'X-Timestamp': stamp, 'X-Signature': signature, 'X-Idempotency-Key': orderId }, body: payload, signal }); }
  catch { await db.prepare('UPDATE payment_orders SET status = ?, updated_at = ? WHERE order_id = ?').bind('checkout_unknown', nowIso(), orderId).run(); return json({ ok: false, code: 'CHECKOUT_UNKNOWN', retryable: false, orderId }, 502); }
  const envelope = await response.json().catch(() => null); const data = envelope?.data;
  if (!response.ok || !data?.sessionId || !data?.checkoutUrl || !allowedCheckoutUrl(data.checkoutUrl)) { await db.prepare('UPDATE payment_orders SET status = ?, updated_at = ? WHERE order_id = ?').bind('checkout_unknown', nowIso(), orderId).run(); return json({ ok: false, code: 'CHECKOUT_UNKNOWN', retryable: false, orderId }, 502); }
  await db.prepare('UPDATE payment_orders SET checkout_session_id = ?, checkout_url = ?, expires_at = ?, updated_at = ? WHERE order_id = ?').bind(data.sessionId, data.checkoutUrl, data.expiresAt ?? null, nowIso(), orderId).run();
  return json({ ok: true, checkoutUrl: data.checkoutUrl, expiresAt: data.expiresAt ?? null, order: { orderId, packId: pack.id, amountCents: pack.amountCents, currency: 'USD' } });
}

async function billing(env, session) { const mode = activeMode(env); const db = databaseForMode(env, mode); if (!dbReady(env, mode)) return dbError(); const balance = await db.prepare('SELECT COALESCE(SUM(credits), 0) AS credits FROM credit_ledger WHERE user_id = ?').bind(session.userId).first(); let generationBalance; try { generationBalance = await getGenerationBalance(env, session.userId); } catch (error) { if (!/no such table:\s*generation_runs/i.test(String(error?.message)) && error?.code !== 'GENERATION_LEDGER_UNAVAILABLE') throw error; generationBalance = { mode, paidCredits: Number(balance?.credits ?? 0), reservedCredits: 0, heldCredits: 0, deliveredCredits: 0, availableCredits: Number(balance?.credits ?? 0) }; } const orders = await db.prepare('SELECT order_id AS orderId, pack_id AS packId, amount_cents AS amountCents, currency, status, payment_provider AS provider, checkout_url AS checkoutUrl, expires_at AS expiresAt, created_at AS createdAt FROM payment_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(session.userId).all(); return json({ ok: true, mode, credits: generationBalance.availableCredits, paidCredits: generationBalance.paidCredits, reservedCredits: generationBalance.reservedCredits, heldCredits: generationBalance.heldCredits ?? 0, deliveredCredits: generationBalance.deliveredCredits, orders: orders?.results ?? [] }); }
async function order(env, session, orderId) { const mode = activeMode(env); const db = databaseForMode(env, mode); if (!dbReady(env, mode)) return dbError(); const row = await db.prepare('SELECT order_id AS orderId, pack_id AS packId, amount_cents AS amountCents, currency, status, payment_provider AS provider, checkout_url AS checkoutUrl, expires_at AS expiresAt, created_at AS createdAt FROM payment_orders WHERE order_id = ? AND user_id = ?').bind(orderId, session.userId).first(); return row ? json({ ok: true, order: row }) : json({ ok: false, code: 'NOT_FOUND' }, 404); }

async function webhook(request, env, mode) {
  const db = databaseForMode(env, mode); const cfg = config(env, mode);
  if (activeMode(env) !== mode) return json({ ok: false, code: 'ENVIRONMENT_DISABLED' }, 409);
  if (!dbReady(env, mode)) return dbError();
  const raw = await request.text();
  if (!cfg.enabled || !cfg.publicKey || !cfg.storeId || !(await verifyWaffoWebhook(raw, request.headers.get('X-Waffo-Signature'), cfg.publicKey))) return json({ ok: false, code: 'INVALID_SIGNATURE' }, 401);
  let event; try { event = JSON.parse(raw); } catch { return json({ ok: false, code: 'INVALID_JSON' }, 400); }
  if (event.mode !== mode || event.storeId !== cfg.storeId) return json({ ok: false, code: 'ENVIRONMENT_MISMATCH' }, 400);
  const data = event.data ?? {};
  if (event.eventType !== 'order.completed') {
    if (!['refund.succeeded', 'refund.failed'].includes(event.eventType) || !event.eventId) return json({ ok: true, status: 'pending_review', supported: false });
    try { await db.prepare('INSERT INTO payment_webhook_events (event_type, event_id, environment, order_id, status, raw_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(event.eventType, event.eventId, mode, data.orderMerchantExternalId ?? null, 'pending_review', raw, nowIso()).run(); return json({ ok: true, status: 'pending_review', supported: false }); }
    catch { const duplicate = await db.prepare('SELECT event_id FROM payment_webhook_events WHERE event_type = ? AND event_id = ?').bind(event.eventType, event.eventId).first(); return duplicate ? json({ ok: true, status: 'pending_review', supported: false, duplicate: true }) : json({ ok: false, code: 'WEBHOOK_RECORD_RETRY' }, 503); }
  }
  const orderId = data.orderMerchantExternalId; const row = await db.prepare('SELECT * FROM payment_orders WHERE order_id = ?').bind(orderId).first();
  if (!row || row.environment !== mode || (row.payment_provider && row.payment_provider !== 'waffo')) return json({ ok: false, code: 'ORDER_MISMATCH' }, 400);
  const metadata = data.orderMetadata ?? data.productMetadata ?? {}; const pack = getCreditPack(row.pack_id);
  const subtotal = centsString(data.listPrice?.subtotal); const total = centsString(data.listPrice?.total); const tax = centsString(data.listPrice?.taxAmount ?? '0.00'); const charged = centsString(data.chargedAmount ?? data.amount);
  const discount = data.listPrice?.discountAmount === undefined ? 0 : centsString(data.listPrice.discountAmount);
  const moneyValuesValid = [subtotal, tax, total, charged, discount].every((value) => Number.isSafeInteger(value) && value >= 0);
  const amountValid = moneyValuesValid && subtotal === row.amount_cents && discount === 0 && total === subtotal + tax && charged === total;
  if (!pack || data.paymentStatus !== 'succeeded' || data.currency !== row.currency || metadata.localOrderId !== row.order_id || metadata.userId !== row.user_id || metadata.packId !== row.pack_id || metadata.productId !== row.product_id || !amountValid || !data.paymentId || !event.eventType || !event.eventId) return json({ ok: false, code: 'ORDER_MISMATCH' }, 400);
  const duplicate = await db.prepare('SELECT payment_id AS paymentId, order_id AS orderId, user_id AS userId, event_type AS eventType, event_id AS eventId FROM payment_fulfillments WHERE payment_id = ? OR order_id = ?').bind(data.paymentId, row.order_id).first();
  if (duplicate) {
    if (duplicate.paymentId !== data.paymentId || duplicate.orderId !== row.order_id || duplicate.userId !== row.user_id || duplicate.eventType !== event.eventType || duplicate.eventId !== event.eventId) return json({ ok: false, code: 'FULFILLMENT_CONFLICT' }, 409);
    return json({ ok: true, duplicate: true });
  }
  const now = nowIso();
  try { const results = await db.batch([db.prepare('INSERT INTO payment_fulfillments (payment_id, order_id, user_id, credits, event_type, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(data.paymentId, row.order_id, row.user_id, pack.credits, event.eventType, event.eventId, now), db.prepare('INSERT INTO credit_ledger (user_id, order_id, payment_id, credits, created_at) VALUES (?, ?, ?, ?, ?)').bind(row.user_id, row.order_id, data.paymentId, pack.credits, now), db.prepare('UPDATE payment_orders SET status = ?, updated_at = ? WHERE order_id = ?').bind('paid', now, row.order_id)]); return json({ ok: true, duplicate: false, changes: results?.map((item) => item.meta?.changes ?? null) ?? [] }); }
  catch { const after = await db.prepare('SELECT payment_id AS paymentId, order_id AS orderId, user_id AS userId, event_type AS eventType, event_id AS eventId FROM payment_fulfillments WHERE payment_id = ? OR order_id = ?').bind(data.paymentId, row.order_id).first(); if (!after) return json({ ok: false, code: 'FULFILLMENT_RETRY' }, 503); if (after.paymentId !== data.paymentId || after.orderId !== row.order_id || after.userId !== row.user_id || after.eventType !== event.eventType || after.eventId !== event.eventId) return json({ ok: false, code: 'FULFILLMENT_CONFLICT' }, 409); return json({ ok: true, duplicate: true }); }
}

export async function handlePayments(request, env, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname === '/api/credit-packs' && request.method === 'GET') { const status = getPaymentStatus(env); return json({ ok: true, provider: status.provider ?? 'waffo', checkoutEnabled: status.checkoutEnabled, paymentMode: status, packs: listCreditPacks() }); }
  if (url.pathname === '/api/waffo/webhook/test' && request.method === 'POST') return webhook(request, env, 'test');
  if (url.pathname === '/api/waffo/webhook/production' && request.method === 'POST') return webhook(request, env, 'prod');
  if (url.pathname === '/api/paypal/webhook/test' && request.method === 'POST') return paypalWebhook(request, env, 'test', deps);
  if (url.pathname === '/api/paypal/webhook/production' && request.method === 'POST') return paypalWebhook(request, env, 'prod', deps);
  const needsSession = (url.pathname === '/api/billing' && request.method === 'GET') || (url.pathname === '/api/checkout' && request.method === 'POST') || (url.pathname === '/api/paypal/capture' && request.method === 'POST') || (request.method === 'GET' && /^\/api\/orders\/[^/]+$/.test(url.pathname));
  if (!needsSession) return null;
  const session = await sessionFor(request, env, deps); if (!sessionUser(session)) return json({ ok: false, code: 'AUTH_REQUIRED' }, 401);
  if (url.pathname === '/api/billing') return billing(env, session);
  if (url.pathname === '/api/checkout' || url.pathname === '/api/paypal/capture') { if (!(await csrfFor(request, session, env, deps))) return json({ ok: false, code: 'CSRF_FAILED' }, 403); if (url.pathname === '/api/paypal/capture') return capturePaypalOrder(request, env, session, deps); return createCheckout(request, env, session, deps); }
  return order(env, session, decodeURIComponent(url.pathname.split('/').pop()));
}
