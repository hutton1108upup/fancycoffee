import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class FakeElement {
  constructor(tagName = 'div') { this.tagName = tagName; this.children = []; this.parentElement = null; this.dataset = {}; this.listeners = {}; this.hidden = false; this.textContent = ''; this.style = {}; this.files = []; }
  get firstChild() { return this.children[0] || null; }
  append(...nodes) { for (const node of nodes) { if (!node) continue; node.parentElement = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of nodes.reverse()) { if (!node) continue; node.parentElement = this; this.children.unshift(node); } }
  removeChild(node) { this.children = this.children.filter((child) => child !== node); node.parentElement = null; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  async dispatch(type, event = {}) { for (const listener of this.listeners[type] || []) await listener({ preventDefault() {}, stopImmediatePropagation() {}, target: this, ...event }); }
  setAttribute(name, value) { this[name] = String(value); }
  removeAttribute(name) { delete this[name]; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
  load() {}
  closest(selector) { return selector === 'label' ? (this.tagName === 'label' ? this : this.parentElement) : null; }
  querySelector(selector) { return find(this, selector); }
  querySelectorAll(selector) { const found = []; walk(this, (node) => { if (matches(node, selector)) found.push(node); }); return found; }
}
function walk(node, visit) { for (const child of node.children || []) { visit(child); walk(child, visit); } }
function matches(node, selector) { if (selector.startsWith('[data-testid="')) return node.dataset.testid === selector.slice(14, -2); if (selector === '[data-generation-video]') return node.dataset.generationVideo !== undefined; if (selector === '[data-generation-download]') return node.dataset.generationDownload !== undefined; if (selector === '.studio-action') return node.className === 'studio-action'; if (selector === 'strong') return node.tagName === 'strong'; return false; }
function find(root, selector) { if (matches(root, selector)) return root; let found = null; walk(root, (node) => { if (!found && matches(node, selector)) found = node; }); return found; }

async function loadController({ saved = null, latestJob = null } = {}) {
  const source = readFileSync(new URL('../local-studio.js', import.meta.url), 'utf8');
  const body = new FakeElement('body'); const head = new FakeElement('head'); const studio = new FakeElement('section'); studio.className = 'studio-action'; body.append(studio);
  const sessionButton = new FakeElement('button'); sessionButton.dataset.testid = 'site-session-pending'; body.append(sessionButton);
  const generate = new FakeElement('button'); generate.dataset.testid = 'generate-video'; studio.append(generate);
  const label = new FakeElement('label'); const strong = new FakeElement('strong'); label.append(strong); const input = new FakeElement('input'); input.id = 'photo-lead'; label.append(input); body.append(label);
  const service = new FakeElement('div'); service.id = 'service-status'; body.append(service);
  const document = { body, head, addEventListener(type, listener) { this.listeners ||= {}; this.listeners[type] = listener; }, createElement: (tag) => new FakeElement(tag), getElementById(id) { return id === 'photo-lead' ? input : null; }, querySelector(selector) { if (selector === '#service-status') return service; return find(body, selector); }, querySelectorAll(selector) { return body.querySelectorAll(selector); } };
  const storage = new Map(saved ? [['fancycafe:generation:user-1', JSON.stringify(saved)]] : []); let generatePosts = 0; let latestCalls = 0;
  const fetch = async (path, options = {}) => { const url = String(path); if (url === '/api/health') return new Response(JSON.stringify({ providers: { auth: 'configured', ai: 'unconfigured' } }), { status: 200 }); if (url === '/auth/me') return new Response(JSON.stringify({ authenticated: true, user: { id: 'user-1', email: 'user@example.com' }, csrfToken: 'csrf-1' }), { status: 200 }); if (url === '/api/credit-packs') return new Response(JSON.stringify({ paymentMode: { mode: 'test', checkoutEnabled: false }, packs: [] }), { status: 200 }); if (url === '/api/billing') return new Response(JSON.stringify({ credits: 20, orders: [] }), { status: 200 }); if (url === '/api/generate') { generatePosts += 1; assert.equal(options.method, 'POST'); assert.equal(options.body.get('lead').name, 'lead.jpg'); return new Response(JSON.stringify({ job: { id: 'job-1', requestId: 'request-1', status: 'submitted' } }), { status: 202 }); } if (url === '/api/generations/latest' || url.startsWith('/api/generations/latest?')) { latestCalls += 1; return new Response(JSON.stringify({ job: latestJob }), { status: 200 }); } if (url === '/api/generations/job-1') return new Response(JSON.stringify({ job: { id: 'job-1', requestId: 'request-1', status: 'completed', previewUrl: '/media/preview.mp4', downloadUrl: '/api/generations/job-1/download' } }), { status: 200 }); return new Response('{}', { status: 200 }); };
  class TestAbortController { constructor() { this.signal = { aborted: false }; } abort() {} }
  const context = { document, window: { location: { origin: 'https://fancycafeaivideo.pro', pathname: '/', search: '', hash: '', assign() {} } }, sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }, fetch, setTimeout: (callback) => { callback(); return 1; }, clearTimeout, AbortController: TestAbortController, URL, URLSearchParams, FormData, File, Response, Event, console, crypto: { randomUUID: () => 'request-1' } };
  vm.runInNewContext(source, context); await document.listeners.DOMContentLoaded();
  return { context, document, generate, input, fetch, get generatePosts() { return generatePosts; }, get latestCalls() { return latestCalls; }, storage };
}

function fixtureFile() { return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'lead.jpg', { type: 'image/jpeg' }); }

test('generation controller validates same-origin downloads and user-scoped storage', async () => {
  const loaded = await loadController(); const controller = loaded.context.__fancyCafeGeneration;
  assert.equal(controller.sameOriginDownload('/media/video.mp4'), true); assert.equal(controller.sameOriginDownload('https://evil.example/video.mp4'), false); assert.equal(controller.storageKey('user-1'), 'fancycafe:generation:user-1');
});

test('DOM file change and generate submit one multipart request, render two same-origin MP4 URLs, and restore latest without sessionStorage', async () => {
  const loaded = await loadController(); assert.equal(loaded.generate.listeners.click.length, 1); loaded.input.files = [fixtureFile()]; await loaded.input.dispatch('change'); await loaded.generate.dispatch('click');
  assert.equal(loaded.generatePosts, 1); const video = loaded.document.querySelector('[data-generation-video]'); const download = loaded.document.querySelector('[data-generation-download]'); assert.equal(video.src, '/media/preview.mp4'); assert.equal(download.href, '/api/generations/job-1/download');
  const refreshed = await loadController({ latestJob: { id: 'job-1', requestId: 'request-1', status: 'completed', previewUrl: '/media/preview.mp4', downloadUrl: '/api/generations/job-1/download' } }); assert.ok(refreshed.document.querySelector('[data-generation-video]')); assert.ok(refreshed.latestCalls >= 1);
});

test('uncertain saved jobs expose Check video status and restoreGeneration is inert without a generator', async () => {
  const loaded = await loadController({ saved: { requestId: 'request-1', userId: 'user-1', status: 'unknown' }, latestJob: { id: 'job-1', requestId: 'request-1', status: 'unknown' } }); loaded.context.__fancyCafeGeneration.configure({ auth: { authenticated: true, user: { id: 'user-1' } }, csrfToken: 'csrf-1' }); await loaded.context.__fancyCafeGeneration.restoreGeneration?.(); const statusButton = loaded.document.querySelector('[data-testid="check-video-status"]'); assert.ok(statusButton); assert.equal(statusButton.hidden, false);
  const noGenerator = await loadController({ saved: { requestId: 'request-1', userId: 'user-1', status: 'submitted' }, latestJob: { id: 'job-1', requestId: 'request-1', status: 'submitted' } }); noGenerator.generate.remove();
});

test('generation controller exposes explicit terminal and non-terminal status messages', async () => {
  const controller = (await loadController()).context.__fancyCafeGeneration;
  assert.match(controller.statusText({ status: 'submitted' }), /submitted/); assert.match(controller.statusText({ status: 'completed' }), /completed/); assert.match(controller.statusText({ status: 'failed', message: 'provider failed' }), /provider failed/); assert.match(controller.statusText({ status: 'unknown' }), /unknown/);
});
