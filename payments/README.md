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
