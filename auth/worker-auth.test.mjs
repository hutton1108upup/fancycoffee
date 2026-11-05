import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getSession, handleAuth } from '../deploy/auth.mjs';

class FakeDB {
  constructor() { this.users = []; this.flows = []; this.sessions = []; }
  prepare(sql) {
    const db = this;
    return { bind(...args) {
      return {
        async first() {
          if (sql.startsWith('SELECT id,nonce')) return db.flows.find((row) => row.id === args[0] && row.state_hash === args[1] && row.expires_at > args[2] && row.used_at === null) || null;
          if (sql.startsWith('SELECT id,email')) { const user = db.users.find((row) => row.google_sub === args[0]); return user && { id: user.id, email: user.email, name: user.name }; }
          if (sql.startsWith('SELECT s.user_id')) { const session = db.sessions.find((row) => row.token_hash === args[0]); const user = session && db.users.find((item) => item.id === session.user_id); return session && user ? { ...session, email: user.email, name: user.name } : null; }
          return null;
        },
        async run() {
          if (sql.startsWith('INSERT INTO oauth_flows')) db.flows.push({ id: args[0], state_hash: args[1], nonce: args[2], code_verifier: args[3], return_to: args[4], expires_at: args[5], used_at: null });
          else if (sql.startsWith('UPDATE oauth_flows')) { const row = db.flows.find((item) => item.id === args[1] && item.used_at === null); if (row) row.used_at = args[0]; return { meta: { changes: row ? 1 : 0 } }; }
          else if (sql.startsWith('INSERT INTO users')) { let row = db.users.find((item) => item.google_sub === args[1]); if (!row) { row = { id: args[0], google_sub: args[1] }; db.users.push(row); } row.email = args[2]; row.name = args[3]; }
          else if (sql.startsWith('INSERT INTO sessions')) db.sessions.push({ token_hash: args[0], user_id: args[1], csrf_hash: args[2], expires_at: args[3] });
          else if (sql.startsWith('DELETE FROM sessions WHERE user_id')) db.sessions = db.sessions.filter((row) => row.user_id !== args[0]);
          else if (sql.startsWith('DELETE FROM sessions')) db.sessions = db.sessions.filter((row) => row.token_hash !== args[0]);
          return { meta: { changes: 1 } };
        },
      };
    } };
  }
}

const env = () => ({ APP_DB: new FakeDB(), GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'secret', APP_ORIGIN: 'https://fancycafeaivideo.pro' });
const sets = (response) => response.headers.getSetCookie();
function applyCookies(jar, response) { for (const value of sets(response)) { const [pair] = value.split(';'); const [name, ...parts] = pair.split('='); if (parts.join('=')) jar.set(name, decodeURIComponent(parts.join('='))); else jar.delete(name); } }
const cookieHeader = (jar) => [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');

class SqliteD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8')); }
  prepare(sql) { const database = this.db; return { bind(...args) { return { async first() { return database.prepare(sql).get(...args) ?? null; }, async run() { const result = database.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; } }; } }; }
}

test('worker OAuth mock flow persists session, binds returnTo, and rejects replay', async () => {
  const runtime = env();
  const start = await handleAuth(new Request('https://fancycafeaivideo.pro/auth/google/start?returnTo=%2Fpricing'), runtime);
  assert.equal(start.status, 302);
  const flowCookie = sets(start).find((value) => value.startsWith('fancy_auth_flow=')).split(';')[0];
  const authUrl = new URL(start.headers.get('location'));
  const options = { exchangeCode: async () => ({ id_token: 'id' }), verifyIdToken: async () => ({ sub: 'sub-1', email: 'user@example.com', email_verified: true, name: 'User', nonce: authUrl.searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 300 }) };
  const callback = await handleAuth(new Request(`https://fancycafeaivideo.pro/auth/google/callback?state=${authUrl.searchParams.get('state')}&code=code`, { headers: { cookie: flowCookie } }), runtime, options);
  assert.equal(callback.status, 302);
  assert.equal(new URL(callback.headers.get('location')).pathname, '/pricing');
  const cookies = sets(callback);
  const sessionCookie = cookies.find((value) => value.startsWith('fancy_session=')).split(';')[0];
  const csrfCookie = cookies.find((value) => value.startsWith('fancy_csrf=')).split(';')[0];
  const me = await handleAuth(new Request('https://fancycafeaivideo.pro/auth/me', { headers: { cookie: `${sessionCookie}; ${csrfCookie}` } }), runtime);
  assert.equal((await me.json()).authenticated, true);
  const replay = await handleAuth(new Request(`https://fancycafeaivideo.pro/auth/google/callback?state=${authUrl.searchParams.get('state')}&code=code`, { headers: { cookie: flowCookie } }), runtime, options);
  assert.equal(replay.status, 400);
});

test('worker.dev auth start redirects to canonical before setting flow cookie', async () => { const response = await handleAuth(new Request('https://fancycoffee.workers.dev/auth/google/start?returnTo=%2Fpricing'), { APP_DB: new FakeDB(), GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'secret' }); assert.equal(response.status, 302); assert.equal(new URL(response.headers.get('location')).origin, 'https://fancycafeaivideo.pro'); assert.equal(response.headers.getSetCookie().length, 0); });

test('worker auth rejects malformed cookies and unsafe returnTo without storing a session', async () => { const runtime = env(); const me = await handleAuth(new Request('https://fancycafeaivideo.pro/auth/me', { headers: { cookie: '%broken=%%; fancy_session=x; fancy_csrf=y' } }), runtime); assert.equal((await me.json()).authenticated, false); for (const value of ['//evil.example', '/\\evil', '/\u0001evil']) { const response = await handleAuth(new Request(`https://fancycafeaivideo.pro/auth/google/start?returnTo=${encodeURIComponent(value)}`), runtime); assert.equal(response.status, 302); assert.equal(new URL(response.headers.get('location')).origin, 'https://accounts.google.com'); } assert.equal(runtime.APP_DB.sessions.length, 0); });

test('worker callback rejects nonce mismatch, unverified email, and expired flow identity', async () => { for (const claimsPatch of [{ nonce: 'wrong', email_verified: true, exp: Math.floor(Date.now() / 1000) + 300 }, { nonce: null, email_verified: false, exp: Math.floor(Date.now() / 1000) + 300 }, { nonce: null, email_verified: true, exp: Math.floor(Date.now() / 1000) - 1 }]) { const runtime = env(); const start = await handleAuth(new Request('https://fancycafeaivideo.pro/auth/google/start'), runtime); const flowCookie = sets(start).find((value) => value.startsWith('fancy_auth_flow=')).split(';')[0]; const authUrl = new URL(start.headers.get('location')); const response = await handleAuth(new Request(`https://fancycafeaivideo.pro/auth/google/callback?state=${authUrl.searchParams.get('state')}&code=code`, { headers: { cookie: flowCookie } }), runtime, { exchangeCode: async () => ({ id_token: 'id' }), verifyIdToken: async () => ({ sub: 'negative', email: 'negative@example.com', ...claimsPatch }) }); assert.equal(response.status, 401); assert.equal(runtime.APP_DB.sessions.length, 0); } });

test('worker logout requires same-origin and CSRF token', async () => {
  const runtime = env();
  const start = await handleAuth(new Request('https://fancycafeaivideo.pro/auth/google/start'), runtime);
  const flowCookie = sets(start).find((value) => value.startsWith('fancy_auth_flow=')).split(';')[0];
  const authUrl = new URL(start.headers.get('location'));
  const callback = await handleAuth(new Request(`https://fancycafeaivideo.pro/auth/google/callback?state=${authUrl.searchParams.get('state')}&code=code`, { headers: { cookie: flowCookie } }), runtime, { exchangeCode: async () => ({ id_token: 'id' }), verifyIdToken: async () => ({ sub: 'sub-2', email: 'two@example.com', email_verified: true, nonce: authUrl.searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 300 }) });
  const cookies = sets(callback); const session = cookies.find((value) => value.startsWith('fancy_session=') && !value.startsWith('fancy_session=;')).split(';')[0]; const csrf = cookies.find((value) => value.startsWith('fancy_csrf=') && !value.startsWith('fancy_csrf=;')).split(';')[0].split('=')[1];
  const cookieHeader = `${session}; fancy_csrf=${csrf}`;
  const denied = await handleAuth(new Request('https://fancycafeaivideo.pro/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example', cookie: cookieHeader } }), runtime);
  assert.equal(denied.status, 403);
  const accepted = await handleAuth(new Request('https://fancycafeaivideo.pro/auth/logout', { method: 'POST', headers: { origin: 'https://fancycafeaivideo.pro', 'x-csrf-token': decodeURIComponent(csrf), cookie: cookieHeader } }), runtime);
  assert.equal(accepted.status, 200);
  assert.equal(await getSession(new Request('https://fancycafeaivideo.pro/auth/me', { headers: { cookie: cookieHeader } }), runtime), null);
});

test('real node:sqlite D1 adapter persists rotation and emits separate logout cookies', async () => {
  const runtime = { APP_DB: new SqliteD1(), GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'secret', APP_ORIGIN: 'https://fancycafeaivideo.pro' };
  const complete = async (subject, jar, returnTo = '/') => { const start = await handleAuth(new Request(`https://fancycafeaivideo.pro/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`), runtime); applyCookies(jar, start); const authUrl = new URL(start.headers.get('location')); const response = await handleAuth(new Request(`https://fancycafeaivideo.pro/auth/google/callback?state=${authUrl.searchParams.get('state')}&code=code`, { headers: { cookie: cookieHeader(jar) } }), runtime, { exchangeCode: async () => ({ id_token: 'id' }), verifyIdToken: async () => ({ sub: subject, email: `${subject}@example.com`, email_verified: true, nonce: authUrl.searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 300 }) }); applyCookies(jar, response); return response; };
  const firstJar = new Map(); const first = await complete('sqlite-user', firstJar, '/pricing'); const firstSession = firstJar.get('fancy_session'); const firstCsrf = firstJar.get('fancy_csrf'); assert.equal(sets(first).filter((value) => value.startsWith('fancy_session=') && !value.startsWith('fancy_session=;')).length, 1); assert.equal(sets(first).filter((value) => value.startsWith('fancy_csrf=') && !value.startsWith('fancy_csrf=;')).length, 1);
  const secondJar = new Map(); await complete('sqlite-user', secondJar); const secondSession = secondJar.get('fancy_session'); const secondCsrf = secondJar.get('fancy_csrf');
  assert.equal(await getSession(new Request('https://fancycafeaivideo.pro/auth/me', { headers: { cookie: cookieHeader(new Map([['fancy_session', firstSession], ['fancy_csrf', firstCsrf]])) } }), runtime), null);
  const logout = await handleAuth(new Request('https://fancycafeaivideo.pro/auth/logout', { method: 'POST', headers: { origin: 'https://fancycafeaivideo.pro', 'x-csrf-token': secondCsrf, cookie: cookieHeader(secondJar) } }), runtime); assert.equal(logout.status, 200); applyCookies(secondJar, logout); assert.equal(logout.headers.getSetCookie().length, 2); assert.equal(await getSession(new Request('https://fancycafeaivideo.pro/auth/me', { headers: { cookie: cookieHeader(secondJar) } }), runtime), null);
});
