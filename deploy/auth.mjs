import { jwtVerify, createRemoteJWKSet } from 'jose';

export const AUTH_CALLBACK = 'https://fancycafeaivideo.pro/auth/google/callback';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const FLOW_TTL = 10 * 60 * 1000;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const text = (value) => new TextEncoder().encode(value);
const token = (bytes = 32) => { const values = new Uint8Array(bytes); crypto.getRandomValues(values); return btoa(String.fromCharCode(...values)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); };
const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', text(value)))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
const parseCookies = (header = '') => { const result = {}; for (const part of header.split(';')) { const [rawKey, ...rawValue] = part.trim().split('='); if (!rawKey) continue; try { result[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.join('=')); } catch {} } return result; };
const cookie = (name, value, maxAge, httpOnly = true) => `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax; Secure${httpOnly ? '; HttpOnly' : ''}`;
const clearFlowCookie = cookie('fancy_auth_flow', '', 0);
const clearSessionCookies = [cookie('fancy_session', '', 0), cookie('fancy_csrf', '', 0, false)];
const json = (body, status = 200, headers = {}) => { const responseHeaders = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); for (const [key, value] of Object.entries(headers)) Array.isArray(value) ? value.forEach((item) => responseHeaders.append(key, item)) : responseHeaders.set(key, value); return new Response(JSON.stringify(body), { status, headers: responseHeaders }); };
export const authConfigured = (env) => Boolean(env?.APP_DB && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const d1 = (env, sql, ...args) => env.APP_DB.prepare(sql).bind(...args);
function redirectResponse(location, cookies = []) { const headers = new Headers({ location, 'cache-control': 'no-store' }); for (const value of cookies) headers.append('set-cookie', value); return new Response(null, { status: 302, headers }); }

export async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get('cookie') || '');
  if (!cookies.fancy_session || !cookies.fancy_csrf || !env?.APP_DB) return null;
  const row = await d1(env, 'SELECT s.user_id, s.csrf_hash, s.expires_at, u.email, u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', await hash(cookies.fancy_session)).first();
  if (!row || Number(row.expires_at) <= Date.now()) return null;
  if (row.csrf_hash !== await hash(cookies.fancy_csrf)) return null;
  return { userId: row.user_id, email: row.email, name: row.name, csrfToken: cookies.fancy_csrf };
}

export async function requireSameOriginAndCsrf(request, session, env) {
  if (!session) return false;
  const origin = request.headers.get('origin');
  const expected = env.APP_ORIGIN || 'https://fancycafeaivideo.pro';
  return origin === expected && request.headers.get('x-csrf-token') === session.csrfToken;
}

async function verifyIdToken(idToken, nonce, env, injected) {
  const claims = injected ? await injected(idToken) : (await jwtVerify(idToken, JWKS, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env.GOOGLE_CLIENT_ID })).payload;
  if (claims.nonce !== nonce || claims.email_verified !== true) throw new Error('GOOGLE_IDENTITY_INVALID');
  if (!claims.sub || !claims.email) throw new Error('GOOGLE_IDENTITY_INVALID');
  return claims;
}

async function exchangeCode(code, verifier, env) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
  const response = await fetch(TOKEN_ENDPOINT, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: AUTH_CALLBACK, grant_type: 'authorization_code', code_verifier: verifier }) }).finally(() => clearTimeout(timeout));
  const data = await response.json();
  if (!response.ok || !data.id_token) throw new Error('GOOGLE_TOKEN_EXCHANGE_FAILED');
  return data;
}

async function start(request, env) {
  const state = token(); const nonce = token(); const verifier = token(48); const flowId = crypto.randomUUID();
  const requestedReturnTo = new URL(request.url).searchParams.get('returnTo') || '/';
  const returnToCandidate = requestedReturnTo.length <= 512 && !/[\u0000-\u001f\u007f]/.test(requestedReturnTo) ? requestedReturnTo : '/';
  let returnTo = '/'; try { const parsed = new URL(returnToCandidate, 'https://fancycafeaivideo.pro/'); if (parsed.origin === 'https://fancycafeaivideo.pro' && returnToCandidate.startsWith('/') && !returnToCandidate.startsWith('//') && !returnToCandidate.includes('\\')) returnTo = `${parsed.pathname}${parsed.search}${parsed.hash}`; } catch {}
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', text(verifier))))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const now = Date.now();
  await d1(env, 'INSERT INTO oauth_flows (id,state_hash,nonce,code_verifier,return_to,expires_at) VALUES (?,?,?,?,?,?)', flowId, await hash(state), nonce, verifier, returnTo, now + FLOW_TTL).run();
  const url = new URL(AUTH_ENDPOINT); url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: AUTH_CALLBACK, response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
  return redirectResponse(url.toString(), [cookie('fancy_auth_flow', flowId, 600)]);
}

async function callback(request, env, options) {
  const url = new URL(request.url); const cookies = parseCookies(request.headers.get('cookie') || ''); const state = url.searchParams.get('state'); const code = url.searchParams.get('code');
  if (!state || !code || !cookies.fancy_auth_flow) return json({ ok: false, code: 'AUTH_CALLBACK_INVALID' }, 400);
  const flow = await d1(env, 'SELECT id,nonce,code_verifier,return_to FROM oauth_flows WHERE id=? AND state_hash=? AND expires_at>? AND used_at IS NULL', cookies.fancy_auth_flow, await hash(state), Date.now()).first();
  if (!flow) return json({ ok: false, code: 'AUTH_STATE_INVALID' }, 400);
  const consumed = await d1(env, 'UPDATE oauth_flows SET used_at=? WHERE id=? AND used_at IS NULL', Date.now(), flow.id).run();
  if (consumed.meta?.changes !== 1) return json({ ok: false, code: 'AUTH_STATE_REPLAY' }, 400);
  try {
    const tokens = options?.exchangeCode ? await options.exchangeCode(code, flow.code_verifier) : await exchangeCode(code, flow.code_verifier, env);
    const claims = await verifyIdToken(tokens.id_token, flow.nonce, env, options?.verifyIdToken);
    const userId = crypto.randomUUID();
    await d1(env, 'INSERT INTO users (id,google_sub,email,name) VALUES (?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,name=excluded.name', userId, claims.sub, claims.email, claims.name || null).run();
    const user = await d1(env, 'SELECT id,email,name FROM users WHERE google_sub=?', claims.sub).first();
    const session = token(48); const csrf = token(32); await d1(env, 'DELETE FROM sessions WHERE user_id=?', user.id).run(); await d1(env, 'INSERT INTO sessions (token_hash,user_id,csrf_hash,expires_at) VALUES (?,?,?,?)', await hash(session), user.id, await hash(csrf), Date.now() + SESSION_TTL).run();
    return redirectResponse(new URL(flow.return_to || '/', 'https://fancycafeaivideo.pro/').toString(), [cookie('fancy_session', session, SESSION_TTL / 1000), cookie('fancy_csrf', csrf, SESSION_TTL / 1000, false), clearFlowCookie]);
  } catch { return json({ ok: false, code: 'AUTH_IDENTITY_INVALID' }, 401); }
}

export async function handleAuth(request, env, options = {}) {
  const url = new URL(request.url); if (!url.pathname.startsWith('/auth/')) return null;
  if (url.pathname === '/auth/me' && request.method === 'GET') { const session = await getSession(request, env); return json({ ok: true, authenticated: Boolean(session), authConfigured: authConfigured(env), user: session ? { id: session.userId, email: session.email, name: session.name } : null, csrfToken: session?.csrfToken ?? null }); }
  if (!['/auth/google/start', '/auth/google/callback', '/auth/logout'].includes(url.pathname)) return json({ ok: false, code: 'NOT_FOUND' }, 404);
  if (url.pathname === '/auth/google/start' && request.method === 'GET' && url.hostname !== 'fancycafeaivideo.pro') { const canonical = new URL('https://fancycafeaivideo.pro/auth/google/start'); const returnTo = url.searchParams.get('returnTo'); if (returnTo) canonical.searchParams.set('returnTo', returnTo); return redirectResponse(canonical.toString()); }
  if (!authConfigured(env)) return json({ ok: false, code: 'AUTH_CONFIGURATION_MISSING', message: 'Google OAuth and APP_DB are not configured.' }, 503);
  if (url.pathname === '/auth/google/start' && request.method === 'GET') return start(request, env);
  if (url.pathname === '/auth/google/callback' && request.method === 'GET') return callback(request, env, options);
  if (url.pathname === '/auth/logout' && request.method === 'POST') { const session = await getSession(request, env); if (!session || !(await requireSameOriginAndCsrf(request, session, env))) return json({ ok: false, code: 'CSRF_INVALID' }, 403); await d1(env, 'DELETE FROM sessions WHERE token_hash=?', await hash(parseCookies(request.headers.get('cookie') || '').fancy_session)).run(); return json({ ok: true, loggedOut: true }, 200, { 'set-cookie': clearSessionCookies }); }
  return json({ ok: false, code: 'NOT_FOUND' }, 404);
}
