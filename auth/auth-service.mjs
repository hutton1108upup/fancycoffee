import { createHash, randomBytes } from 'node:crypto';
import { GoogleAuthConfigurationError, GoogleAuthError } from './google-auth.mjs';

const SESSION_COOKIE = 'fancy_session';
const FLOW_COOKIE = 'fancy_auth_flow';
const PENDING_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const b64 = (value) => value.toString('base64url');
const secret = (bytes = 32) => b64(randomBytes(bytes));
const codeChallenge = (verifier) => b64(createHash('sha256').update(verifier).digest());
const parseCookies = (header = '') => { const cookies = {}; for (const item of header.split(';')) { const [rawKey, ...rawValue] = item.trim().split('='); if (!rawKey) continue; try { cookies[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.join('=')); } catch { /* ignore malformed cookies */ } } return cookies; };

export function createAuthService({ googleAuth, now = () => Date.now(), secureCookies = false } = {}) {
  const pending = new Map();
  const sessions = new Map();
  const configured = Boolean(googleAuth?.isConfigured);
  function purge() { const current = now(); for (const [key, value] of pending) if (value.expiresAt <= current) pending.delete(key); for (const [key, value] of sessions) if (value.expiresAt <= current) sessions.delete(key); }
  function cookie(name, value, maxAge) { return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`; }
  function start() { purge(); if (!configured) throw new GoogleAuthConfigurationError('Google auth is not configured'); const state = secret(); const nonce = secret(); const verifier = secret(48); const flowId = secret(24); pending.set(state, { flowId, nonce, verifier, expiresAt: now() + PENDING_TTL_MS }); return { state, flowId, flowCookie: cookie(FLOW_COOKIE, flowId, 600), url: googleAuth.getAuthorizationUrl({ state, nonce, codeChallenge: codeChallenge(verifier) }) }; }
  async function callback({ state, code, error, flowId } = {}) { purge(); if (error) throw new GoogleAuthError(`Google authorization failed: ${error}`, 'GOOGLE_AUTH_CANCELLED'); if (!state || !code) throw new GoogleAuthError('Google callback requires state and code', 'AUTH_CALLBACK_INVALID'); const item = pending.get(state); pending.delete(state); if (!item || item.flowId !== flowId || item.expiresAt <= now()) throw new GoogleAuthError('Google authorization state is invalid or expired', 'AUTH_STATE_INVALID'); const result = await googleAuth.exchangeCode(code, { expectedNonce: item.nonce, codeVerifier: item.verifier }); const sessionId = secret(48); sessions.set(sessionId, { identity: result.identity, expiresAt: now() + SESSION_TTL_SECONDS * 1000 }); return { sessionId, identity: result.identity }; }
  function getSession(request) { purge(); const id = parseCookies(request.headers.cookie)[SESSION_COOKIE]; const session = id ? sessions.get(id) : null; return session && session.expiresAt > now() ? { id, ...session } : null; }
  function logout(request) { const id = parseCookies(request.headers.cookie)[SESSION_COOKIE]; if (id) sessions.delete(id); return cookie(SESSION_COOKIE, '', 0); }
  return { configured, start, callback, getSession, logout, sessionCookie: SESSION_COOKIE, flowCookie: FLOW_COOKIE, sessionMaxAge: SESSION_TTL_SECONDS, cookie: (value, maxAge) => cookie(SESSION_COOKIE, value, maxAge) };
}

export { codeChallenge, parseCookies, SESSION_COOKIE };
