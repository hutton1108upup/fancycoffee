/**
 * Process-local idempotency guard for local tests and adapters.
 * It records notification IDs only; it does not claim that a payment was
 * verified, settled, or credited by Waffo.
 */
export class PaymentNotificationDedupe {
  #seen = new Set();

  claim(paymentRequestId) {
    if (this.#seen.has(paymentRequestId)) return { accepted: false, duplicate: true };
    this.#seen.add(paymentRequestId);
    return { accepted: true, duplicate: false };
  }

  has(paymentRequestId) {
    return this.#seen.has(paymentRequestId);
  }

  size() {
    return this.#seen.size;
  }
}
