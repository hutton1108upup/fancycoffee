CREATE TABLE IF NOT EXISTS payment_orders (
  order_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'prod')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'checkout_unknown', 'paid', 'refund_pending')),
  checkout_session_id TEXT,
  checkout_url TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS payment_orders_user_idx ON payment_orders(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_user_request_idx ON payment_orders(user_id, request_id);

CREATE TABLE IF NOT EXISTS payment_fulfillments (
  payment_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES payment_orders(order_id),
  user_id TEXT NOT NULL,
  credits INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(event_type, event_id)
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE REFERENCES payment_orders(order_id),
  payment_id TEXT NOT NULL UNIQUE REFERENCES payment_fulfillments(payment_id),
  credits INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'prod')),
  order_id TEXT,
  status TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_type, event_id)
);
