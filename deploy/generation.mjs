import { claimGenerationSubmission, getGenerationRun, getLatestGenerationRun, reserveGeneration, updateGenerationRun } from "./generation-store.mjs";
import { PERSON_REFERENCE_MAX_SECONDS, TEMPLATE_VERSION, canonicalTemplateRequest, templateFingerprint, templateName, templatePayload, templateQuote } from "../generation/templates.mjs";
const MODEL = "seedance-2.0";
const DURATION = 15;
const SIZE = "9:16";
const RESOLUTION = "480p";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const MAX_REFERENCE_VIDEO_BYTES = 32 * 1024 * 1024;
const ALLOWED_EMAILS = "GENERATION_ALLOWED_EMAILS";
class GenerationHttpError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function now() {
  return Date.now();
}
function allowedEmail(email, env) {
  const list = String(env?.[ALLOWED_EMAILS] || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 && list.includes(String(email || "").toLowerCase());
}
function validRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}
function isImage(file) {
  return file && ["image/jpeg", "image/png", "image/webp"].includes(file.type) && file.size > 0 && file.size <= MAX_IMAGE_BYTES;
}
async function magicImage(file) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const webp = bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  return jpeg || png || webp;
}
function mp4Magic(bytes) {
  return bytes.length >= 8 && bytes[4] === 102 && bytes[5] === 116 && bytes[6] === 121 && bytes[7] === 112;
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function readObjectBytes(object, limit) {
  if (!object) throw new GenerationHttpError("GENERATION_PERSON_REFERENCE_UNAVAILABLE", "The approved person reference is unavailable.", 503);
  if (object instanceof Uint8Array) return object.byteLength <= limit ? object : (() => { throw new GenerationHttpError("GENERATION_PERSON_REFERENCE_INVALID", "The approved person reference is too large.", 503); })();
  if (object instanceof ArrayBuffer) return object.byteLength <= limit ? new Uint8Array(object) : (() => { throw new GenerationHttpError("GENERATION_PERSON_REFERENCE_INVALID", "The approved person reference is too large.", 503); })();
  return readLimited(new Response(object.body || object), limit);
}
async function readLimited(response, limit) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        const error = new Error("body too large");
        error.code = "BODY_TOO_LARGE";
        throw error;
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (!error.code) error.code = "BODY_READ_RETRYABLE";
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
function quote(env) {
  const usd = Number(env?.GENERATION_QUOTE_USD);
  const cny = Number(env?.GENERATION_QUOTE_CNY);
  const fx = Number(env?.GENERATION_FX_USD_TO_CNY);
  const expires = Date.parse(env?.GENERATION_QUOTE_EXPIRES_AT || "");
  if (![usd, cny, fx].every(Number.isFinite) || usd < 0 || cny < 0 || fx <= 0 || usd * fx > 8 || cny > 8 || !Number.isFinite(expires) || expires <= now()) throw new GenerationHttpError("GENERATION_QUOTE_UNAVAILABLE", "A current server quote within the 8 CNY ceiling is required.", 503);
  return { usd, cny, fx, expiresAt: new Date(expires).toISOString() };
}
async function approvedPersonReference(env, deps) {
  const key = String(env?.GENERATION_PERSON_REFERENCE_KEY || "");
  const expectedHash = String(env?.GENERATION_PERSON_REFERENCE_SHA256 || "").toLowerCase();
  const seconds = Number(env?.GENERATION_PERSON_REFERENCE_DURATION);
  if (!key || !/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isFinite(seconds) || seconds <= 0 || seconds > PERSON_REFERENCE_MAX_SECONDS) throw new GenerationHttpError("GENERATION_PERSON_REFERENCE_UNAVAILABLE", "A signed person reference with a verified duration is required.", 503);
  const object = deps?.getReference ? await deps.getReference(key) : await env?.GENERATION_MEDIA?.get?.(key);
  const bytes = await readObjectBytes(object, MAX_REFERENCE_VIDEO_BYTES);
  if (!mp4Magic(bytes)) throw new GenerationHttpError("GENERATION_PERSON_REFERENCE_INVALID", "The approved person reference is not an MP4.", 503);
  const actualHash = await sha256Bytes(bytes);
  if (actualHash !== expectedHash) throw new GenerationHttpError("GENERATION_PERSON_REFERENCE_CHANGED", "The approved person reference bytes do not match the configured hash.", 503);
  return { key, hash: actualHash, seconds };
}
function templateRate(env, template) {
  const key = template === "person" ? "GENERATION_PERSON_RATE_USD_PER_SECOND" : "GENERATION_PET_RATE_USD_PER_SECOND";
  const value = Number(env?.[key]);
  if (!Number.isFinite(value) || value <= 0) throw new GenerationHttpError("GENERATION_QUOTE_UNAVAILABLE", "A server template rate is required before generation.", 503);
  return value;
}
function templatePricing(env, template, reference, fingerprint, controlled = true) {
  const pricing = templateQuote({ template, referenceDuration: reference?.seconds || 0, rateUsdPerSecond: templateRate(env, template), fx: env?.GENERATION_FX_USD_TO_CNY, expiresAt: env?.GENERATION_QUOTE_EXPIRES_AT });
  if (!pricing) throw new GenerationHttpError("GENERATION_QUOTE_UNAVAILABLE", "A current server template quote within the 8 CNY ceiling is required.", 503);
  const authorized = String(env?.GENERATION_AUTHORIZED_REQUEST_SHA256 || "").toLowerCase();
  if (controlled && (!/^[a-f0-9]{64}$/.test(authorized) || authorized !== fingerprint)) throw new GenerationHttpError("GENERATION_REQUEST_NOT_AUTHORIZED", "This exact normalized template request is not authorized for the controlled run.", 503, { fingerprint });
  return { ...pricing, requestFingerprint: fingerprint, template, promptVersion: TEMPLATE_VERSION };
}
const PROVIDER_STATUSES = new Set(["pending", "submitted", "processing", "completed", "failed", "unknown"]);
const DELIVERY_STATES = new Set(["PROVIDER_STATUS_TEMPORARY", "PROVIDER_URL_UNTRUSTED", "VIDEO_FETCH_RETRYABLE", "VIDEO_FETCH_INVALID", "OUTPUT_STORAGE_RETRYABLE"]);
function safeDiagnostics(row) {
  let meta = {};
  try { meta = row?.result_meta_json ? JSON.parse(row.result_meta_json) : {}; } catch { meta = {}; }
  return {
    providerStatus: PROVIDER_STATUSES.has(meta.providerStatus) ? meta.providerStatus : void 0,
    deliveryState: DELIVERY_STATES.has(meta.deliveryState) ? meta.deliveryState : void 0,
    outputHost: typeof meta.outputHost === "string" && /^[a-z0-9.-]+$/i.test(meta.outputHost) ? meta.outputHost : void 0,
    upstreamHttpStatus: Number.isInteger(meta.upstreamHttpStatus) && meta.upstreamHttpStatus >= 100 && meta.upstreamHttpStatus <= 599 ? meta.upstreamHttpStatus : void 0
  };
}
function rowJob(row) {
  if (!row) return null;
  const diagnostics = safeDiagnostics(row);
  return { id: row.run_id, requestId: row.request_id, status: row.status, previewUrl: row.status === "completed" && row.result_url ? `/api/generations/${encodeURIComponent(row.run_id)}/preview` : void 0, downloadUrl: row.status === "completed" && row.result_url ? `/api/generations/${encodeURIComponent(row.run_id)}/download` : void 0, errorCode: row.status === "failed" ? row.error_code : void 0, ...diagnostics };
}
function db(env, deps) {
  return deps?.db || env?.APP_DB;
}
function requireDb(env, deps) {
  const value = db(env, deps);
  if (!value || typeof value.prepare !== "function") throw new GenerationHttpError("GENERATION_STORAGE_UNAVAILABLE", "Generation task storage is not configured.", 503);
  return value;
}
async function findJob(database, id, userId, env) {
  return getGenerationRun(env, id, userId);
}
async function uploadInput(env, key, file, deps) {
  const bytes = await file.arrayBuffer();
  if (deps?.putInput) return deps.putInput(key, bytes, file.type);
  if (!env?.GENERATION_MEDIA || typeof env.GENERATION_MEDIA.put !== "function") throw new GenerationHttpError("GENERATION_STORAGE_UNAVAILABLE", "Private generation storage is not configured.", 503);
  await env.GENERATION_MEDIA.put(key, bytes, { httpMetadata: { contentType: file.type } });
  return key;
}
async function hmac(secret, value) {
  if (!secret) throw new GenerationHttpError("GENERATION_INPUT_URL_UNAVAILABLE", "A private input signing secret is required before provider submission.", 503);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function inputOrigin(env, key) {
  const origin = String(env?.GENERATION_INPUT_ORIGIN || "").replace(/\/$/, "");
  if (!/^https:\/\//i.test(origin)) throw new GenerationHttpError("GENERATION_INPUT_URL_UNAVAILABLE", "A private input URL origin is required before provider submission.", 503);
  const exp = Math.floor(Date.now() / 1e3) + 600;
  const path = `/api/generation-inputs/${key}`;
  const sig = await hmac(env.GENERATION_INPUT_SIGNING_SECRET, `${path}.${exp}`);
  return `${origin}${path}?exp=${exp}&sig=${sig}`;
}
async function serveInput(request, env) {
  const url = new URL(request.url);
  const prefix = "/api/generation-inputs/";
  if (!url.pathname.startsWith(prefix) || request.method !== "GET") return null;
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  const path = url.pathname;
  const expected = await hmac(env.GENERATION_INPUT_SIGNING_SECRET, `${path}.${exp}`).catch(() => null);
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1e3) || !expected || sig.length !== expected.length) return json({ ok: false, code: "INPUT_URL_INVALID" }, 403);
  let same = true;
  for (let i = 0; i < sig.length; i += 1) same = same && sig.charCodeAt(i) === expected.charCodeAt(i);
  if (!same || !env.GENERATION_MEDIA) return json({ ok: false, code: "INPUT_URL_INVALID" }, 403);
  const object = await env.GENERATION_MEDIA.get(path.slice(prefix.length));
  if (!object) return json({ ok: false, code: "NOT_FOUND" }, 404);
  return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "application/octet-stream", "cache-control": "private, max-age=60" } });
}
function provider(env, deps) {
  return deps?.provider || { async submit(payload) {
    try {
      const response = await fetch("https://api.apimart.ai/v1/videos/generations", { method: "POST", headers: { authorization: `Bearer ${env.APIMART_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout?.(3e4) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new GenerationHttpError(response.status >= 400 && response.status < 500 ? "PROVIDER_REJECTED" : "PROVIDER_UNKNOWN", "APIMart rejected or did not accept the submission.", response.status >= 400 && response.status < 500 ? 400 : 502);
      if (!body?.data?.[0]?.task_id) throw new GenerationHttpError("PROVIDER_UNKNOWN", "APIMart submission did not return a task ID.", 502);
      return { taskId: body.data[0].task_id };
    } catch (error) {
      if (error instanceof GenerationHttpError) throw error;
      throw new GenerationHttpError("PROVIDER_UNKNOWN", "APIMart submission outcome is unknown.", 502);
    }
  }, async getTask(taskId) {
    try {
      const response = await fetch(`https://api.apimart.ai/v1/tasks/${encodeURIComponent(taskId)}`, { headers: { authorization: `Bearer ${env.APIMART_API_KEY}`, "cache-control": "no-cache", pragma: "no-cache" }, cache: "no-store", signal: AbortSignal.timeout?.(15e3) });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.data) throw new GenerationHttpError("PROVIDER_UNKNOWN", "APIMart task status could not be verified.", 502, { upstreamHttpStatus: response.status });
      return body.data;
    } catch (error) {
      if (error instanceof GenerationHttpError) throw error;
      throw new GenerationHttpError("PROVIDER_UNKNOWN", "APIMart task status outcome is unknown.", 502);
    }
  } };
}
function trustedOutputUrl(value, env) {
  try {
    const url = new URL(value);
    const hosts = String(env?.GENERATION_OUTPUT_HOSTS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    return url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443") && hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
async function handleGeneration(request, env, deps = {}) {
  const url = new URL(request.url);
  const inputResponse = await serveInput(request, env);
  if (inputResponse) return inputResponse;
  let database;
  try {
    database = requireDb(env, deps);
  } catch (error) {
    return json({ ok: false, code: error.code || "GENERATION_STORAGE_UNAVAILABLE", message: error.message }, error.status || 503);
  }
  const session = deps.session || await deps.getSession?.(request, env);
  if (!session?.userId) return json({ ok: false, code: "AUTH_REQUIRED" }, 401);
  const userId = session.userId;
  const controlled = env.WAFFO_MODE !== "production" && env.WAFFO_MODE !== "prod";
  if (request.method === "GET" && url.pathname === "/api/generations/latest") {
    const row = await getLatestGenerationRun(env, userId, url.searchParams.get("requestId"));
    return json({ ok: true, job: rowJob(row) });
  }
  const match = /^\/api\/generations\/([^/]+)(\/(download|preview))?$/.exec(url.pathname);
  if (match && request.method === "GET") {
    const row = await findJob(database, decodeURIComponent(match[1]), userId, env);
    if (!row) return json({ ok: false, code: "NOT_FOUND" }, 404);
    if (match[2]) return serveStoredJob(row, env, deps, match[3] === "download");
    const result = await refreshJob(row, env, deps, database);
    return json({ ok: true, job: rowJob(result) });
  }
  if (url.pathname !== "/api/generate" || request.method !== "POST") return null;
  if (typeof deps.requireCsrf === "function" && !await deps.requireCsrf(request, session, env)) return json({ ok: false, code: "CSRF_FAILED" }, 403);
  if (controlled && !allowedEmail(session.email, env)) return json({ ok: false, code: "GENERATION_ACCOUNT_NOT_ALLOWED" }, 403);
  if (env.GENERATION_ENABLED !== "true" || !env.APIMART_API_KEY) return json({ ok: false, code: "GENERATION_UNAVAILABLE" }, 503);
  const body = await request.formData().catch(() => null);
  const requestId = body?.get("requestId");
  const templateValue = body?.get("template");
  const template = templateValue === null ? null : templateName(templateValue);
  const style = body?.get("style");
  const resolution = body?.get("resolution");
  const lead = body?.get("lead");
  const regular = body?.get("regular");
  if (!validRequestId(requestId) || templateValue !== null && !template || style !== "standard" || resolution !== RESOLUTION || !isImage(lead) || regular && !isImage(regular) || template && regular) return json({ ok: false, code: "INVALID_GENERATION_REQUEST" }, 400);
  if (!controlled && !template) return json({ ok: false, code: "INVALID_GENERATION_REQUEST" }, 400);
  const runId = controlled ? (env.GENERATION_AUTHORIZED_RUN_ID || env.GENERATION_RUN_ID) : await sha256(JSON.stringify([userId, requestId]));
  if (controlled && !runId) return json({ ok: false, code: "GENERATION_UNAVAILABLE" }, 503);
  if (!await magicImage(lead) || regular && !await magicImage(regular)) return json({ ok: false, code: "INVALID_IMAGE_MAGIC" }, 400);
  const leadBytes = await lead.arrayBuffer();
  const regularBytes = regular ? await regular.arrayBuffer() : null;
  let reference = null;
  let pricing;
  let inputFingerprint;
  try { if (template) {
    reference = template === "person" ? await approvedPersonReference(env, deps) : null;
    inputFingerprint = await templateFingerprint(canonicalTemplateRequest({ template, authorizedRunId: runId, leadHash: await sha256Bytes(leadBytes), referenceHash: reference?.hash || null, referenceDuration: reference?.seconds || null, rateUsdPerSecond: templateRate(env, template) }));
    pricing = templatePricing(env, template, reference, inputFingerprint, controlled);
  } else {
    pricing = quote(env);
    inputFingerprint = await sha256(JSON.stringify({ requestId, style, resolution, duration: DURATION, size: SIZE, lead: await sha256Bytes(leadBytes), regular: regularBytes ? await sha256Bytes(regularBytes) : null, model: MODEL }));
    if (String(env?.GENERATION_AUTHORIZED_REQUEST_SHA256 || "").trim()) return json({ ok: false, code: "GENERATION_REQUEST_NOT_AUTHORIZED", message: "A controlled template request is required for this authorized run." }, 503);
  } } catch (error) {
    if (error instanceof GenerationHttpError) return json({ ok: false, code: error.code, message: error.message }, error.status);
    throw error;
  }
  const inputKey = `generation-inputs/${userId}/${crypto.randomUUID()}.lead`;
  const regularKey = regular ? `${inputKey}.regular` : null;
  const leadUrl = await inputOrigin(env, inputKey);
  const payload = template
    ? templatePayload({ template, leadUrl, referenceUrl: reference ? await inputOrigin(env, reference.key) : null })
    : { model: MODEL, prompt: "In a fancy cafe, the first-timer mistakes the tiny wall-mounted round table for a chair and sits on it. The regular enters and sits on the long bench, placing a coffee on the round table. The first-timer realizes the mistake, climbs down, sits on the bench, and acts completely normal.", size: SIZE, resolution: RESOLUTION, duration: DURATION, image_urls: [leadUrl, ...regular ? [await inputOrigin(env, regularKey)] : []], generate_audio: true, nsfw_check: true };
  let reservation;
  try {
    reservation = await reserveGeneration(env, { userId, requestId, runId, creditsRequired: 20, inputFingerprint });
  } catch (error) {
    return json({ ok: false, code: error.code || "GENERATION_RESERVATION_FAILED", message: error.message }, error.code === "INSUFFICIENT_CREDITS" ? 402 : 503);
  }
  if (reservation.duplicate) return json({ ok: true, job: rowJob(reservation.run), duplicate: true });
  const claim = await claimGenerationSubmission(env, { runId, userId });
  if (!claim.acquired) return json({ ok: true, job: rowJob(claim.run), duplicate: true }, 202);
  try {
    await uploadInput(env, inputKey, lead, deps);
    if (regular) await uploadInput(env, regularKey, regular, deps);
  } catch (error) {
    await updateGenerationRun(env, { runId, userId, status: "failed", errorCode: error.code || "INPUT_STORAGE_FAILED" });
    return json({ ok: false, code: error.code || "INPUT_STORAGE_FAILED", job: { id: runId, status: "failed" } }, 503);
  }
  try {
    const submitted = await provider(env, deps).submit(payload);
    await updateGenerationRun(env, { runId, userId, status: "submitted", providerTaskId: submitted.taskId, resultMeta: { inputKey, regularKey, template, promptVersion: template ? TEMPLATE_VERSION : null, referenceHash: reference?.hash || null, referenceDuration: reference?.seconds || null, quote: pricing } });
    return json({ ok: true, job: { id: runId, status: "submitted" } }, 202);
  } catch (error) {
    const status = error.code === "PROVIDER_UNKNOWN" ? "unknown" : "failed";
    await updateGenerationRun(env, { runId, userId, status, errorCode: error.code || "PROVIDER_ERROR" });
    return json({ ok: false, code: error.code || "PROVIDER_ERROR", job: { id: runId, status } }, status === "unknown" ? 502 : 503);
  }
}
async function recordDiagnostic(row, env, fields) {
  const meta = { providerStatus: fields.providerStatus, deliveryState: fields.deliveryState, outputHost: fields.outputHost, upstreamHttpStatus: fields.upstreamHttpStatus };
  try { await updateGenerationRun(env, { runId: row.run_id, userId: row.user_id, status: row.status, errorCode: fields.deliveryState || fields.errorCode, resultMeta: meta }); } catch { }
  return { ...row, result_meta_json: JSON.stringify(meta), error_code: fields.deliveryState || fields.errorCode || row.error_code };
}
async function refreshJob(row, env, deps, database) {
  if (!["submitted", "processing", "unknown"].includes(row.status) || !row.provider_task_id) return row;
  let result;
  try {
    result = await provider(env, deps).getTask(row.provider_task_id);
  } catch (error) {
    return recordDiagnostic(row, env, { providerStatus: "unknown", deliveryState: "PROVIDER_STATUS_TEMPORARY", upstreamHttpStatus: error?.details?.upstreamHttpStatus });
  }
  if (result.status === "failed") {
    await updateGenerationRun(env, { runId: row.run_id, userId: row.user_id, status: "failed", errorCode: "PROVIDER_FAILED" });
    return { ...row, status: "failed", error_code: "PROVIDER_FAILED" };
  }
  if (result.status !== "completed") return recordDiagnostic(row, env, { providerStatus: PROVIDER_STATUSES.has(result.status) ? result.status : "processing" });
  const outputUrl = result?.result?.videos?.[0]?.url?.[0];
  let outputHost;
  try { outputHost = new URL(outputUrl).hostname; } catch { outputHost = undefined; }
  if (!trustedOutputUrl(outputUrl, env)) return recordDiagnostic(row, env, { providerStatus: "completed", deliveryState: "PROVIDER_URL_UNTRUSTED", outputHost });
  let response;
  try {
    response = await fetch(outputUrl, { signal: AbortSignal.timeout?.(15e3), redirect: "manual" });
  } catch {
    return recordDiagnostic(row, env, { providerStatus: "completed", deliveryState: "VIDEO_FETCH_RETRYABLE", outputHost });
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase().split(";", 1)[0];
  const declared = Number(response.headers.get("content-length"));
  if (response.status >= 300 && response.status < 400) return recordDiagnostic(row, env, { providerStatus: "completed", deliveryState: "VIDEO_FETCH_RETRYABLE", outputHost, upstreamHttpStatus: response.status });
  if (!response.ok || contentType !== "video/mp4" && contentType !== "application/octet-stream" || Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) {
    await updateGenerationRun(env, { runId: row.run_id, userId: row.user_id, status: "failed", errorCode: "INVALID_PROVIDER_VIDEO", resultMeta: { providerStatus: "completed", deliveryState: "VIDEO_FETCH_INVALID", outputHost, upstreamHttpStatus: response.status } });
    return { ...row, status: "failed", error_code: "INVALID_PROVIDER_VIDEO" };
  }
  let bytes;
  try {
    bytes = await readLimited(response, MAX_VIDEO_BYTES);
  } catch (error) {
    if (error.code === "BODY_READ_RETRYABLE") return recordDiagnostic(row, env, { providerStatus: "completed", deliveryState: "VIDEO_FETCH_RETRYABLE", outputHost, upstreamHttpStatus: response.status });
    await updateGenerationRun(env, { runId: row.run_id, userId: row.user_id, status: "failed", errorCode: "INVALID_PROVIDER_VIDEO", resultMeta: { providerStatus: "completed", deliveryState: "VIDEO_FETCH_INVALID", outputHost, upstreamHttpStatus: response.status } });
    return { ...row, status: "failed", error_code: "INVALID_PROVIDER_VIDEO" };
  }
  if (!mp4Magic(bytes)) {
    await updateGenerationRun(env, { runId: row.run_id, userId: row.user_id, status: "failed", errorCode: "INVALID_PROVIDER_VIDEO", resultMeta: { providerStatus: "completed", deliveryState: "VIDEO_FETCH_INVALID", outputHost, upstreamHttpStatus: response.status } });
    return { ...row, status: "failed", error_code: "INVALID_PROVIDER_VIDEO" };
  }
  const outputKey = `generation-output/${row.user_id}/${row.run_id}.mp4`;
  try {
    if (deps?.putOutput) await deps.putOutput(outputKey, bytes);
    else if (env.GENERATION_MEDIA) await env.GENERATION_MEDIA.put(outputKey, bytes, { httpMetadata: { contentType: "video/mp4" } });
    else throw new Error("storage unavailable");
  } catch {
    return recordDiagnostic(row, env, { providerStatus: "completed", deliveryState: "OUTPUT_STORAGE_RETRYABLE", outputHost });
  }
  await updateGenerationRun(env, { runId: row.run_id, userId: row.user_id, status: "completed", resultUrl: outputKey, resultMeta: { providerStatus: "completed", outputHost, outputBytes: bytes.byteLength } });
  return { ...row, status: "completed", result_url: outputKey };
};
async function serveStoredJob(row, env, deps, attachment) {
  if (row.status !== "completed" || !row.result_url) return json({ ok: false, code: "NOT_READY" }, 409);
  const object = deps?.getOutput ? await deps.getOutput(row.result_url) : await env.GENERATION_MEDIA?.get(row.result_url);
  if (!object) return json({ ok: false, code: "NOT_FOUND" }, 404);
  const headers = new Headers({ "content-type": "video/mp4", "content-disposition": `${attachment ? "attachment" : "inline"}; filename="fancy-cafe-${row.run_id}.mp4"`, "cache-control": "private, no-store" });
  return new Response(object.body || object, { status: 200, headers });
}
export {
  GenerationHttpError,
  handleGeneration
};
