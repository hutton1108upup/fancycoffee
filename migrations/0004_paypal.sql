-- PayPal provider binding and minimal webhook audit state.
-- Existing Waffo orders remain provider='waffo'. The application must bind the
-- provider before making a remote create-order call; the request body cannot
-- select it.
ALTER TABLE payment_orders ADD COLUMN payment_provider TEXT NOT NULL DEFAULT 'waffo';
ALTER TABLE payment_orders ADD COLUMN provider_order_id TEXT;
ALTER TABLE payment_orders ADD COLUMN provider_capture_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_provider_order_idx
  ON payment_orders(payment_provider, provider_order_id);

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_provider_capture_idx
  ON payment_orders(payment_provider, provider_capture_id)
  WHERE provider_capture_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS paypal_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  local_order_id TEXT,
  user_id TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'prod')),
  status TEXT NOT NULL CHECK (status IN ('received', 'verified', 'pending_review', 'processed', 'rejected')),
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS paypal_webhook_events_order_idx
  ON paypal_webhook_events(local_order_id, created_at DESC);
