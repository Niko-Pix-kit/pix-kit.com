import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createLocalAccounts } from '../server/local-accounts.mjs';

const origin = 'https://example.test';
const identity = { subject: 'fixture-subject', email: 'member@example.invalid',
  displayName: '<script>Example</script>', avatarUrl: 'https://lh3.googleusercontent.com/example' };
const user = { ...identity, id: 'fixture-user', isAdmin: false };
const digest = (token) => createHash('sha256').update(token).digest('hex');

function fixture(emailAuth, trustedProxy = false) {
  const sessions = new Map();
  const calls = { exchange: 0, list: 0, deleted: 0 };
  let clock = 100_000;
  const handle = createLocalAccounts({
    origin, languages: ['en', 'fr'], emailAuth, trustedProxy, now: () => clock,
    google: {
      authorizationUrl: ({ state }) => 'https://accounts.google.com/?state=' + state,
      async exchange() { calls.exchange++; return identity; },
    },
    store: {
      async signIn(input, hash, expiry, { replaceSessionHash } = {}) {
        assert.deepEqual(input, identity);
        assert.ok(expiry.valueOf() > clock);
        sessions.set(hash, user);
        if (replaceSessionHash) sessions.delete(replaceSessionHash);
      },
      async session(hash) { return sessions.get(hash); },
      async nicknameAvailability(nickname) {
        return { available: nickname !== 'ExistingMember', suggestions: ['ExistingMember1'] };
      },
      async publicProfile(nickname) {
        return nickname === 'PublicMember' ? { nickname, avatarUrl: '/assets/avatars/robot.svg', countryCode: 'JP' } : null;
      },
      async revokeSession(hash) { sessions.delete(hash); },
      async updateProfile(hash, data) {
        if (sessions.has(hash)) sessions.set(hash, { ...sessions.get(hash), ...data });
      },
      async deleteAccount(hash) { calls.deleted++; sessions.delete(hash); },
      async listUsers() {
        calls.list++;
        return { total: 1, users: [{ ...user, createdAt: '2026-01-01', lastSignInAt: '2026-01-02' }] };
      },
    },
    publicHandler: async request => {
      assert.equal(request.headers.get('cookie'), null);
      return new Response('Public page');
    },
  });
  const request = (path, init) => handle(new Request(origin + path, init));
  const seed = (profile) => {
    const token = randomBytes(32).toString('base64url');
    sessions.set(digest(token), profile);
    return '__Host-pixkit-session=' + token;
  };
  return { request, seed, sessions, calls, advance: (ms) => { clock += ms; } };
}

const cookie = (response, name) => response.headers.getSetCookie()
  .find(value => value.startsWith('__Host-pixkit-' + name + '='));

test('direct Google registration validates state, clears the flow and issues an opaque session', async () => {
  const { request, seed, sessions, calls } = fixture();
  const previous = seed({ ...user, id: 'previous' });
  const start = await request('/auth/start?provider=google&locale=fr');
  const flow = cookie(start, 'google-flow');
  assert.match(flow, /HttpOnly; SameSite=Lax; Secure/);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = await request('/auth/callback?code=fixture&state=' + state, {
    headers: { Cookie: flow.split(';', 1)[0] + '; ' + previous },
  });
  assert.equal(callback.headers.get('location'), '/fr/account/');
  assert.match(cookie(callback, 'google-flow'), /Max-Age=0/);
  const session = cookie(callback, 'session');
  assert.match(session, /HttpOnly; SameSite=Lax; Secure/);
  assert.equal(calls.exchange, 1);
  assert.equal(sessions.size, 1);
  const account = await request('/fr/account/', { headers: { Cookie: session.split(';', 1)[0] } });
  assert.match(await account.text(), /&lt;script&gt;Example&lt;\/script&gt;/);
  assert.equal(account.headers.get('cache-control'), 'private, no-store');
  assert.equal(account.headers.get('referrer-policy'), 'same-origin');
});

test('wrong, duplicate and expired OAuth state never reaches Google or MariaDB', async () => {
  const { request, calls, sessions, advance } = fixture();
  const start = await request('/auth/start?provider=google');
  const headers = { Cookie: cookie(start, 'google-flow').split(';', 1)[0] };
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const wrong = await request('/auth/callback?code=fixture&state=invalid', { headers });
  assert.match(wrong.headers.get('location'), /authentication_failed/);
  const duplicate = await request('/auth/callback?code=fixture&state=' + state + '&state=' + state, { headers });
  assert.match(duplicate.headers.get('location'), /authentication_failed/);
  advance(601_000);
  const stale = await request('/auth/callback?code=fixture&state=' + state, { headers });
  assert.match(stale.headers.get('location'), /authentication_failed/);
  assert.equal(calls.exchange, 0);
  assert.equal(sessions.size, 0);
});

test('only an active administrator sees the roster, and public pages ignore account cookies', async () => {
  const { request, seed, calls } = fixture();
  assert.equal((await request('/admin/users/')).status, 404);
  const member = seed(user);
  assert.equal((await request('/admin/users/', { headers: { Cookie: member } })).status, 404);
  assert.equal(await (await request('/learn/', { headers: { Cookie: member } })).text(), 'Public page');
  const admin = seed({ ...user, isAdmin: true });
  const page = await request('/admin/users/', { headers: { Cookie: admin } });
  const body = await page.text();
  assert.match(body, /Total users: 1/);
  assert.match(body, /member@example\.invalid/);
  assert.match(body, /&lt;script&gt;Example/);
  assert.match(body, /referrerpolicy="no-referrer"/);
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.equal(calls.list, 1);
});

test('account deletion requires confirmation and logout rejects cross-origin requests', async () => {
  const { request, seed, calls, sessions } = fixture();
  const session = seed(user);
  const headers = { Cookie: session, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' };
  assert.equal((await request('/account/logout/', { method: 'POST', headers: { Cookie: session } })).status, 403);
  for (const invalidOrigin of ['null', 'https://other.example']) {
    const invalid = await request('/account/logout/', { method: 'POST', headers: { ...headers, Origin: invalidOrigin } });
    assert.equal(invalid.status, 403);
  }
  assert.equal((await request('/account/delete/', { method: 'POST', headers })).status, 400);
  const deleted = await request('/account/delete/', { method: 'POST', headers, body: 'confirm=yes' });
  assert.equal(deleted.status, 303);
  assert.match(cookie(deleted, 'session'), /Max-Age=0/);
  assert.equal(calls.deleted, 1);
  assert.equal(sessions.size, 0);
  const logout = await request('/account/logout/', { method: 'POST', headers: { ...headers, Cookie: seed(user) } });
  assert.equal(logout.status, 303);
  assert.equal(sessions.size, 0);
});


test('the account profile edits the current session only and keeps verified email outside the form', async () => {
  const { request, seed, sessions } = fixture();
  const member = seed(user);
  const profile = new URLSearchParams({
    givenName: '<Edited>', familyName: 'Name', countryCode: 'JP', preferredLocale: 'fr',
  });
  const headers = { Cookie: member, Origin: origin };
  const forbidden = await request('/account/profile/', { method: 'POST', body: profile });
  assert.equal(forbidden.status, 403);
  const edited = await request('/account/profile/', { method: 'POST', headers, body: profile });
  assert.equal(edited.headers.get('location'), '/fr/account/');
  const page = await request('/fr/account/', { headers });
  const body = await page.text();
  assert.match(body, /&lt;Edited&gt;/);
  assert.doesNotMatch(body, /name="email"/);
  assert.equal([...sessions.values()][0].preferredLocale, 'fr');
  const invalid = await request('/account/profile/', {
    method: 'POST', headers, body: new URLSearchParams({ ...Object.fromEntries(profile), countryCode: 'ZZ' }),
  });
  assert.match(invalid.headers.get('location'), /invalid_profile/);
});

test('email signup permits browsing while a link is pending and requires explicit same-origin confirmation', async () => {
  const flowToken = randomBytes(32).toString('base64url');
  const selector = randomBytes(32).toString('base64url');
  const verificationToken = randomBytes(32).toString('base64url');
  const password = 'Unique account passphrase 527!';
  let requested;
  const verified = [];
  const { request } = fixture({
    async requestLink(input) { requested = input; return flowToken; },
    async verifyLink(input) { verified.push(input); return input.verificationToken === verificationToken && input.password === password ? { verified: true, purpose: 'signup' } : false; },
  });
  const headers = { Origin: origin };
  const signUp = await request('/account/sign-up/');
  assert.match(await signUp.text(), /name="email".*required/);
  const send = await request('/account/email/sign-up/', {
    method: 'POST', headers, body: new URLSearchParams({
      email: 'test@EXAMPLE.invalid', nickname: 'NewMember', password,
      givenName: 'Test', familyName: 'Member', countryCode: 'JP', preferredLocale: 'fr',
    }),
  });
  assert.equal(requested.email, 'test@example.invalid');
  assert.equal(requested.profile.preferredLocale, 'fr');
  assert.equal(send.status, 303);
  assert.equal(send.headers.get('location'), '/account/email/pending/');
  assert.match(cookie(send, 'email-flow'), /HttpOnly; SameSite=Lax; Secure/);
  assert.equal(cookie(send, 'session'), undefined);
  const pending = await request('/account/email/pending/');
  assert.match(await pending.text(), /Continue browsing/);
  assert.equal(await (await request('/about/')).text(), 'Public page');

  // Security scanners and another browser can open the link, but GET never consumes it.
  const link = '/account/email/confirm/#' + new URLSearchParams({ selector, token: verificationToken, purpose: 'signup' });
  const landing = await request(link);
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get('referrer-policy'), 'same-origin');
  assert.equal(landing.headers.get('cache-control'), 'private, no-store');
  const landingBody = await landing.text();
  assert.doesNotMatch(landingBody, /name="code"/);
  assert.doesNotMatch(landingBody, /googletagmanager|analytics\.js|data-pixkit-analytics/);
  assert.match(landingBody, /name="password"/);
  assert.equal(verified.length, 0);
  const confirmationToken = cookie(landing, 'email-confirmation').split(';')[0].split('=')[1];
  const fields = { selector, verificationToken, confirmationToken, password };
  const csrfCookie = cookie(landing, 'email-confirmation').split(';')[0];
  assert.equal((await request('/account/email/confirm/', { method: 'POST', headers,
    body: new URLSearchParams(fields) })).status, 200);
  assert.equal(verified.length, 0, 'Confirmation cannot bypass the browser CSRF cookie');
  const crossOrigin = await request('/account/email/confirm/', { method: 'POST',
    headers: { Origin: 'https://other.example', Cookie: csrfCookie }, body: new URLSearchParams(fields) });
  assert.equal(crossOrigin.status, 403);
  assert.equal(verified.length, 0);
  const wrong = await request('/account/email/confirm/', { method: 'POST',
    headers: { ...headers, Cookie: csrfCookie },
    body: new URLSearchParams({ ...fields, verificationToken: randomBytes(32).toString('base64url') }) });
  assert.equal(cookie(wrong, 'session'), undefined);
  const accepted = await request('/account/email/confirm/', { method: 'POST',
    headers: { ...headers, Cookie: csrfCookie }, body: new URLSearchParams(fields) });
  assert.equal(accepted.status, 303);
  assert.equal(verified.at(-1).password, password);
  assert.equal(verified.at(-1).verificationToken, verificationToken);
  assert.match(cookie(accepted, 'session'), /HttpOnly; SameSite=Lax; Secure/);
  assert.match(cookie(accepted, 'email-flow'), /Max-Age=0/);
  assert.match(cookie(accepted, 'email-confirmation'), /Max-Age=0/);
  const retired = await request('/account/email/verify/', { method: 'POST', headers,
    body: new URLSearchParams({ email: requested.email, code: '123456' }) });
  assert.equal(retired.status, 303);
  assert.equal(cookie(retired, 'session'), undefined);
});


test('public profiles expose only projected fields, and account forms reject untrusted origins', async () => {
  const { request } = fixture();
  const page = await request('/members/PublicMember/');
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /PublicMember/);
  assert.match(body, /Japan/);
  assert.doesNotMatch(body, /member@example.invalid/);
  assert.equal((await request('/members/MissingMember/')).status, 404);
  assert.equal((await request('/members/PublicMember/', { method: 'POST' })).status, 405);
  for (const action of ['/account/email/sign-in/', '/account/email/sign-up/', '/account/password/reset/']) {
    const response = await request(action, {
      method: 'POST', headers: { Origin: 'https://other.example' },
      body: new URLSearchParams({ email: 'member@example.invalid', password: 'private' }),
    });
    assert.equal(response.status, 403);
  }
});

test('email password login issues opaque sessions only for accepted credentials', async () => {
  let input;
  const { request } = fixture({
    async signIn(data) { input = data; return data.password === 'Verified email passphrase'; },
  });
  const headers = { Origin: origin };
  const rejected = await request('/account/email/sign-in/', {
    method: 'POST', headers, body: new URLSearchParams({ email: identity.email, password: 'incorrect' }),
  });
  assert.match(rejected.headers.get('location'), /authentication_failed/);
  assert.equal(cookie(rejected, 'session'), undefined);
  const accepted = await request('/account/email/sign-in/', {
    method: 'POST', headers, body: new URLSearchParams({ email: identity.email, password: 'Verified email passphrase' }),
  });
  assert.equal(accepted.status, 303);
  assert.match(cookie(accepted, 'session'), /HttpOnly; SameSite=Lax; Secure/);
  assert.equal(input.email, identity.email);
  assert.match(input.sessionTokenHash, /^[a-f0-9]{64}$/);
});

test('signup suggests available nicknames without sending a link on conflict', async () => {
  let sends = 0;
  const { request } = fixture({ async requestLink() { sends++; } });
  const signup = await request('/account/email/sign-up/', {
    method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({
      email: identity.email, nickname: 'ExistingMember', password: 'Unique account passphrase 527!',
      givenName: 'Example', familyName: 'Member', countryCode: 'JP', preferredLocale: 'en',
    }),
  });
  assert.equal(signup.status, 200);
  assert.match(await signup.text(), /ExistingMember1/);
  assert.equal(sends, 0);
});

test('password reset requests collect only email and defer the new password until link confirmation', async () => {
  let input;
  const flowToken = randomBytes(32).toString('base64url');
  const { request } = fixture({ async requestPasswordReset(data) { input = data; return flowToken; } });
  const password = 'Private recovery passphrase 527!';
  const response = await request('/account/password/reset/', {
    method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ email: identity.email, password }),
  });
  assert.equal(input.password, undefined);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/account/email/pending/?purpose=reset');
  assert.match(cookie(response, 'email-flow'), /HttpOnly; SameSite=Lax; Secure/);
  assert.doesNotMatch(await response.text(), /Private recovery passphrase/);
  assert.equal(cookie(response, 'session'), undefined);
});

test('oversized form bodies are rejected before the account service is called', async () => {
  let calls = 0;
  const { request } = fixture({ async signIn() { calls++; return true; } });
  const response = await request('/account/email/sign-in/', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=' + 'a'.repeat(10000),
  });
  assert.equal(response.status, 303);
  assert.equal(calls, 0);
});

test('client identity for throttling is accepted only from the configured private gateway', async () => {
  for (const [trustedProxy, sourceHeader, expected] of [
    [false, '198.51.100.10', undefined],
    [true, '198.51.100.10', '198.51.100.10'],
    [true, 'not-an-address', undefined],
  ]) {
    let seen;
    const { request } = fixture({ async signIn(input) { seen = input.source; return false; } }, trustedProxy);
    await request('/account/email/sign-in/', {
      method: 'POST',
      headers: { Origin: origin, 'X-PixKit-Client-IP': sourceHeader },
      body: new URLSearchParams({ email: identity.email, password: 'private passphrase' }),
    });
    assert.equal(seen, expected);
  }
});
