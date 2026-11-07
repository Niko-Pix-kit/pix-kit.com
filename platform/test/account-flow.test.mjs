import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEmailAuth } from '../server/email-auth.mjs';
import { createLocalAccounts } from '../server/local-accounts.mjs';
import { createMariaStore } from '../server/mariadb.mjs';

const database = process.env.PIXKIT_TEST_FLOW_DB_NAME;
test('account routes persist verified credentials, profile privacy and recovery across sessions', {
  skip: !(database && process.env.PIXKIT_TEST_DB_PORT) && 'Set an isolated PIXKIT_TEST_FLOW_DB_NAME',
  timeout: 60_000,
}, async () => {
  const { createPool } = await import('mariadb');
  const pool = createPool({
    host: '127.0.0.1', port: Number(process.env.PIXKIT_TEST_DB_PORT), database,
    user: process.env.PIXKIT_TEST_DB_USER, password: process.env.PIXKIT_TEST_DB_PASSWORD,
    connectionLimit: 4,
  });
  const origin = 'https://fixture.example';
  const email = `flow-${randomUUID()}@example.test`;
  const password = 'Quiet blue lanterns above the ocean';
  const replacement = 'Three orange robots beside the river';
  const sent = [];
  let now = Date.now();
  const emailAuth = createEmailAuth({
    pool, origin, secret: randomBytes(32).toString('hex'), languages: ['en', 'fr'], now: () => now,
    sendCode: async message => sent.push(message),
  });
  const handle = createLocalAccounts({
    origin, store: createMariaStore({ pool }), google: {}, emailAuth, languages: ['en', 'fr'],
    now: () => now, publicHandler: async () => new Response('Public'),
  });
  const get = (path, cookie) => handle(new Request(origin + path, { headers: cookie ? { Cookie: cookie } : {} }));
  const post = (path, fields, cookie) => handle(new Request(origin + path, {
    method: 'POST', headers: { Origin: origin, ...(cookie && { Cookie: cookie }) },
    body: new URLSearchParams(fields),
  }));
  const cookie = (response, name) => response.headers.getSetCookie()
    .find(value => value.startsWith('__Host-pixkit-' + name + '='))?.split(';')[0];

  try {
    for (const file of ['001_accounts.sql', '002_profiles.sql', '003_email_auth.sql', '004_password_auth.sql', '005_profiles.sql', '006_email_links.sql']) {
      const sql = await readFile(new URL(`../mariadb/${file}`, import.meta.url), 'utf8');
      for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await pool.query(statement);
    }
    const signup = await post('/account/email/sign-up/', {
      email, password, nickname: 'RouteMember', givenName: 'PrivateFirst',
      familyName: 'PrivateLast', countryCode: 'JP', preferredLocale: 'en',
    });
    assert.equal(signup.status, 303);
    assert.equal(signup.headers.get('location'), '/account/email/pending/');
    assert.equal(sent.length, 1);
    assert.equal(cookie(signup, 'session'), undefined);
    const confirm = async (message, value) => {
      const link = new URL(message.verificationUrl);
      assert.equal(link.search, '');
      const fragment = new URLSearchParams(link.hash.slice(1));
      const scanner = await get(link.pathname);
      assert.equal(cookie(scanner, 'session'), undefined);
      assert.equal(scanner.headers.get('referrer-policy'), 'same-origin');
      const landing = await get(link.pathname);
      const csrfCookie = cookie(landing, 'email-confirmation');
      const fields = { selector: fragment.get('selector'), verificationToken: fragment.get('token'),
        confirmationToken: csrfCookie.split('=')[1], password: value };
      return post(link.pathname, fields, csrfCookie);
    };
    const wrong = await confirm(sent[0], 'A different secure signup password');
    assert.equal(cookie(wrong, 'session'), undefined);
    const verified = await confirm(sent[0], password);
    assert.equal(verified.status, 303);
    const session = cookie(verified, 'session');
    const replay = await confirm(sent[0], password);
    assert.equal(cookie(replay, 'session'), undefined);
    const account = await get('/account/', session);
    assert.match(await account.text(), /RouteMember/);

    const edited = await post('/account/profile/', {
      nickname: 'RouteMember', givenName: 'PrivateFirst', familyName: 'PrivateLast',
      countryCode: 'JP', preferredLocale: 'en', avatarPreset: 'robot', publicCountry: 'yes',
    }, session);
    assert.equal(edited.status, 303);
    const publicPage = await get('/members/RouteMember/');
    const publicBody = await publicPage.text();
    assert.equal(publicPage.status, 200);
    assert.match(publicBody, /Japan/);
    assert.match(publicBody, /\/assets\/avatars\/robot.svg/);
    for (const privateValue of [email, 'PrivateFirst', 'PrivateLast']) assert.ok(!publicBody.includes(privateValue));

    assert.equal((await post('/account/logout/', {}, session)).status, 303);
    assert.match(await (await get('/account/', session)).text(), /<h1>Sign in<\/h1>/);
    const login = await post('/account/email/sign-in/', { email, password });
    assert.equal(login.status, 303);
    const loggedIn = cookie(login, 'session');
    assert.match(await (await get('/account/', loggedIn)).text(), /RouteMember/);

    now += 61_000;
    const reset = await post('/account/password/reset/', { email });
    assert.equal(reset.status, 303);
    const recovered = await confirm(sent.at(-1), replacement);
    assert.equal(recovered.status, 303);
    assert.equal(recovered.headers.get('location'), '/account/?reset=complete');
    assert.equal(cookie(recovered, 'session'), '__Host-pixkit-session=');
    assert.match(await (await get('/account/?reset=complete')).text(), /password.*updated|Password.*updated/);
    assert.match(await (await get('/account/', loggedIn)).text(), /<h1>Sign in<\/h1>/);
    const rejected = await post('/account/email/sign-in/', { email, password });
    assert.match(rejected.headers.get('location'), /authentication_failed/);
    const accepted = await post('/account/email/sign-in/', { email, password: replacement });
    assert.equal(accepted.status, 303);
    assert.ok(cookie(accepted, 'session'));
  } finally {
    await pool.end();
  }
});
