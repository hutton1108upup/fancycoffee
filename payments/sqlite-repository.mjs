import { DatabaseSync } from 'node:sqlite';
import { validatePendingOrder } from './waffo-adapter.mjs';

export function createSqliteRepository(databasePath, { testHooks = {} } = {}) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS pending_orders (
      order_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pack_id TEXT NOT NULL,
      product_id TEXT NOT NULL, currency TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fulfillments (
      payment_id TEXT PRIMARY KEY, local_order_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
      credits INTEGER NOT NULL, event_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      FOREIGN KEY (local_order_id) REFERENCES pending_orders(order_id)
    );
    CREATE TABLE IF NOT EXISTS credit_ledger (
      ledger_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
      local_order_id TEXT NOT NULL UNIQUE, payment_id TEXT NOT NULL UNIQUE,
      credits INTEGER NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (payment_id) REFERENCES fulfillments(payment_id)
    );
  `);
  function addPendingOrder(order) {
    const valid = validatePendingOrder(order);
    if (!valid.ok) throw new TypeError(valid.code);
    database.prepare(`INSERT INTO pending_orders (order_id, user_id, pack_id, product_id, currency, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(order.orderId, order.userId, order.packId, order.productId, order.currency, order.amountCents, new Date().toISOString());
  }
  function getPendingOrder(orderId) {
    if (typeof orderId !== 'string' || orderId.length === 0) return null;
    return database.prepare(`SELECT order_id AS orderId, user_id AS userId, pack_id AS packId, product_id AS productId, currency, amount_cents AS amountCents, status FROM pending_orders WHERE order_id = ?`).get(orderId) ?? null;
  }
  function commitFulfillment(record) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = database.prepare(`SELECT payment_id AS paymentId, local_order_id AS localOrderId FROM fulfillments WHERE payment_id = ? OR local_order_id = ?`).get(record.paymentId, record.localOrderId);
      if (duplicate) { database.exec('COMMIT'); return { duplicate: true, paymentId: duplicate.paymentId, localOrderId: duplicate.localOrderId }; }
      const pending = getPendingOrder(record.localOrderId);
      if (!pending || pending.status !== 'pending' || pending.userId !== record.userId) throw new Error('PENDING_ORDER_NOT_COMMITTABLE');
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO fulfillments (payment_id, local_order_id, user_id, credits, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(record.paymentId, record.localOrderId, record.userId, record.credits, record.eventKey, now);
      if (typeof testHooks.afterFulfillmentInsert === 'function') testHooks.afterFulfillmentInsert(record);
      database.prepare(`INSERT INTO credit_ledger (user_id, local_order_id, payment_id, credits, created_at) VALUES (?, ?, ?, ?, ?)`).run(record.userId, record.localOrderId, record.paymentId, record.credits, now);
      database.prepare(`UPDATE pending_orders SET status = 'fulfilled' WHERE order_id = ?`).run(record.localOrderId);
      database.exec('COMMIT');
      return { duplicate: false, paymentId: record.paymentId, localOrderId: record.localOrderId };
    } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
  }
  function getUserCredits(userId) { return database.prepare(`SELECT COALESCE(SUM(credits), 0) AS credits FROM credit_ledger WHERE user_id = ?`).get(userId).credits; }
  function getUserLedger(userId) { return database.prepare(`SELECT local_order_id AS localOrderId, payment_id AS paymentId, credits, created_at AS createdAt FROM credit_ledger WHERE user_id = ? ORDER BY ledger_id`).all(userId); }
  return { addPendingOrder, getPendingOrder, commitFulfillment, getUserCredits, getUserLedger, close: () => database.close() };
}
