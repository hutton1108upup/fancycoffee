import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../deploy/worker.mjs';

const videoBytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
let arrayBufferCalls = 0;
const assets = {
  fetch: async (request) => {
    if (!new URL(request.url).pathname.endsWith('.mp4')) return new Response(`asset:${new URL(request.url).pathname}`, { status: 200, headers: { 'content-type': 'text/plain' } });
    const response = new Response(request.method === 'HEAD' ? null : videoBytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(videoBytes.byteLength), etag: '"video-v1"', 'last-modified': 'Wed, 05 Nov 2026 00:00:00 GMT' } });
    const original = response.arrayBuffer.bind(response);
    response.arrayBuffer = async () => { arrayBufferCalls += 1; return original(); };
    return response;
  },
};
const call = (url, init) => worker.fetch(new Request(url, init), { ASSETS: assets });

test('publish worker redirects www and http while preserving path and query', async () => {
  const www = await call('https://www.fancycafeaivideo.pro/blog/?x=1');
  assert.equal(www.status, 301);
  assert.equal(www.headers.get('location'), 'https://fancycafeaivideo.pro/blog/?x=1');
  const http = await call('http://fancycafeaivideo.pro/pricing?x=2');
  assert.equal(http.status, 301);
  assert.equal(http.headers.get('location'), 'https://fancycafeaivideo.pro/pricing?x=2');
});

test('publish worker exposes preview API boundaries and assets only', async () => {
  assert.equal((await call('https://fancycafeaivideo.pro/api/health')).status, 200);
  assert.equal((await call('https://fancycafeaivideo.pro/auth/me')).status, 200);
  const packs = await call('https://fancycafeaivideo.pro/api/credit-packs');
  assert.equal(packs.status, 200);
  assert.equal((await packs.json()).packs.length, 3);
  assert.equal((await call('https://fancycafeaivideo.pro/api/generate', { method: 'POST' })).status, 503);
  assert.equal((await call('https://fancycafeaivideo.pro/auth/google/start')).status, 404);
  const asset = await call('https://fancycafeaivideo.pro/index.html');
  assert.equal(asset.status, 200);
  assert.equal((await asset.text()).startsWith('asset:'), true);
});

test('publish worker serves single MP4 ranges and safe fallbacks', async () => {
  arrayBufferCalls = 0;
  const exact = await call('https://fancycafeaivideo.pro/media/fancy-cafe/reference-19s.mp4', { headers: { range: 'bytes=2-5' } });
  assert.equal(exact.status, 206);
  assert.equal(exact.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(exact.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Array.from(new Uint8Array(await exact.arrayBuffer())), [2, 3, 4, 5]);
  assert.equal(arrayBufferCalls, 1);
  const noRange = await call('https://fancycafeaivideo.pro/media/fancy-cafe/reference-19s.mp4');
  assert.equal(noRange.status, 200);
  assert.equal(arrayBufferCalls, 1);
  const open = await call('https://fancycafeaivideo.pro/media/fancy-cafe/reference-19s.mp4', { headers: { range: 'bytes=7-' } });
  assert.equal(open.status, 206);
  assert.deepEqual(Array.from(new Uint8Array(await open.arrayBuffer())), [7, 8, 9]);
  const suffix = await call('https://fancycafeaivideo.pro/media/fancy-cafe/reference-19s.mp4', { headers: { range: 'bytes=-3' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Array.from(new Uint8Array(await suffix.arrayBuffer())), [7, 8, 9]);
  const head = await call('https://fancycafeaivideo.pro/media/fancy-cafe/reference-19s.mp4', { method: 'HEAD', headers: { range: 'bytes=0-2' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  const invalid = await call('https://fancycafeaivideo.pro/media/fancy-cafe/reference-19s.mp4', { headers: { range: 'bytes=99-100' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */10');
  const multi = await call('https://fancycafeaivideo.pro/media/fancy-cafe/reference-19s.mp4', { headers: { range: 'bytes=0-1,4-5' } });
  assert.equal(multi.status, 200);
  const mismatched = await call('https://fancycafeaivideo.pro/media/fancy-cafe/reference-19s.mp4', { headers: { range: 'bytes=0-1', 'if-range': '"old"' } });
  assert.equal(mismatched.status, 200);
  const weak = await call('https://fancycafeaivideo.pro/media/fancy-cafe/reference-19s.mp4', { headers: { range: 'bytes=0-1', 'if-range': 'W/"video-v1"' } });
  assert.equal(weak.status, 200);
});

test('publish worker streams oversized MP4 without buffering', async () => {
  let calls = 0;
  const largeAssets = { fetch: async () => { const response = new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(9 * 1024 * 1024) } }); response.arrayBuffer = async () => { calls += 1; return new ArrayBuffer(0); }; return response; } };
  const response = await worker.fetch(new Request('https://fancycafeaivideo.pro/media/large.mp4', { headers: { range: 'bytes=0-2' } }), { ASSETS: largeAssets });
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
});

test('publish worker streams unknown length and rejects ranges on zero length', async () => {
  const unknown = { fetch: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'video/mp4' } }) };
  const unknownResponse = await worker.fetch(new Request('https://fancycafeaivideo.pro/media/unknown.mp4', { headers: { range: 'bytes=0-2' } }), { ASSETS: unknown });
  assert.equal(unknownResponse.status, 200);
  assert.equal(unknownResponse.headers.has('accept-ranges'), false);
  const empty = { fetch: async () => new Response(null, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '0' } }) };
  const emptyResponse = await worker.fetch(new Request('https://fancycafeaivideo.pro/media/empty.mp4', { headers: { range: 'bytes=0-0' } }), { ASSETS: empty });
  assert.equal(emptyResponse.status, 416);
  assert.equal(emptyResponse.headers.get('content-range'), 'bytes */0');
});

test('publish worker uses the tracked size manifest when assets omit content length', async () => {
  const body = new Uint8Array(2293781);
  body.set([10, 11, 12, 13, 14, 15], 2);
  const manifestAssets = { fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } }) };
  const response = await worker.fetch(new Request('https://fancycafeaivideo.pro/media/fancy-cafe/reference-19s.mp4', { headers: { range: 'bytes=2-5' } }), { ASSETS: manifestAssets });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/2293781');
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [10, 11, 12, 13]);
});
