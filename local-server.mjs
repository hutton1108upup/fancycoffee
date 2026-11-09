import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCreditPacks } from './payments/catalog.mjs';
import { createGoogleAuth, GoogleAuthConfigurationError, GoogleAuthError } from './auth/google-auth.mjs';
import { createAuthService } from './auth/auth-service.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const rootBase = normalize(root).replace(/[\\/]+$/, '');
const port = Number(process.env.PORT || 8766);
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const costs = { standard: { '480p': 20, '720p': 40 }, closer: { '480p': 30, '720p': 50 } };
const googleAuth = createGoogleAuth();
const auth = createAuthService({ googleAuth, secureCookies: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true' });
const publicRootFiles = new Set(['index.html', 'manifest.json', 'brand.svg', 'og.png', 'robots.txt', 'local-studio.js']);
const publicDirs = new Set(['about', 'blog', 'contact', 'cookie', 'examples', 'fancy-cafe-pov-ideas', 'fancy-cafe-pov-meme-meaning', 'fancy-cafe-pov-trend-tiktok', 'first-time-in-a-fancy-cafe-ai-free', 'first-time-in-a-fancy-cafe-viral-video', 'fonts', 'how-to-make-first-time-in-a-fancy-cafe-ai-video', 'media', 'pricing', 'privacy', 'reference', 'refund', 'terms']);
function isPublicFile(file) { const rel = relative(rootBase, normalize(file)).replaceAll('\\', '/'); const [first] = rel.split('/'); if (!rel || rel.startsWith('..')) return false; if (!rel.includes('/')) return publicRootFiles.has(rel); return publicDirs.has(first) && !rel.endsWith('.mjs') && !rel.endsWith('.json'); }
function json(res, status, body, headers = {}) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); }
function redirect(res, location, headers = {}) { res.writeHead(302, { location, 'cache-control': 'no-store', ...headers }); res.end(); }
async function readJson(req) { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 32_000) throw new Error('request_too_large'); } return JSON.parse(raw || '{}'); }
function validate(payload) {
  const style = payload.style === 'closer' ? 'closer' : payload.style === 'standard' ? 'standard' : null;
  const resolution = payload.resolution === '720p' ? '720p' : payload.resolution === '480p' ? '480p' : null;
  if (!style || !resolution) return 'style and resolution are required';
  if (!payload.lead || typeof payload.lead !== 'object') return 'one lead photo is required';
  for (const [role, photo] of Object.entries({ lead: payload.lead, regular: payload.regular })) if (photo && (!allowedTypes.has(photo.type) || !Number.isFinite(photo.size) || photo.size <= 0 || photo.size > 10 * 1024 * 1024)) return `${role} photo must be JPG, PNG or WebP and no larger than 10 MB`;
  return null;
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, mode: 'local-preview', providers: { ai: 'unconfigured', auth: auth.configured ? 'configured' : 'unconfigured', payments: 'unconfigured' } });
  if (url.pathname === '/auth/google/start' && req.method === 'GET') { try { const flow = auth.start(); return redirect(res, flow.url, { 'set-cookie': flow.flowCookie }); } catch (error) { if (error instanceof GoogleAuthConfigurationError) return json(res, 503, { ok: false, code: error.code, message: error.message }); throw error; } }
  if (url.pathname === '/auth/google/callback' && req.method === 'GET') { try { const cookies = req.headers.cookie || ''; const match = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${auth.flowCookie}=`)); const result = await auth.callback({ state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error'), flowId: match?.slice(auth.flowCookie.length + 1) }); return redirect(res, '/', { 'set-cookie': [auth.cookie(result.sessionId, auth.sessionMaxAge), `${auth.flowCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`] }); } catch (error) { const known = error instanceof GoogleAuthConfigurationError || error instanceof GoogleAuthError; return json(res, known && error.code === 'AUTH_STATE_INVALID' ? 400 : known ? 502 : 500, { ok: false, code: known ? error.code : 'AUTH_CALLBACK_FAILED', message: known ? error.message : 'Google sign-in failed.' }); } }
  if (url.pathname === '/auth/me' && req.method === 'GET') { const session = auth.getSession(req); return json(res, 200, { ok: true, authenticated: Boolean(session), user: session?.identity ?? null }); }
  if (url.pathname === '/auth/logout' && req.method === 'POST') { const origin = req.headers.origin; if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return json(res, 403, { ok: false, code: 'CSRF_ORIGIN_INVALID' }); return json(res, 200, { ok: true, loggedOut: true }, { 'set-cookie': auth.logout(req) }); }
  if (url.pathname === '/api/credit-packs' && req.method === 'GET') return json(res, 200, { ok: true, mode: 'local-preview', paymentMode: 'unconfigured', packs: listCreditPacks() });
  if (url.pathname === '/api/generate' && req.method === 'POST') {
    try { const payload = await readJson(req); const error = validate(payload); if (error) return json(res, 400, { ok: false, code: 'INVALID_REQUEST', message: error }); return json(res, 503, { ok: false, code: 'PROVIDER_UNCONFIGURED', message: 'AI video generation is not configured in this local preview. No video or credits were created.', spec: { durationSeconds: 15, ratio: '9:16', style: payload.style, resolution: payload.resolution, credits: costs[payload.style][payload.resolution] } }); } catch { return json(res, 400, { ok: false, code: 'INVALID_JSON', message: 'Send a JSON request.' }); }
  }
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return json(res, 404, { ok: false, code: 'NOT_FOUND' });
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  if (requested.includes('..')) return json(res, 404, { ok: false, code: 'NOT_FOUND' });
  let file = normalize(join(root, requested));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  else if (!extname(file) && existsSync(join(file, 'index.html'))) file = join(file, 'index.html');
  if ((file !== rootBase && !file.startsWith(rootBase + sep)) || !existsSync(file) || !statSync(file).isFile() || !isPublicFile(file)) return json(res, 404, { ok: false, code: 'NOT_FOUND' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.woff2': 'font/woff2' }; res.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] || 'application/octet-stream' });
  if (file === join(root, 'index.html')) { res.end(readFileSync(file, 'utf8').replace('</body>', '<script src="/local-studio.js" defer></script></body>')); } else createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`Fancy Cafe local preview: http://127.0.0.1:${port}/`));
