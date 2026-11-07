const MAX_WEBHOOK_BYTES = 256 * 1024;
const SUPPORTED_EVENTS = new Set([
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.PARTIALLY_REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
]);

export function webhookBodySizeAllowed(request) {
  const header = request.headers.get('content-length');
  return header === null || (/^\d+$/.test(header) && Number(header) <= MAX_WEBHOOK_BYTES);
}

export function paypalWebhookHeadersComplete(headers) {
  return ['PAYPAL-AUTH-ALGO', 'PAYPAL-CERT-URL', 'PAYPAL-TRANSMISSION-ID', 'PAYPAL-TRANSMISSION-SIG', 'PAYPAL-TRANSMISSION-TIME'].every((name) => {
    const value = headers.get(name);
    return typeof value === 'string' && value.length > 0;
  });
}

export function extractPaypalWebhookResource(event) {
  const resource = event?.resource;
  const related = resource?.supplementary_data?.related_ids;
  const eventType = event?.event_type ?? '';
  let captureId = null;
  if (eventType === 'PAYMENT.CAPTURE.COMPLETED' || eventType === 'PAYMENT.CAPTURE.DECLINED' || eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'PAYMENT.CAPTURE.PENDING') captureId = typeof resource?.id === 'string' ? resource.id : null;
  else if (eventType.includes('REFUND') || eventType.endsWith('REVERSED')) captureId = typeof related?.capture_id === 'string' ? related.capture_id : null;
  if (!captureId && (eventType.includes('REFUND') || eventType.endsWith('REVERSED')) && Array.isArray(resource?.links)) {
    const up = resource.links.find((link) => link?.rel === 'up');
    try {
      const url = new URL(up?.href ?? '');
      if (url.protocol === 'https:' && (url.hostname === 'api-m.sandbox.paypal.com' || url.hostname === 'api-m.paypal.com')) {
        const match = /^\/v2\/payments\/captures\/([^/]+)$/.exec(url.pathname);
        captureId = match ? decodeURIComponent(match[1]) : null;
      }
    } catch { captureId = null; }
  }
  return {
    captureId,
    providerOrderId: typeof related?.order_id === 'string' ? related.order_id : null,
    status: resource?.status ?? null,
    amount: resource?.amount ?? null,
  };
}

export async function verifyPaypalWebhook(rawBody, headers, config, { fetchImpl = globalThis.fetch, accessToken, timeoutMs = 10_000 } = {}) {
  if (!config?.webhookId || !accessToken) return { ok: false, code: 'PAYPAL_WEBHOOK_CONFIG_MISSING' };
  const required = {
    auth_algo: headers.get('PAYPAL-AUTH-ALGO'),
    cert_url: headers.get('PAYPAL-CERT-URL'),
    transmission_id: headers.get('PAYPAL-TRANSMISSION-ID'),
    transmission_sig: headers.get('PAYPAL-TRANSMISSION-SIG'),
    transmission_time: headers.get('PAYPAL-TRANSMISSION-TIME'),
    webhook_id: config.webhookId,
  };
  if (Object.values(required).some((value) => typeof value !== 'string' || value.length === 0)) return { ok: false, code: 'PAYPAL_WEBHOOK_HEADERS_MISSING' };
  let webhookEvent;
  try { webhookEvent = JSON.parse(rawBody); } catch { return { ok: false, code: 'INVALID_JSON' }; }
  const response = await fetchImpl(`${config.baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    redirect: 'manual',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...required, webhook_event: webhookEvent }),
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const result = await response.json().catch(() => null);
  return response.ok && result?.verification_status === 'SUCCESS' ? { ok: true, event: webhookEvent } : { ok: false, code: 'INVALID_SIGNATURE' };
}

export async function hashWebhookBody(rawBody) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

export { MAX_WEBHOOK_BYTES, SUPPORTED_EVENTS };
