# Fancy Cafe AI payment boundary

This directory contains the local contract for the requested Waffo setup:

| Pack | Credits | Price | Billing |
| --- | ---: | ---: | --- |
| `credits-20` | 20 | `$9.99` | one-time |
| `credits-60` | 60 | `$24.99` | one-time |
| `credits-200` | 200 | `$69.99` | one-time |

The modules deliberately stop at local contract and adapter preparation. The
adapter is disabled unless `enabled: true` and `accountConfirmed: true` are
explicitly supplied, and no production account or resource is configured.

**Local safety boundary:** no checkout is enabled by default. The webhook
processor never grants credits itself. A real caller must provide a durable
atomic transaction that uniquely commits both `paymentId` and `localOrderId`
with the credit ledger. Refund events are currently unsupported and returned as
`pending_review`; they must not be treated as processed.

## Integration contract (prepared, disabled)

`waffo-adapter.mjs` prepares the documented API-Key request for
`POST /v1/actions/checkout/create-session`. It requires a trusted stored
`pendingOrder` containing `orderId`, `userId`, `packId`, `productId`,
`currency`, and `amountCents`. It sends the local order ID as
`orderMerchantExternalId` and includes the binding metadata, then signs
`METHOD + PATH + TIMESTAMP + SHA256_BASE64(BODY)` with RSA-SHA256 into
`X-Signature`. It returns `PAYMENTS_UNCONFIGURED` until `enabled`,
`accountConfirmed`, `merchantId`, `privateKey`, `environment`, and product
resources are supplied. A timeout returns `CHECKOUT_UNKNOWN` and is never
automatically retried.

`waffo-webhook.mjs` verifies the documented raw-body signature header
`X-Waffo-Signature: t=<milliseconds>,v1=<base64>` using RSA-SHA256 and the
environment-matched public key. It checks `eventType`, `mode`, `storeId`,
`paymentStatus`, `currency`, the local pending-order binding, and amount before
an event can be handed to an application callback. Missing product IDs are not
accepted: the event must match the local order's product metadata. The caller
must supply an atomic durable `commitFulfillment` transaction with unique
`paymentId` and `localOrderId` constraints; `eventId` alone is insufficient.
The post-commit callback is only a notification and cannot be used as the
credit ledger.

The current tests use generated RSA keys and a simulated HTTP response. They do
not contact Waffo, create products, charge a card, or grant credits.

## Cloudflare Worker contract

`deploy/payments.mjs` exports `handlePayments(request, env)` and
`getPaymentStatus(env)`. It is intentionally not wired into the root Worker in
this packet. The auth owner should provide `deploy/auth.mjs` exports with the
following contract: `getSession(request, env)` returns
`{ userId, email, name, csrfToken }` or `null`, and
`requireSameOriginAndCsrf(request, session, env)` returns `true` (or
`{ ok: true }`) only after same-origin and CSRF validation.

Bindings are deliberately split by server mode:

- `WAFFO_MODE=test` uses `BILLING_TEST_DB` only.
- `WAFFO_MODE=production` or `prod` uses `APP_DB` only.
- The request body never selects the mode, and no cross-database foreign key to auth tables is used; `userId` comes from the trusted session.
- Both databases use [migrations/0002_payments.sql](../migrations/0002_payments.sql).

The optional Waffo configuration names are `WAFFO_ENABLED`,
`WAFFO_PRODUCTION_ENABLED`, then per-environment merchant IDs, private keys,
webhook public keys, store IDs, and product IDs using the prefixes
`WAFFO_TEST_` and `WAFFO_PRODUCTION_`. No values are configured in this
workspace. Test and production webhook paths are isolated, and production is
rejected while the server mode is test.

The Worker checkout adapter follows the current Waffo response envelope
(`data.sessionId`, `data.checkoutUrl`, `data.expiresAt`), sends the authenticated
user email, an absolute success URL under `/pricing?order=...`, and
`allowPromotionCodes: false`. It accepts only HTTPS checkout URLs hosted by
`checkout.waffo.ai` or `pancake.waffo.ai`. Unknown, non-2xx, malformed, or
timed-out responses move the order to `checkout_unknown` and never retry
automatically. A later valid webhook can still recover that order because
webhook matching reads every order status before checking fulfillment
idempotency.

Worker-specific tests are in `payments/worker-payments.test.mjs` and
`payments/worker-sqlite-d1.test.mjs`. The latter runs the actual Worker D1
adapter shape against temporary Node 24 SQLite files and proves concurrent
same-request de-duplication, unknown checkout non-retry, batch rollback and
retry, duplicate paid webhook handling, tax/zero-charge rejection, cross-user
order isolation, and refund-record failure handling. Checkout also sends
Waffo's `X-Idempotency-Key` with the local order ID. Private keys may be
provided as PKCS#8 or PKCS#1 PEM; the Worker converts PKCS#1 to WebCrypto
compatible PKCS#8 in memory and never persists the key.

`sqlite-repository.mjs` is the runnable local repository implementation for
Node 24. It creates `pending_orders`, `fulfillments`, and `credit_ledger` in a
SQLite database. `commitFulfillment()` writes fulfillment and credits in one
transaction with unique `payment_id` and `local_order_id`; a rollback leaves
the order retryable. `getUserCredits(userId)` and `getUserLedger(userId)` are
user-scoped reads. This is a local integration component only; production
deployment still needs the application's database lifecycle, migrations,
backup policy, and authenticated account boundary.

## Official basis checked

Current Waffo Pancake documentation states that a checkout session can use a
product with `productType: "onetime"` and `currency: "USD"`, and that webhook
notifications are the backend event stream. Waffo also documents separate test
mode and production activation. Sources checked on 2026-11-05:

- https://docs.waffo.ai/ (Introduction and Quickstart/API links)
- https://waffo.com/en/checkout (hosted checkout and webhook flow)
- https://waffo.com/en/billing (one-time payments and no-renewal model)
- https://docs.waffo.ai/api-reference/authentication (API-Key signing and environment binding)
- https://docs.waffo.ai/api-reference/webhooks (raw-body RSA signature, 45-minute tolerance, event idempotency)
- https://docs.waffo.ai/features/orders-payments (checkout endpoint and order/payment fields)

## Required before remote setup

The merchant must provide or confirm, through the appropriate authorized
account flow, the Waffo merchant/store ownership, environment (test or
production), and the three product resources or permission to create them.
The backend callback URL and Waffo webhook-signing configuration must also be
defined. No credentials belong in this repository or in chat.
