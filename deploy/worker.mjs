import { listCreditPacks } from '../payments/catalog.mjs';
import { VIDEO_ASSETS } from './video-assets.mjs';

const CANONICAL_HOST = 'fancycafeaivideo.pro';
const MAX_RANGE_BYTES = 8 * 1024 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function redirect(request) {
  const source = new URL(request.url);
  const target = new URL(`https://${CANONICAL_HOST}`);
  target.pathname = source.pathname;
  target.search = source.search;
  return Response.redirect(target.toString(), 301);
}

function parseRange(header, size) {
  if (!header?.startsWith('bytes=') || header.includes(',')) return null;
  const match = /^(\d*)-(\d*)$/.exec(header.slice(6).trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) return { invalid: true };
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function ifRangeMatches(request, response) {
  const value = request.headers.get('if-range');
  if (!value) return true;
  const etag = response.headers.get('etag');
  if (etag && !etag.startsWith('W/') && !value.startsWith('W/') && value === etag) return true;
  return value === response.headers.get('last-modified');
}

function passthrough(response, request, headers) {
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
}

async function serveMp4(request, env, pathname) {
  const headers = new Headers([...request.headers].filter(([key]) => !['range', 'if-range'].includes(key)));
  const upstream = await env.ASSETS.fetch(new Request(request, { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers }));
  const outputHeaders = new Headers(upstream.headers);
  const rangeHeader = request.headers.get('range');
  const rawLength = upstream.headers.get('content-length');
  const size = rawLength !== null && /^[0-9]+$/.test(rawLength.trim()) ? Number(rawLength) : VIDEO_ASSETS[pathname] ?? null;
  const supportsRange = Number.isSafeInteger(size) && size <= MAX_RANGE_BYTES;
  if (supportsRange) outputHeaders.set('accept-ranges', 'bytes');
  if (!upstream.ok || request.method === 'HEAD') return passthrough(upstream, request, outputHeaders);
  const range = supportsRange ? parseRange(rangeHeader, size) : null;
  const canBuffer = rangeHeader && range && ifRangeMatches(request, upstream);
  if (!canBuffer) return passthrough(upstream, request, outputHeaders);
  if (range.invalid) {
    outputHeaders.set('content-range', `bytes */${size}`);
    outputHeaders.set('content-length', '0');
    return new Response(null, { status: 416, headers: outputHeaders });
  }

  const body = await upstream.arrayBuffer();
  if (body.byteLength !== size) {
    outputHeaders.delete('accept-ranges');
    return new Response(body, { status: upstream.status, headers: outputHeaders });
  }
  const chunk = body.slice(range.start, range.end + 1);
  outputHeaders.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
  outputHeaders.set('content-length', String(chunk.byteLength));
  return new Response(chunk, { status: 206, headers: outputHeaders });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === `www.${CANONICAL_HOST}` || url.protocol === 'http:') return redirect(request);
    if (url.pathname === '/api/health') return json({ ok: true, mode: 'production-preview', providers: { ai: 'unconfigured', auth: 'unconfigured', payments: 'unconfigured' } });
    if (url.pathname === '/auth/me') return json({ ok: true, authenticated: false, user: null, mode: 'production-preview' });
    if (url.pathname === '/api/credit-packs') return json({ ok: true, mode: 'production-preview', paymentMode: 'unconfigured', packs: listCreditPacks() });
    if (url.pathname === '/api/generate') return json({ ok: false, code: 'PROVIDER_UNCONFIGURED', message: 'Video generation is not connected in this production preview. No video or credits were created.' }, 503);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return json({ ok: false, code: 'NOT_FOUND', message: 'This preview endpoint is not connected.' }, 404);
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.toLowerCase().endsWith('.mp4')) return serveMp4(request, env, url.pathname);
    return env.ASSETS.fetch(request);
  },
};
