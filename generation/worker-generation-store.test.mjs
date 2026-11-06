import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { claimGenerationSubmission, getGenerationBalance, getGenerationRun, getLatestGenerationRun, reserveGeneration, updateGenerationRun } from '../deploy/generation-store.mjs';

const paymentsMigration = readFileSync(fileURLToPath(new URL('../migrations/0002_payments.sql', import.meta.url)), 'utf8');
const generationMigration = readFileSync(fileURLToPath(new URL('../migrations/0003_generation.sql', import.meta.url)), 'utf8');

class SqliteD1 {
  constructor(path) { this.db = new DatabaseSync(path); this.db.exec(paymentsMigration); this.db.exec(generationMigration); }
  prepare(sql) { const owner = this; return { bind(...args) { return { first: async () => owner.db.prepare(sql).get(...args) ?? null, all: async () => ({ results: owner.db.prepare(sql).all(...args) }), run: async () => { const result = owner.db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes ?? 0) } }; }, sql, args }; } }; }
  async batch(statements) { this.db.exec('BEGIN IMMEDIATE'); try { for (const statement of statements) this.db.prepare(statement.sql).run(...statement.args); this.db.exec('COMMIT'); return statements.map(() => ({ meta: { changes: 1 } })); } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  close() { this.db.close(); }
}

function withDb(run) { const directory = mkdtempSync(join(tmpdir(), 'fancycoffee-generation-')); const path = join(directory, 'billing.sqlite'); return Promise.resolve().then(() => run(path)).finally(() => rmSync(directory, { recursive: true, force: true })); }
function env(db, extra = {}) { return { WAFFO_MODE: 'test', BILLING_TEST_DB: db, ...extra }; }
function seedCredits(db, userId, credits) { const now = new Date().toISOString(); const orderId = `order-${userId}`; const paymentId = `payment-${userId}`; db.db.prepare("INSERT INTO payment_orders (order_id, request_id, user_id, pack_id, product_id, currency, amount_cents, environment, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)").run(orderId, `request-${userId}`, userId, 'credits-20', 'PROD_20', 'USD', 999, 'test', now, now); db.db.prepare("INSERT INTO payment_fulfillments (payment_id, order_id, user_id, credits, event_type, event_id, created_at) VALUES (?, ?, ?, ?, 'order.completed', ?, ?)").run(paymentId, orderId, userId, credits, `event-${userId}`, now); db.db.prepare('INSERT INTO credit_ledger (user_id, order_id, payment_id, credits, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, orderId, paymentId, credits, now); }
function input(userId, requestId, runId, creditsRequired = 10, inputFingerprint = 'fp-1') { return { userId, requestId, runId, creditsRequired, inputFingerprint }; }

test('reserves atomically under concurrent duplicate requests and isolates users', async () => withDb(async (path) => {
  const db = new SqliteD1(path); seedCredits(db, 'user-1', 20);
  const target = input('user-1', 'request-1', 'run-1', 10);
  const results = await Promise.all([reserveGeneration(env(db), target), reserveGeneration(env(db), target)]);
  assert.equal(results.filter((result) => result.duplicate === false).length, 1);
  assert.equal(results.filter((result) => result.duplicate === true).length, 1);
  assert.equal((await getGenerationBalance(env(db), 'user-1')).availableCredits, 10);
  await assert.rejects(() => reserveGeneration(env(db), input('user-2', 'request-2', 'run-2', 1)), /INSUFFICIENT_CREDITS/);
  db.close();
}));

test('rejects changed input and run replay across users, then releases failed reservations and charges completed once', async () => withDb(async (path) => {
  const db = new SqliteD1(path); seedCredits(db, 'user-1', 20); const testEnv = env(db, { GENERATION_AUTHORIZED_RUN_ID: 'run-authorized' });
  await assert.rejects(() => reserveGeneration(testEnv, input('user-1', 'bad', 'other-run')), /GENERATION_RUN_NOT_AUTHORIZED/);
  await reserveGeneration(testEnv, input('user-1', 'request-1', 'run-authorized', 10));
  await assert.rejects(() => reserveGeneration(testEnv, input('user-1', 'request-1', 'run-authorized', 9)), /GENERATION_REQUEST_CONFLICT/);
  await assert.rejects(() => reserveGeneration(testEnv, input('user-2', 'request-2', 'run-authorized', 1)), /GENERATION_REQUEST_CONFLICT/);
  assert.equal((await getGenerationBalance(testEnv, 'user-1')).availableCredits, 10);
  await updateGenerationRun(testEnv, { runId: 'run-authorized', userId: 'user-1', status: 'failed', errorCode: 'PROVIDER_FAILED' });
  assert.equal((await getGenerationBalance(testEnv, 'user-1')).availableCredits, 20);
  const complete = await reserveGeneration(env(db), input('user-1', 'request-2', 'run-complete', 10));
  const claims = await Promise.all([claimGenerationSubmission(env(db), { runId: complete.run.run_id, userId: 'user-1' }), claimGenerationSubmission(env(db), { runId: complete.run.run_id, userId: 'user-1' })]); assert.equal(claims.filter((claim) => claim.acquired).length, 1); assert.equal(claims.filter((claim) => !claim.acquired).length, 1);
  await updateGenerationRun(env(db), { runId: 'run-complete', userId: 'user-1', status: 'submitted', providerTaskId: 'task-1' });
  await updateGenerationRun(env(db), { runId: 'run-complete', userId: 'user-1', status: 'completed', providerTaskId: 'task-1', resultUrl: 'https://cdn.example/result.mp4', resultMeta: { duration: 15 } });
  const balance = await getGenerationBalance(testEnv, 'user-1'); assert.equal(balance.availableCredits, 10); assert.equal(balance.deliveredCredits, 10);
  const run = await getGenerationRun(testEnv, 'run-complete', 'user-1'); assert.equal(run.status, 'completed'); assert.equal(run.provider_task_id, 'task-1');
  await assert.rejects(() => updateGenerationRun(testEnv, { runId: 'run-complete', userId: 'user-1', status: 'failed', errorCode: 'LATE_FAILURE' }), /GENERATION_INVALID_TRANSITION/);
  const idempotent = await updateGenerationRun(testEnv, { runId: 'run-complete', userId: 'user-1', status: 'completed', providerTaskId: 'task-1', resultUrl: 'https://cdn.example/result.mp4' }); assert.equal(idempotent.duplicate, true);
  assert.equal((await getLatestGenerationRun(testEnv, 'user-1')).run_id, 'run-complete'); assert.equal((await getLatestGenerationRun(testEnv, 'user-1', 'request-1')).run_id, 'run-authorized'); assert.equal(await getLatestGenerationRun(testEnv, 'user-2'), null);
  const productionEnv = env(db, { WAFFO_MODE: 'prod', APP_DB: db }); await reserveGeneration(productionEnv, input('user-1', 'production-request', 'production-run', 1)); assert.equal((await getLatestGenerationRun(productionEnv, 'user-1')).run_id, 'production-run'); assert.equal((await getLatestGenerationRun(testEnv, 'user-1')).run_id, 'run-complete');
  await reserveGeneration(env(db), input('user-1', 'unknown-request', 'unknown-run', 1)); await claimGenerationSubmission(env(db), { runId: 'unknown-run', userId: 'user-1' }); await updateGenerationRun(env(db), { runId: 'unknown-run', userId: 'user-1', status: 'unknown', providerTaskId: 'task-unknown' }); await assert.rejects(() => updateGenerationRun(env(db), { runId: 'unknown-run', userId: 'user-1', status: 'submitting' }), /GENERATION_INVALID_TRANSITION/); await assert.rejects(() => updateGenerationRun(env(db), { runId: 'unknown-run', userId: 'user-1', status: 'submitted', providerTaskId: 'different-task' }), /GENERATION_RESULT_CONFLICT/);
  db.close();
}));
