import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSqliteRepository } from './sqlite-repository.mjs';

function pending(orderId = 'ORDER_1', userId = 'USER_1') { return { orderId, userId, packId: 'credits-20', productId: 'PROD_20', currency: 'USD', amountCents: 999 }; }
function withDatabase(run) { const directory = mkdtempSync(join(tmpdir(), 'fancycoffee-payment-')); const path = join(directory, 'payments.sqlite'); return Promise.resolve().then(() => run(path)).finally(() => rmSync(directory, { recursive: true, force: true })); }

test('commits pending order, fulfillment, and credits atomically', async () => withDatabase(async (path) => {
  const repository = createSqliteRepository(path); repository.addPendingOrder(pending());
  assert.deepEqual(repository.commitFulfillment({ paymentId: 'PAY_1', localOrderId: 'ORDER_1', userId: 'USER_1', credits: 20, eventKey: 'order.completed:PAY_1' }), { duplicate: false, paymentId: 'PAY_1', localOrderId: 'ORDER_1' });
  assert.equal(repository.getUserCredits('USER_1'), 20); assert.equal(repository.getPendingOrder('ORDER_1').status, 'fulfilled'); repository.close();
}));

test('persists across restart and rejects a different event ID for the same payment/order', async () => withDatabase(async (path) => {
  let repository = createSqliteRepository(path); repository.addPendingOrder(pending());
  repository.commitFulfillment({ paymentId: 'PAY_1', localOrderId: 'ORDER_1', userId: 'USER_1', credits: 20, eventKey: 'order.completed:PAY_1' }); repository.close();
  repository = createSqliteRepository(path);
  assert.deepEqual(repository.commitFulfillment({ paymentId: 'PAY_1', localOrderId: 'ORDER_1', userId: 'USER_1', credits: 20, eventKey: 'order.completed:PAY_DIFFERENT' }), { duplicate: true, paymentId: 'PAY_1', localOrderId: 'ORDER_1' });
  assert.equal(repository.getUserCredits('USER_1'), 20); repository.close();
}));

test('rolls back a failed transaction so the same order can be retried', async () => withDatabase(async (path) => {
  let fail = true; const repository = createSqliteRepository(path, { testHooks: { afterFulfillmentInsert: () => { if (fail) { fail = false; throw new Error('simulated ledger failure'); } } } }); repository.addPendingOrder(pending());
  assert.throws(() => repository.commitFulfillment({ paymentId: 'PAY_1', localOrderId: 'ORDER_1', userId: 'USER_1', credits: 20, eventKey: 'order.completed:PAY_1' }), /simulated ledger failure/);
  assert.equal(repository.getUserCredits('USER_1'), 0); assert.deepEqual(repository.commitFulfillment({ paymentId: 'PAY_1', localOrderId: 'ORDER_1', userId: 'USER_1', credits: 20, eventKey: 'order.completed:PAY_1' }), { duplicate: false, paymentId: 'PAY_1', localOrderId: 'ORDER_1' });
  assert.equal(repository.getUserCredits('USER_1'), 20); repository.close();
}));

test('isolates credit ledgers by user', async () => withDatabase(async (path) => {
  const repository = createSqliteRepository(path); repository.addPendingOrder(pending('ORDER_1', 'USER_1')); repository.addPendingOrder(pending('ORDER_2', 'USER_2'));
  repository.commitFulfillment({ paymentId: 'PAY_1', localOrderId: 'ORDER_1', userId: 'USER_1', credits: 20, eventKey: 'order.completed:PAY_1' }); repository.commitFulfillment({ paymentId: 'PAY_2', localOrderId: 'ORDER_2', userId: 'USER_2', credits: 20, eventKey: 'order.completed:PAY_2' });
  assert.equal(repository.getUserCredits('USER_1'), 20); assert.equal(repository.getUserCredits('USER_2'), 20); assert.equal(repository.getUserLedger('USER_1').some((row) => row.paymentId === 'PAY_2'), false); repository.close();
}));
