import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPaypalWebhookResource } from '../deploy/paypal-webhook.mjs';

function refundEvent(href) {
  return { event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REFUND_1', supplementary_data: { related_ids: { order_id: 'ORDER_1' } }, links: [{ rel: 'up', href }] } };
}

test('refund up link accepts only mode-matching PayPal API hosts and exact capture path', () => {
  const sandbox = refundEvent('https://api.sandbox.paypal.com/v2/payments/captures/42L184340V737842Y');
  assert.equal(extractPaypalWebhookResource(sandbox, 'test').captureId, '42L184340V737842Y');
  assert.equal(extractPaypalWebhookResource(refundEvent('https://api-m.sandbox.paypal.com/v2/payments/captures/42L184340V737842Y'), 'test').captureId, '42L184340V737842Y');
  assert.equal(extractPaypalWebhookResource(refundEvent('https://api.paypal.com/v2/payments/captures/42L184340V737842Y'), 'prod').captureId, '42L184340V737842Y');
  assert.equal(extractPaypalWebhookResource(refundEvent('http://api.sandbox.paypal.com/v2/payments/captures/42L184340V737842Y'), 'test').captureId, null);
  assert.equal(extractPaypalWebhookResource(refundEvent('https://api.sandbox.paypal.com/v2/payments/captures/42L184340V737842Y/extra'), 'test').captureId, null);
  assert.equal(extractPaypalWebhookResource(refundEvent('https://api.paypal.com/v2/payments/captures/42L184340V737842Y'), 'test').captureId, null);
  assert.equal(extractPaypalWebhookResource(refundEvent('https://user:pass@api.sandbox.paypal.com/v2/payments/captures/42L184340V737842Y'), 'test').captureId, null);
});
