import { OAuth2Client } from 'google-auth-library';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

export class GoogleAuthConfigurationError extends Error {
  constructor(message) { super(message); this.name = 'GoogleAuthConfigurationError'; this.code = 'AUTH_CONFIGURATION_MISSING'; }
}
export class GoogleAuthError extends Error {
  constructor(message, code = 'GOOGLE_AUTH_FAILED', details = {}) { super(message); this.name = 'GoogleAuthError'; this.code = code; Object.assign(this, details); }
}
function requiredString(value, name) { if (typeof value !== 'string' || value.trim() === '') throw new GoogleAuthConfigurationError(`${name} is required`); return value.trim(); }
async function jsonResponse(response, operation) { try { return await response.json(); } catch { throw new GoogleAuthError(`Google returned an invalid ${operation} response`, 'GOOGLE_INVALID_RESPONSE'); } }
function identityFromPayload(payload) { const claims = payload?.payload ?? payload; if (!claims || typeof claims !== 'object' || typeof claims.sub !== 'string' || !claims.sub) throw new GoogleAuthError('Google identity has no stable subject', 'GOOGLE_INVALID_IDENTITY'); if (claims.email && claims.email_verified === false) throw new GoogleAuthError('Google email is not verified', 'GOOGLE_EMAIL_UNVERIFIED'); return { provider: 'google', subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : null, emailVerified: claims.email_verified === true, name: typeof claims.name === 'string' ? claims.name : null, picture: typeof claims.picture === 'string' ? claims.picture : null, locale: typeof claims.locale === 'string' ? claims.locale : null }; }

export function createGoogleAuth(options = {}) {
  const env = options.env ?? process.env;
  const clientId = options.clientId ?? env.GOOGLE_CLIENT_ID;
  const clientSecret = options.clientSecret ?? env.GOOGLE_CLIENT_SECRET;
  const redirectUri = options.redirectUri ?? env.GOOGLE_REDIRECT_URI;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const verifier = options.verifyIdToken;
  const oauthClient = options.oauthClient ?? (typeof clientId === 'string' && typeof clientSecret === 'string' ? new OAuth2Client(clientId, clientSecret, redirectUri) : null);
  const configured = [clientId, clientSecret, redirectUri].every((value) => typeof value === 'string' && value.trim() !== '');
  function requireConfigured() { if (!configured) throw new GoogleAuthConfigurationError('Google auth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI'); if (typeof fetchImpl !== 'function') throw new GoogleAuthConfigurationError('A fetch implementation is required for Google auth'); }
  return {
    isConfigured: configured,
    getAuthorizationUrl({ state, nonce, codeChallenge, scopes = DEFAULT_SCOPES, prompt = 'select_account' } = {}) { requireConfigured(); requiredString(state, 'state'); requiredString(nonce, 'nonce'); requiredString(codeChallenge, 'codeChallenge'); const url = new URL(AUTH_ENDPOINT); url.search = new URLSearchParams({ client_id: clientId.trim(), redirect_uri: redirectUri.trim(), response_type: 'code', scope: scopes.join(' '), state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256', access_type: 'offline', prompt }); return url.toString(); },
    async exchangeCode(code, { expectedNonce, codeVerifier } = {}) { requireConfigured(); requiredString(code, 'code'); requiredString(expectedNonce, 'expectedNonce'); requiredString(codeVerifier, 'codeVerifier'); const response = await fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ code, client_id: clientId.trim(), client_secret: clientSecret.trim(), redirect_uri: redirectUri.trim(), grant_type: 'authorization_code', code_verifier: codeVerifier }) }); const body = await jsonResponse(response, 'token'); if (!response.ok || !body.access_token) throw new GoogleAuthError(body.error_description || 'Google authorization code exchange failed', 'GOOGLE_TOKEN_EXCHANGE_FAILED', { status: response.status }); if (!body.id_token) throw new GoogleAuthError('Google token response has no ID token', 'GOOGLE_INVALID_RESPONSE'); const claims = await this.verifyIdToken(body.id_token, { expectedNonce }); return { identity: identityFromPayload(claims), accessToken: body.access_token, expiresIn: body.expires_in ?? null, refreshToken: body.refresh_token ?? null }; },
    async verifyIdToken(idToken, { expectedNonce } = {}) { requireConfigured(); requiredString(idToken, 'idToken'); requiredString(expectedNonce, 'expectedNonce'); let verified; try { verified = verifier ? await verifier(idToken, { expectedNonce, clientId: clientId.trim() }) : await oauthClient.verifyIdToken({ idToken, audience: clientId.trim() }); } catch (error) { if (error instanceof GoogleAuthError) throw error; throw new GoogleAuthError('Google ID token verification failed', 'GOOGLE_INVALID_IDENTITY', { cause: error }); } const claims = verified?.getPayload ? verified.getPayload() : (verified?.payload ?? verified); if (!claims || (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com')) throw new GoogleAuthError('Google identity issuer is not trusted', 'GOOGLE_INVALID_IDENTITY'); if (claims.aud !== clientId.trim()) throw new GoogleAuthError('Google identity audience does not match this client', 'GOOGLE_INVALID_IDENTITY'); if (!Number.isInteger(Number(claims.exp)) || Number(claims.exp) <= Math.floor(Date.now() / 1000)) throw new GoogleAuthError('Google ID token is expired or has no valid expiry', 'GOOGLE_INVALID_IDENTITY'); if (claims.nonce !== expectedNonce) throw new GoogleAuthError('Google identity nonce does not match', 'GOOGLE_INVALID_IDENTITY'); return claims; },
    async getUserInfo() { throw new GoogleAuthError('Userinfo alone is not a verified ID token identity; use exchangeCode', 'GOOGLE_IDENTITY_UNVERIFIED'); },
  };
}
