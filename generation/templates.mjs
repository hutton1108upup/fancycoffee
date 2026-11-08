export const TEMPLATE_VERSION = 'person-pet-v1';
export const PERSON_REFERENCE_MAX_SECONDS = 9;
export const PERSON_PROMPT = 'Create a 15-second 9:16 fancy cafe social video with a slow, natural pace. Replace only the main subject with the adult person shown in the supplied image, preserve that person\'s visible characteristics, and keep the secondary regular as a fictional adult. Use the approved reference video only for motion guidance; do not reproduce any source-video text or watermark, and output no text or watermark. Keep the tiny wall-mounted round table joke: the first-timer mistakes it for a chair and sits on it, the regular sits on the long bench and places coffee on the round table, then the first-timer realizes the mistake, climbs down, sits on the bench, and acts normal.';
export const PET_PROMPT = 'Create a 15-second 9:16 fancy cafe social video from the supplied pet image. Show a grey concrete wall; on the right, the main pet awkwardly sits on the wall-mounted small round table while holding a brown coffee cup with a white lid; on the left, a white Samoyed wearing a shoulder bag sits on the long bench and places its cup on the small table; the main pet understands the mistake, climbs down embarrassed, sits on the bench, and preserves the user-uploaded pet characteristics throughout.';

export function templateName(value) {
  return value === 'person' || value === 'pet' ? value : null;
}

export function promptForTemplate(template) {
  if (template === 'person') return PERSON_PROMPT;
  if (template === 'pet') return PET_PROMPT;
  return null;
}

export function canonicalTemplateRequest({ template, authorizedRunId, leadHash, referenceHash = null, referenceDuration = null, promptVersion = TEMPLATE_VERSION, model = 'seedance-2.0', size = '9:16', resolution = '480p', duration = 15, rateUsdPerSecond = null }) {
  return { template, authorizedRunId, leadHash, referenceHash, referenceDuration, promptVersion, prompt: promptForTemplate(template), model, size, resolution, duration, rateUsdPerSecond };
}

export function templatePayload({ template, leadUrl, referenceUrl = null }) {
  const prompt = promptForTemplate(template);
  if (!prompt || !leadUrl) return null;
  return {
    model: 'seedance-2.0',
    prompt,
    size: '9:16',
    resolution: '480p',
    duration: 15,
    image_urls: [leadUrl],
    ...(template === 'person' && referenceUrl ? { video_urls: [referenceUrl] } : {}),
    generate_audio: true,
    nsfw_check: true,
  };
}

export function templateQuote({ template, referenceDuration = 0, rateUsdPerSecond, fx, expiresAt, now = Date.now() }) {
  const rate = Number(rateUsdPerSecond);
  const exchange = Number(fx);
  const expires = Date.parse(expiresAt || '');
  const seconds = template === 'person' ? 15 + Number(referenceDuration) : template === 'pet' ? 15 : NaN;
  const usd = Number((seconds * rate).toFixed(4));
  const cny = Number((usd * exchange).toFixed(4));
  if (!templateName(template) || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(exchange) || exchange <= 0 || !Number.isFinite(seconds) || !Number.isFinite(usd) || !Number.isFinite(cny) || cny > 8 || !Number.isFinite(expires) || expires <= now) return null;
  return { usd, cny, fx: exchange, expiresAt: new Date(expires).toISOString(), referenceSeconds: template === 'person' ? Number(referenceDuration) : 0 };
}

export async function templateFingerprint(input) {
  const canonical = canonicalTemplateRequest(input);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
