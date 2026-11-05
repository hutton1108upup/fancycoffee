import { createHash } from 'node:crypto';
const MODEL = 'doubao-seedance-2.0';
const DURATION_SECONDS = 15;
const ASPECT_RATIO = '9:16';
// Informational snapshot from the APIMart model page, not a billing guarantee.
const PRICE_USD_PER_SECOND = Object.freeze({ '480p': 0.066, '720p': 0.142 });
const PRICING_SOURCE = 'https://apimart.ai/model/doubao-seedance-2-0';

export class GenerationError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'GenerationError'; this.code = code; this.details = details; }
}
function isReference(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('asset://')) return /^asset:\/\/[^\s/]+$/.test(value);
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; }
}
export function estimateCostUsd(resolution, durationSeconds = DURATION_SECONDS) {
  if (!Object.hasOwn(PRICE_USD_PER_SECOND, resolution)) throw new GenerationError('INVALID_RESOLUTION', 'resolution must be 480p or 720p');
  return Number((PRICE_USD_PER_SECOND[resolution] * durationSeconds).toFixed(4));
}
export function requestHash(payload) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
export function normalizeGenerationRequest(input) {
  if (!input || typeof input !== 'object') throw new GenerationError('INVALID_REQUEST', 'request must be an object');
  const style = input.style === 'closer' ? 'closer' : input.style === 'standard' ? 'standard' : null;
  const resolution = input.resolution === '480p' || input.resolution === '720p' ? input.resolution : null;
  if (!style) throw new GenerationError('INVALID_STYLE', 'style must be standard or closer');
  if (!resolution) throw new GenerationError('INVALID_RESOLUTION', 'resolution must be 480p or 720p');
  const lead = input.lead; const regular = input.regular ?? null;
  if (!lead || typeof lead !== 'object' || !isReference(lead.url)) throw new GenerationError('LEAD_PHOTO_REQUIRED', 'one approved lead photo URL or asset:// reference is required');
  if (regular && (typeof regular !== 'object' || !isReference(regular.url))) throw new GenerationError('INVALID_REGULAR_PHOTO', 'regular photo must be an http(s) URL or approved asset:// reference');
  const subjectRule = regular
    ? 'The required first-timer photo is person 1 and the optional regular photo is person 2; preserve both real people identities, faces, clothing, and proportions without inventing or swapping a person.'
    : 'The required first-timer photo is person 1; create a fictional adult regular as person 2, and preserve the first-timer identity, face, clothing, and proportions without changing that person.';
  const styleRule = style === 'closer' ? 'Keep the people and scene closely faithful to the supplied references.' : 'Keep the motion natural while using the supplied references as visual guidance.';
  const story = 'In a fancy cafe, the first-timer mistakes the tiny wall-mounted round table for a chair and sits on it. The regular enters and sits on the long bench, placing a coffee on the round table. The first-timer realizes the mistake, climbs down, sits on the bench, and acts completely normal; preserve the tiny-table joke, elegant interior, warm practical light, gentle handheld camera, and tasteful social video pacing.';
  const prompt = `${story} ${subjectRule} ${styleRule}${input.prompt ? ` ${String(input.prompt).trim()}` : ''}`.slice(0, 4000);
  return { model: MODEL, prompt, size: ASPECT_RATIO, resolution, duration: DURATION_SECONDS, image_urls: [lead.url, ...(regular ? [regular.url] : [])], generate_audio: true, nsfw_check: true };
}
export function estimate(input) {
  const payload = normalizeGenerationRequest(input);
  return { payload, requestHash: requestHash(payload), estimatedCostUsd: estimateCostUsd(payload.resolution), pricing: { source: PRICING_SOURCE, unit: 'USD per output second', snapshot: { '480p': 0.066, '720p': 0.142 }, limitation: 'APIMart billing is variable by tier, discounts, final output and reference assets; no CNY conversion or <=8 CNY guarantee is made here.' }, dryRun: true };
}
function validQuote(quote, now = Date.now()) {
  return quote && quote.currency === 'CNY' && Number.isFinite(quote.amountCny) && quote.amountCny >= 0 && quote.amountCny <= 8 && Number.isFinite(Date.parse(quote.expiresAt)) && Date.parse(quote.expiresAt) > now;
}
export function createApimartSeedanceClient({ apiKey, accountConfirmed = false, configVerified = false, explicitRun = false, cnyQuote, fetchImpl = globalThis.fetch, timeoutMs = 30_000, now = () => Date.now() } = {}) {
  let state = 'idle';
  let taskId = null;
  const prepare = (input) => estimate(input);
  const guard = (payload) => {
    if (!apiKey || !accountConfirmed || !configVerified || !explicitRun || !validQuote(cnyQuote, now())) throw new GenerationError('REAL_RUN_NOT_AUTHORIZED', 'Real submission requires API key, confirmed account, verified config, explicit run authorization, and an unexpired CNY quote no higher than 8 CNY.', { state, dryRun: true });
    if (payload?.payload?.model !== MODEL) throw new GenerationError('MODEL_MISMATCH', `Only the configured ${MODEL} model is accepted.`);
    if (cnyQuote.requestHash !== requestHash(payload.payload)) throw new GenerationError('QUOTE_MISMATCH', 'The CNY quote is not bound to this exact normalized request.');
  };
  const request = async (path, options) => {
    if (typeof fetchImpl !== 'function') throw new GenerationError('FETCH_UNAVAILABLE', 'fetch is required for an explicitly authorized provider call');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://api.apimart.ai${path}`, { ...options, signal: controller.signal, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' } });
      let body; try { body = await response.json(); } catch { throw new GenerationError('PROVIDER_UNKNOWN', 'Provider returned invalid JSON; outcome is unknown.'); }
      if (!response.ok) throw new GenerationError(response.status >= 500 ? 'PROVIDER_UNKNOWN' : 'PROVIDER_ERROR', body?.error?.message || `APIMart request failed (${response.status})`, { status: response.status });
      return body;
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError('PROVIDER_UNKNOWN', 'Provider request timed out or failed before its outcome was known.', { cause: error?.message });
    } finally { clearTimeout(timer); }
  };
  return Object.freeze({
    prepare,
    get state() { return state; },
    async submit(input) {
      if (state === 'submitting') throw new GenerationError('SUBMISSION_IN_PROGRESS', 'A submission is already in progress; do not retry concurrently.');
      const prepared = prepare(input);
      guard(prepared);
      if (state === 'submitted') throw new GenerationError('ALREADY_SUBMITTED', 'A task is already submitted; query it instead of submitting again.', { taskId });
      if (state === 'unknown') throw new GenerationError('UNCERTAIN_NO_RETRY', 'Previous submission outcome is unknown; query the existing task if a task ID is available.');
      state = 'submitting';
      try {
        const body = await request('/v1/videos/generations', { method: 'POST', body: JSON.stringify(prepared.payload) });
        taskId = body?.data?.[0]?.task_id || body?.data?.task_id;
        if (!taskId) throw new GenerationError('INVALID_PROVIDER_RESPONSE', 'APIMart did not return a task ID');
        state = 'submitted';
        return { taskId, state, dryRun: false, quote: { amountCny: cnyQuote.amountCny, expiresAt: cnyQuote.expiresAt } };
      } catch (error) {
        if (error.code === 'PROVIDER_UNKNOWN' || error.code === 'INVALID_PROVIDER_RESPONSE') state = 'unknown';
        throw error;
      }
    },
    async getTask(id = taskId) {
      if (!apiKey || !configVerified) throw new GenerationError('REAL_RUN_NOT_AUTHORIZED', 'Task queries require a configured API key and verified config.');
      if (!id || typeof id !== 'string') throw new GenerationError('INVALID_TASK_ID', 'taskId is required');
      return request(`/v1/tasks/${encodeURIComponent(id)}`, { method: 'GET' });
    },
  });
}
export const providerSpec = Object.freeze({ model: MODEL, durationSeconds: DURATION_SECONDS, aspectRatio: ASPECT_RATIO, resolutions: ['480p', '720p'], requiredPhotos: 1, optionalPhotos: 1, realSubmission: false });
