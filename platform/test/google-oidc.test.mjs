import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createGoogleOidc } from '../server/google-oidc.mjs';

const origin = 'https://app.example.com';
const clientId = 'fixture.apps.googleusercontent.com';
const clientSecret = 'fixture-client-credential';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const certEndpoint = 'https://www.googleapis.com/oauth2/v1/certs';
const state = 'fixture_oauth_state';
const nonce = 'fixture_oauth_nonce';
const verifier = 'v'.repeat(43);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function idToken(overrides, header = { alg: 'RS256', kid: 'fixture-key' }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://accounts.google.com',
    aud: clientId,
    nonce,
    sub: '1023456789',
    email: 'member@example.com',
    email_verified: true,
    name: 'Example Member',
    picture: 'https://images.example.com/member.png',
    iat: now,
    exp: now + 300,
    ...overrides,
  };
  const message = `${encode(header)}.${encode(payload)}`;
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url')}`;
}

function fixture(tokenResponse) {
  const requests = [];
  const google = createGoogleOidc({
    origin,
    clientId,
    clientSecret,
    async fetchImpl(url, init) {
      requests.push({ url: String(url), init });
      if (String(url) === tokenEndpoint) return tokenResponse();
      if (String(url) === certEndpoint) {
        return Response.json({
          'fixture-key': publicKey.export({ type: 'spki', format: 'pem' }),
        }, { headers: { 'Cache-Control': 'public, max-age=600' } });
      }
      throw new Error('Unexpected provider endpoint');
    },
  });
  return { google, requests };
}

test('authorization uses exact callback, state, nonce and S256 without disclosing client credentials', () => {
  const { google, requests } = fixture();
  const authorize = new URL(google.authorizationUrl({ state, nonce, verifier }));
  assert.equal(authorize.origin, 'https://accounts.google.com');
  assert.equal(authorize.pathname, '/o/oauth2/v2/auth');
  assert.deepEqual(Object.fromEntries(authorize.searchParams), {
    client_id: clientId,
    redirect_uri: origin + '/auth/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  assert.deepEqual(requests, []);
});

test('exchange verifies a signed ID token and exposes only the verified profile', async () => {
  const { google, requests } = fixture(() => Response.json({
    id_token: idToken(),
    access_token: 'provider-access-fixture',
    refresh_token: 'provider-refresh-fixture',
  }));
  const expected = {
    subject: '1023456789',
    email: 'member@example.com',
    displayName: 'Example Member',
    avatarUrl: 'https://images.example.com/member.png',
  };
  assert.deepEqual(await google.exchange('code/one', { nonce, verifier }), expected);
  assert.deepEqual(await google.exchange('code/two', { nonce, verifier }), expected);
  assert.deepEqual(requests.map(({ url }) => url), [tokenEndpoint, certEndpoint, tokenEndpoint]);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[1].init.redirect, 'error');
  assert.deepEqual(Object.fromEntries(requests[0].init.body), {
    grant_type: 'authorization_code',
    code: 'code/one',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: origin + '/auth/callback',
    code_verifier: verifier,
  });
});

test('rejects wrong signatures, algorithms, issuer, audience, presenter, nonce, time and unverified email', async () => {
  const [header, payload] = idToken().split('.');
  const invalid = [
    `${header}.${payload}.YQ`,
    idToken({}, { alg: 'none', kid: 'fixture-key' }),
    idToken({ iss: 'googleapis.com' }),
    idToken({ aud: 'other.apps.googleusercontent.com' }),
    idToken({ azp: 'other.apps.googleusercontent.com' }),
    idToken({ nonce: 'different_oauth_nonce' }),
    idToken({ iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) - 1 }),
    idToken({ email_verified: false }),
    idToken({ email_verified: 'false' }),
    idToken({ email: 'invalid-email' }),
    idToken({ sub: '' }),
  ];
  for (const token of invalid) {
    const { google } = fixture(() => Response.json({ id_token: token }));
    await assert.rejects(google.exchange('fixture-code', { nonce, verifier }), {
      status: 401,
      message: 'authentication_failed',
    });
  }
});

test('allows optional profile fields and checks transaction inputs before using the provider', async () => {
  const { google, requests } = fixture(() => Response.json({
    id_token: idToken({ email_verified: 'true', name: '\u0000', picture: 'http://example.com/avatar' }),
  }));
  await assert.rejects(google.exchange('fixture-code', { nonce, verifier: '' }), { status: 401 });
  assert.deepEqual(requests, []);
  const profile = await google.exchange('fixture-code', { nonce, verifier });
  assert.equal(profile.displayName, 'Member');
  assert.equal(profile.avatarUrl, null);
});

test('provider failures expose generic errors', async () => {
  for (const [status, expected] of [[400, 401], [429, 503], [500, 503]]) {
    const { google } = fixture(() => new Response('private upstream details', { status }));
    await assert.rejects(google.exchange('fixture-code', { nonce, verifier }), { status: expected });
  }
  const { google } = fixture(() => { throw new Error('private connection details'); });
  await assert.rejects(google.exchange('fixture-code', { nonce, verifier }), {
    status: 503,
    message: 'service_unavailable',
  });
});
