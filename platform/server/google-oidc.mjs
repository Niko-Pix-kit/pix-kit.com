import { createHash } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { HttpError } from './backend.mjs';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const OPAQUE_VALUE = /^[!-~]{16,256}$/;
const ID_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function authenticationFailed() {
  return new HttpError(401, 'authentication_failed');
}

function unavailable() {
  return new HttpError(503, 'service_unavailable');
}

function profileAvatar(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\p{Cc}]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

function profileFromClaims(claims, nonce, clientId) {
  const now = Math.floor(Date.now() / 1000);
  if (!claims || claims.nonce !== nonce ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.exp <= now || claims.exp <= claims.iat ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now)) ||
      typeof claims.sub !== 'string' || !/^[!-~]{1,255}$/.test(claims.sub) ||
      ![true, 'true'].includes(claims.email_verified) ||
      typeof claims.email !== 'string' || claims.email.length > 254 ||
      !/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u.test(claims.email)) {
    throw authenticationFailed();
  }

  const name = typeof claims.name === 'string' ? claims.name.replace(/\p{Cc}/gu, '').trim() : '';
  return {
    subject: claims.sub,
    email: claims.email,
    displayName: Array.from(name).slice(0, 80).join('') || 'Member',
    avatarUrl: profileAvatar(claims.picture),
    ...(typeof claims.given_name === 'string' ? { givenName: claims.given_name } : {}),
    ...(typeof claims.family_name === 'string' ? { familyName: claims.family_name } : {}),
  };
}

export function createGoogleOidc({ clientId, clientSecret, origin, fetchImpl = fetch }) {
  if (typeof clientId !== 'string' || !clientId.trim() ||
      typeof clientSecret !== 'string' || !clientSecret.trim()) {
    throw new Error('Google OAuth client ID and secret are required');
  }
  const base = new URL(origin);
  const loopback = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.origin !== origin || (base.protocol !== 'https:' && !loopback)) {
    throw new Error('Google OAuth requires an HTTPS origin or a loopback HTTP origin');
  }
  const callback = new URL('/auth/callback', base).href;
  const client = new OAuth2Client({
    clientId,
    redirectUri: callback,
    issuers: ISSUERS,
    transporterOptions: {
      timeout: 5_000,
      fetchImplementation: (input, init) => fetchImpl(input, { ...init, redirect: 'error' }),
    },
  });

  return {
    authorizationUrl({ state, nonce, verifier }) {
      if (typeof state !== 'string' || !OPAQUE_VALUE.test(state) ||
          typeof nonce !== 'string' || !OPAQUE_VALUE.test(nonce) ||
          typeof verifier !== 'string' || !VERIFIER.test(verifier)) throw authenticationFailed();
      return client.generateAuthUrl({
        scope: ['openid', 'email', 'profile'],
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      });
    },

    async exchange(code, { nonce, verifier }) {
      if (typeof code !== 'string' || !/^[!-~]{1,2048}$/.test(code) ||
          typeof nonce !== 'string' || !OPAQUE_VALUE.test(nonce) ||
          typeof verifier !== 'string' || !VERIFIER.test(verifier)) throw authenticationFailed();

      let response;
      try {
        response = await fetchImpl(TOKEN_ENDPOINT, {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: callback,
            code_verifier: verifier,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw unavailable();
      }
      if (response.status === 429 || response.status >= 500) throw unavailable();
      if (!response.ok) throw authenticationFailed();

      let claims;
      try {
        const { id_token: idToken } = await response.json();
        if (typeof idToken !== 'string' || idToken.length > 16_384 || !ID_TOKEN.test(idToken)) {
          throw authenticationFailed();
        }
        const header = JSON.parse(Buffer.from(idToken.split('.', 1)[0], 'base64url').toString('utf8'));
        if (header?.alg !== 'RS256' || header.crit !== undefined) throw authenticationFailed();
        const ticket = await client.verifyIdToken({ idToken, audience: clientId });
        claims = ticket.getPayload();
      } catch (error) {
        // SDK exceptions can contain the token or decoded claims.
        if (error?.config) throw unavailable();
        throw authenticationFailed();
      }
      return profileFromClaims(claims, nonce, clientId);
    },
  };
}
