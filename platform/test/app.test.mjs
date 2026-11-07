import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlatform } from '../server/app.mjs';
import { createBackend, HttpError } from '../server/backend.mjs';

const origin = 'https://example.test';
const user = '2f480c18-2504-4b9c-b2a4-fb2cdd212914';
const token = (sub = user, exp = 2 ** 31 - 1) =>
  'header.' + Buffer.from(JSON.stringify({ sub, exp })).toString('base64url') + '.signature';
const authCookie = (access = token()) => `__Host-pixkit-access=${access}; __Host-pixkit-refresh=refresh-fixture`;
const sessionData = () => ({ access_token: token(), refresh_token: 'refresh-fixture' });

function request(path, { method = 'GET', body, headers = {} } = {}) {
  return new Request(origin + path, {
    method,
    headers: method === 'POST' ? { origin, 'content-type': 'application/json', ...headers } : headers,
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

function fixture(overrides = {}) {
  const calls = [];
  const backend = {
    async rpc(name, params, bearer) {
      calls.push({ name, params, bearer });
      if (name === 'pixkit_profile') return { id: user, status: 'active' };
      if (name === 'pixkit_progress') return [];
      if (name === 'pixkit_catalog') return [{ id: 'programming', lessons: [
        { id: 'intro', available: true },
        { id: 'member-lesson', available: Boolean(bearer), access: 'registered' },
      ] }];
      if (name === 'pixkit_lesson') return { id: params.p_lesson_id, body: 'Authorized payload' };
      return { ok: true };
    },
    async sendEmail(email) {
      calls.push({ email });
      throw new HttpError(401, 'authentication_failed');
    },
    async verifyEmail(email, code) {
      calls.push({ email, code });
      return sessionData();
    },
    async refresh() { return sessionData(); },
    async signOut(bearer) { calls.push({ signOut: bearer }); },
    async deleteAccount(bearer) { calls.push({ deleteAccount: bearer }); },
    ...overrides,
  };
  const handle = createPlatform({
    origin, backend, languages: ['en', 'fr', 'ar'],
    authOptions: { google: true, apple: false, email: true },
    renderMember: (data) => JSON.stringify(data),
  });
  return { calls, handle };
}

test('guest sees preview but never requests the payload of a registered lesson', async () => {
  const { calls, handle } = fixture();
  const locked = await handle(request('/fr/learn/programming/member-lesson/'));
  assert.equal(locked.status, 200);
  assert.equal((await locked.json()).lesson.body, null);
  assert.equal(calls.some(({ name }) => name === 'pixkit_lesson'), false);

  const preview = await handle(request('/fr/learn/programming/intro/'));
  assert.equal((await preview.json()).lesson.body, 'Authorized payload');
  assert.equal(calls.at(-1).bearer, '');
});

test('member lesson uses the request token and explicitly bypasses caches', async () => {
  const { calls, handle } = fixture();
  const response = await handle(request('/ar/learn/programming/member-lesson/', {
    headers: { cookie: authCookie() },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await response.json()).lesson.body, 'Authorized payload');
  assert.equal(calls.at(-1).bearer, token());
});

test('API blocks cross-origin, stale-account and identity-injection mutations before RPC', async () => {
  const { calls, handle } = fixture();
  const path = '/api/learning/progress';
  const body = {
    p_course_id: 'programming', p_lesson_id: 'intro', p_completed: true,
    p_seen_at: '2026-01-01T00:00:00Z',
  };
  const headers = { cookie: authCookie() };
  for (const [extra, payload, status] of [
    [{ origin: 'https://attacker.test' }, body, 403],
    [{ 'x-pixkit-account': 'different-account' }, body, 409],
    [{}, { ...body, p_user_id: user }, 400],
  ]) {
    const result = await handle(request(path, { method: 'POST', body: payload, headers: { ...headers, ...extra } }));
    assert.equal(result.status, status);
  }
  const staleRead = await handle(request(path, {
    headers: { ...headers, 'x-pixkit-account': 'different-account' },
  }));
  assert.equal(staleRead.status, 409);
  assert.deepEqual(calls, []);
  const accepted = await handle(request(path, {
    method: 'POST', body, headers: { ...headers, 'x-pixkit-account': user },
  }));
  assert.equal(accepted.status, 200);
  assert.deepEqual(calls, [{ name: 'pixkit_record_progress', params: body, bearer: token() }]);
});

test('stream-size limits and whitelisted community routes stop arbitrary RPCs', async () => {
  const { calls, handle } = fixture();
  const tooLarge = await handle(request('/api/community/submit', {
    method: 'POST', body: { p_body: 'a'.repeat(70_000) },
  }));
  assert.equal(tooLarge.status, 413);
  const notFound = await handle(request('/api/community/claim'));
  assert.equal(notFound.status, 404);
  const invalid = await handle(request('/api/community/topics?p_offset=1&p_offset=2'));
  assert.equal(invalid.status, 400);
  const queue = await handle(request('/api/community/queue'));
  assert.equal(queue.status, 401);
  assert.deepEqual(calls, []);
  const read = await handle(request('/api/community/topics?p_sort=recent&p_offset=50'));
  assert.equal(read.status, 200);
  assert.deepEqual({ ...calls[0].params }, { p_sort: 'recent', p_offset: 50 });
});

test('email responses do not enumerate accounts and keep the session out of JSON', async () => {
  const { handle } = fixture();
  const send = await handle(request('/api/account/email', {
    method: 'POST', body: { email: 'student@example.test', locale: 'fr' },
  }));
  assert.deepEqual(await send.json(), { ok: true });
  const verify = await handle(request('/api/account/verify', {
    method: 'POST', body: { email: 'student@example.test', token: '123456' },
  }));
  assert.deepEqual(await verify.json(), { ok: true });
  const cookies = verify.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every((cookie) =>
    cookie.startsWith('__Host-pixkit-') && cookie.includes('Path=/') &&
    cookie.includes('HttpOnly; SameSite=Lax; Secure') && !cookie.includes('Domain=')));
});

test('SDK PKCE flow preserves browser verifier and clears it after callback', async () => {
  const upstream = 'https://project.example.test';
  let challenge;
  const backend = createBackend({
    url: upstream, publicKey: 'public-fixture',
    fetchImpl: async (input, options) => {
      assert.equal(input, upstream + '/auth/v1/token?grant_type=pkce');
      const body = JSON.parse(options.body);
      assert.equal(body.auth_code, 'known-code');
      assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), challenge);
      return Response.json({ ...sessionData(), expires_in: 3600, user: { id: user } });
    },
  });
  const { handle } = fixture({
    startOAuth: backend.startOAuth.bind(backend),
    finishOAuth: backend.finishOAuth.bind(backend),
  });
  const started = await handle(request('/auth/start?provider=google&locale=fr'));
  const authorize = new URL(started.headers.get('location'));
  assert.equal(authorize.origin, upstream);
  assert.equal(authorize.searchParams.get('redirect_to'), origin + '/auth/callback');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 's256');
  challenge = authorize.searchParams.get('code_challenge');
  const browserCookies = started.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  const callback = await handle(request('/auth/callback?code=known-code', {
    headers: { cookie: browserCookies },
  }));
  assert.equal(callback.headers.get('location'), '/fr/account/');
  const callbackCookies = callback.headers.getSetCookie();
  assert.equal(callbackCookies.filter((cookie) => cookie.includes('Max-Age=0')).length, 2);
  assert.ok(callbackCookies.some((cookie) => cookie.startsWith('__Host-pixkit-access=')));
});

test('refresh and logout stay scoped to the request session', async () => {
  const { calls, handle } = fixture();
  const response = await handle(request('/api/account/logout', {
    method: 'POST', body: {}, headers: { cookie: authCookie(token(user, 0)), 'x-pixkit-account': user },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ signOut: token() }]);
  assert.equal(response.headers.getSetCookie().filter((cookie) => cookie.includes('Max-Age=0')).length, 2);
});

test('deletion sets the deny-first flag before calling Auth admin for the verified user', async () => {
  const upstream = 'https://project.example.test';
  const calls = [];
  const backend = createBackend({
    url: upstream, publicKey: 'public-fixture', secretKey: 'service-fixture',
    fetchImpl: async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const init = input instanceof Request ? input : options;
      const headers = new Headers(init.headers);
      calls.push([url.pathname, init.method, headers.get('authorization')]);
      if (url.pathname.endsWith('/auth/v1/user')) return Response.json({ id: user });
      if (url.pathname.endsWith('/pixkit_request_account_deletion')) return Response.json({ status: 'deleting' });
      if (url.pathname.endsWith('/admin/users/' + user)) return Response.json({});
      throw new Error('Unexpected request');
    },
  });
  await backend.deleteAccount(token());
  assert.deepEqual(calls, [
    ['/auth/v1/user', 'GET', 'Bearer ' + token()],
    ['/rest/v1/rpc/pixkit_request_account_deletion', 'POST', 'Bearer ' + token()],
    ['/auth/v1/admin/users/' + user, 'GET', 'Bearer service-fixture'],
    ['/auth/v1/admin/users/' + user, 'DELETE', 'Bearer service-fixture'],
  ]);
});

test('MariaDB community allows public browsing and protects account operations', async () => {
  const handle = createPlatform({
    origin,
    languages: ['en', 'fr'],
    backend: { async rpc(name) { return { name }; } },
    renderCommunity: ({ profile }) => profile?.id ?? 'Public community',
  });
  const pagePath = '/fr/community/';
  const settings = '/api/community/settings';
  const guest = { profile: null };
  const member = { profile: { id: user } };
  const anonymous = await handle(request(pagePath), guest);
  assert.equal(anonymous.status, 200);
  assert.equal(await anonymous.text(), 'Public community');
  assert.equal((await handle(request('/community'), guest)).status, 200);
  assert.deepEqual(await (await handle(request(settings), guest)).json(), { name: 'pixkit_forum_settings' });
  assert.equal((await handle(request('/api/community/activity'), guest)).status, 401);
  assert.equal((await handle(request('/api/community/queue'), guest)).status, 401);
  assert.equal((await handle(request('/api/community/submit', { method: 'POST', body: {} }), guest)).status, 401);
  assert.equal(await (await handle(request(pagePath), member)).text(), user);
  assert.deepEqual(await (await handle(request(settings, { headers: { 'x-pixkit-account': user } }), member)).json(),
    { name: 'pixkit_forum_settings' });
  assert.equal((await handle(request(settings, { headers: { 'x-pixkit-account': 'old-account' } }), member)).status, 409);
  assert.equal((await handle(request('/api/community/submit', { method: 'POST', body: {} }), member)).status, 503);
});
