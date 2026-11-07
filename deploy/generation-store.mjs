const ACTIVE_STATUSES = "'reserved','submitting','submitted','unknown'";
const HELD_CREDITS_SQL = "COALESCE((SELECT SUM(ledger.credits) FROM credit_ledger ledger JOIN payment_orders payment ON payment.order_id = ledger.order_id AND payment.user_id = ledger.user_id WHERE ledger.user_id = ? AND payment.status = 'refund_pending'), 0)";
const VALID_STATUSES = /* @__PURE__ */ new Set(["reserved", "submitting", "submitted", "unknown", "failed", "completed"]);
const TRANSITIONS = {
  reserved: /* @__PURE__ */ new Set(["submitting", "failed"]),
  submitting: /* @__PURE__ */ new Set(["submitted", "unknown", "failed"]),
  submitted: /* @__PURE__ */ new Set(["completed", "unknown", "failed"]),
  unknown: /* @__PURE__ */ new Set(["submitted", "failed", "completed"])
};
function modeFor(env) {
  return env?.WAFFO_MODE === "production" || env?.WAFFO_MODE === "prod" ? "prod" : "test";
}
function dbFor(env, mode) {
  return mode === "test" ? env?.BILLING_TEST_DB : env?.APP_DB;
}
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function inputError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function ensureDb(env, mode) {
  const db = dbFor(env, mode);
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") throw inputError("GENERATION_LEDGER_UNAVAILABLE");
  return db;
}
function rowFor(db, runId, userId, mode) {
  return db.prepare("SELECT * FROM generation_runs WHERE run_id = ? AND user_id = ? AND environment = ?").bind(runId, userId, mode).first();
}
function sameOrNull(current, next) {
  return next == null || current == null || current === next;
}
async function getGenerationBalance(env, userId) {
  const mode = modeFor(env);
  const db = ensureDb(env, mode);
  const row = await db.prepare(`SELECT COALESCE((SELECT SUM(credits) FROM credit_ledger WHERE user_id = ?), 0) AS paidCredits, ${HELD_CREDITS_SQL} AS heldCredits, COALESCE((SELECT SUM(credits_required) FROM generation_runs WHERE environment = ? AND user_id = ? AND status IN (${ACTIVE_STATUSES})), 0) AS reservedCredits, COALESCE((SELECT SUM(credits_required) FROM generation_runs WHERE environment = ? AND user_id = ? AND status = 'completed'), 0) AS deliveredCredits`).bind(userId, userId, mode, userId, mode, userId).first();
  const paidCredits = Number(row?.paidCredits ?? 0);
  const heldCredits = Number(row?.heldCredits ?? 0);
  const reservedCredits = Number(row?.reservedCredits ?? 0);
  const deliveredCredits = Number(row?.deliveredCredits ?? 0);
  return { mode, paidCredits, heldCredits, reservedCredits, deliveredCredits, availableCredits: Math.max(0, paidCredits - heldCredits - reservedCredits - deliveredCredits) };
}
function validateInput(input) {
  if (!input || typeof input.userId !== "string" || typeof input.requestId !== "string" || typeof input.runId !== "string" || typeof input.inputFingerprint !== "string" || !Number.isSafeInteger(input.creditsRequired) || input.creditsRequired <= 0) throw inputError("INVALID_GENERATION_RESERVATION");
}
async function reserveGeneration(env, input) {
  validateInput(input);
  const mode = modeFor(env);
  const db = ensureDb(env, mode);
  const authorizedRunId = env?.GENERATION_AUTHORIZED_RUN_ID;
  if (mode === "test" && authorizedRunId && authorizedRunId !== input.runId) throw inputError("GENERATION_RUN_NOT_AUTHORIZED");
  const existing = await db.prepare("SELECT * FROM generation_runs WHERE environment = ? AND user_id = ? AND request_id = ?").bind(mode, input.userId, input.requestId).first();
  if (existing) {
    if (existing.run_id !== input.runId || existing.input_fingerprint !== input.inputFingerprint || Number(existing.credits_required) !== input.creditsRequired) throw inputError("GENERATION_REQUEST_CONFLICT");
    return { ok: true, duplicate: true, run: existing };
  }
  const runConflict = await db.prepare("SELECT user_id FROM generation_runs WHERE environment = ? AND run_id = ?").bind(mode, input.runId).first();
  if (runConflict && runConflict.user_id !== input.userId) throw inputError("GENERATION_REQUEST_CONFLICT");
  const timestamp = now();
  const statements = [db.prepare(`INSERT INTO generation_runs (run_id, user_id, request_id, input_fingerprint, environment, credits_required, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 'reserved', ?, ? WHERE COALESCE((SELECT SUM(credits) FROM credit_ledger WHERE user_id = ?), 0) - ${HELD_CREDITS_SQL} - COALESCE((SELECT SUM(credits_required) FROM generation_runs WHERE environment = ? AND user_id = ? AND status IN (${ACTIVE_STATUSES})), 0) - COALESCE((SELECT SUM(credits_required) FROM generation_runs WHERE environment = ? AND user_id = ? AND status = 'completed'), 0) >= ?`).bind(input.runId, input.userId, input.requestId, input.inputFingerprint, mode, input.creditsRequired, timestamp, timestamp, input.userId, input.userId, mode, input.userId, mode, input.userId, input.creditsRequired)];
  if (authorizedRunId) statements.push(db.prepare("INSERT INTO generation_submission_guard (run_id, environment, created_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM generation_runs WHERE run_id = ? AND user_id = ? AND environment = ?) ON CONFLICT(run_id) DO NOTHING").bind(input.runId, mode, timestamp, input.runId, input.userId, mode));
  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await db.prepare("SELECT * FROM generation_runs WHERE environment = ? AND (run_id = ? OR (user_id = ? AND request_id = ?))").bind(mode, input.runId, input.userId, input.requestId).first();
    if (raced) {
      if (raced.user_id !== input.userId || raced.request_id !== input.requestId || raced.input_fingerprint !== input.inputFingerprint || Number(raced.credits_required) !== input.creditsRequired) throw inputError("GENERATION_REQUEST_CONFLICT");
      return { ok: true, duplicate: true, run: raced };
    }
    throw error;
  }
  const run = await rowFor(db, input.runId, input.userId, mode);
  if (!run) {
    const balance = await getGenerationBalance(env, input.userId);
    if (balance.availableCredits < input.creditsRequired) throw inputError("INSUFFICIENT_CREDITS");
    throw inputError("GENERATION_RUN_NOT_AUTHORIZED");
  }
  return { ok: true, duplicate: false, run };
}
async function claimGenerationSubmission(env, { runId, userId }) {
  if (typeof runId !== "string" || typeof userId !== "string") throw inputError("INVALID_GENERATION_RUN");
  const mode = modeFor(env);
  const db = ensureDb(env, mode);
  const current = await rowFor(db, runId, userId, mode);
  if (!current) throw inputError("GENERATION_RUN_NOT_FOUND");
  if (current.status !== "reserved") return { acquired: false, run: current };
  const result = await db.prepare("UPDATE generation_runs SET status = 'submitting', updated_at = ? WHERE run_id = ? AND user_id = ? AND environment = ? AND status = 'reserved'").bind(now(), runId, userId, mode).run();
  const run = await rowFor(db, runId, userId, mode);
  return { acquired: Number(result?.meta?.changes ?? 0) === 1, run };
}
async function updateGenerationRun(env, { runId, userId, status, providerTaskId = null, resultUrl = null, resultMeta = null, errorCode = null }) {
  if (!VALID_STATUSES.has(status) || typeof runId !== "string" || typeof userId !== "string") throw inputError("INVALID_GENERATION_UPDATE");
  const mode = modeFor(env);
  const db = ensureDb(env, mode);
  const current = await rowFor(db, runId, userId, mode);
  if (!current) throw inputError("GENERATION_RUN_NOT_FOUND");
  const terminal = current.status === "completed" || current.status === "failed";
  if (terminal) {
    const sameTerminal = current.status === status && sameOrNull(current.provider_task_id, providerTaskId) && sameOrNull(current.result_url, resultUrl) && sameOrNull(current.error_code, errorCode);
    if (sameTerminal) return { duplicate: true, run: current };
    throw inputError("GENERATION_INVALID_TRANSITION");
  }
  if (current.status !== status && !TRANSITIONS[current.status]?.has(status)) throw inputError("GENERATION_INVALID_TRANSITION");
  if (!sameOrNull(current.provider_task_id, providerTaskId) || !sameOrNull(current.result_url, resultUrl)) throw inputError("GENERATION_RESULT_CONFLICT");
  const serializedMeta = resultMeta == null ? null : JSON.stringify(resultMeta);
  const result = await db.prepare("UPDATE generation_runs SET status = ?, provider_task_id = COALESCE(provider_task_id, ?), result_url = COALESCE(result_url, ?), result_meta_json = COALESCE(result_meta_json, ?), error_code = ?, updated_at = ? WHERE run_id = ? AND user_id = ? AND environment = ? AND status = ?").bind(status, providerTaskId, resultUrl, serializedMeta, errorCode, now(), runId, userId, mode, current.status).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw inputError("GENERATION_CONCURRENT_UPDATE");
  return { duplicate: false, run: await rowFor(db, runId, userId, mode) };
}
async function getGenerationRun(env, runId, userId) {
  if (typeof runId !== "string" || typeof userId !== "string") throw inputError("INVALID_GENERATION_RUN");
  return rowFor(ensureDb(env, modeFor(env)), runId, userId, modeFor(env));
}
async function getLatestGenerationRun(env, userId, requestId = null) {
  if (typeof userId !== "string" || !userId) throw inputError("INVALID_GENERATION_OWNER");
  const mode = modeFor(env);
  const db = ensureDb(env, mode);
  if (requestId !== null && (typeof requestId !== "string" || !requestId)) throw inputError("INVALID_GENERATION_REQUEST");
  if (requestId !== null) return db.prepare("SELECT * FROM generation_runs WHERE environment = ? AND user_id = ? AND request_id = ?").bind(mode, userId, requestId).first();
  return db.prepare("SELECT * FROM generation_runs WHERE environment = ? AND user_id = ? ORDER BY created_at DESC, run_id DESC LIMIT 1").bind(mode, userId).first();
}
export {
  claimGenerationSubmission,
  getGenerationBalance,
  getGenerationRun,
  getLatestGenerationRun,
  reserveGeneration,
  updateGenerationRun
};
