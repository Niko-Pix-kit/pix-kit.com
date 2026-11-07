import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEmailAuth, EMAIL_FLOW_SECONDS, normalizeEmail, normalizeSignupProfile, validNewPassword } from '../server/email-auth.mjs';
import { hashPassword, verifyPassword } from '../server/passwords.mjs';

const languages = new Set(['en', 'fr', 'ja']);
const profile = { nickname: 'Aiko_Example', givenName: 'Aïko', familyName: 'Example', countryCode: 'JP', preferredLocale: 'ja' };
const password = 'A private meadow above the blue sea';
const replacementPassword = 'Orange lanterns beside a quiet river';

test('signup validation accepts supported values and rejects mailbox/header injection and weak passwords', () => {
  assert.equal(normalizeEmail('  Name.Tag+Pix@EXAMPLE.Test  '), 'Name.Tag+Pix@example.test');
  for (const address of ['person', 'person@example', 'two..dots@example.test', 'person@example.test\r\nBcc: someone@example.test']) {
    assert.equal(normalizeEmail(address), '');
  }
  assert.deepEqual(normalizeSignupProfile({ ...profile, countryCode: ' jp ' }, languages), profile);
  for (const values of [{ nickname: 'a b' }, { countryCode: 'XX' }, { preferredLocale: 'xx' }, { givenName: 'A\nB' }]) {
    assert.equal(normalizeSignupProfile({ ...profile, ...values }, languages), null);
  }
  for (const value of [undefined, 'short', 'passwordpassword', 'x'.repeat(129), 'long password\nwith control']) {
    assert.equal(validNewPassword(value), false);
  }
  assert.equal(validNewPassword(password), true);
  assert.equal(validNewPassword('ひらがなのながいあいことばをつかいます'), true);
});

test('passwords use salted, bounded scrypt and constant-time comparison with Unicode normalization', async () => {
  const value = 'A long cafe\u0301 password with spaces';
  const first = await hashPassword(value);
  const second = await hashPassword(value);
  assert.match(first, /^scrypt\$32768\$8\$3\$[a-f\d]{32}\$[a-f\d]{64}$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(value.normalize('NFC'), first), true);
  assert.equal(await verifyPassword(replacementPassword, first), false);
  assert.equal(await verifyPassword(value, null), false);
  assert.equal(await verifyPassword(value, first.replace('32768', '1073741824')), false);
  assert.equal(await verifyPassword('x'.repeat(513), first), false);
  await assert.rejects(hashPassword('short'), /Invalid new password/);
});

test('verification link construction requires the exact canonical HTTPS origin', () => {
  const options = { pool: {}, sendCode: async () => {}, secret: randomBytes(32).toString('hex'), languages };
  for (const origin of ['http://fixture.example', 'https://fixture.example/path', 'https://fixture.example/',
    'https://name:password@fixture.example', 'https://fixture.example?redirect=other']) {
    assert.throws(() => createEmailAuth({ ...options, origin }));
  }
  assert.ok(createEmailAuth({ ...options, origin: 'https://fixture.example' }));
});

const port = process.env.PIXKIT_TEST_DB_PORT;
const database = process.env.PIXKIT_TEST_EMAIL_DB_NAME;

test('MariaDB links are single-use, private, password-confirmed, time-bounded and race-safe', {
  skip: !(port && database) && 'Set PIXKIT_TEST_DB_PORT and PIXKIT_TEST_EMAIL_DB_NAME for an isolated MariaDB database',
  timeout: 60_000,
}, async () => {
  const { PIXKIT_TEST_DB_USER: user, PIXKIT_TEST_DB_PASSWORD: dbPassword } = process.env;
  assert.ok(user && dbPassword, 'Set MariaDB test credentials');
  const { createPool } = await import('mariadb');
  const pool = createPool({ host: '127.0.0.1', port: Number(port), user, password: dbPassword, database, connectionLimit: 6 });
  const email = `member-${randomUUID()}@example.test`;
  const unknown = `unknown-${randomUUID()}@example.test`;
  const deliveries = [];
  let now = Date.now();
  let deliveryFails = false;
  const secret = randomBytes(32).toString('hex');
  const limitKey = (purpose, value) => createHmac('sha256', Buffer.from(secret, 'hex')).update(`${purpose}\0${value}`).digest();
  const auth = createEmailAuth({ pool, origin: 'https://fixture.example', languages, now: () => now, secret,
    sendCode: async message => { if (deliveryFails) throw new Error('Private transport error'); deliveries.push(message); } });
  const linkFields = (message = deliveries.at(-1)) => {
    const url = new URL(message.verificationUrl);
    assert.equal(url.origin, 'https://fixture.example');
    assert.equal(url.search, '', 'The secret is never included in an access-log query');
    assert.ok(!url.href.includes(message.email));
    const fields = new URLSearchParams(url.hash.slice(1));
    assert.match(fields.get('selector'), /^[A-Za-z0-9_-]{43}$/);
    assert.match(fields.get('token'), /^[A-Za-z0-9_-]{43}$/);
    return { selector: fields.get('selector'), verificationToken: fields.get('token') };
  };
  const verify = async (fields, value = password, sessionTokenHash = randomBytes(32)) => {
    const result = await auth.verifyLink({
      ...fields, password: value, sessionTokenHash, expiresAt: new Date(now + 3_600_000),
    });
    return result?.verified ? result.purpose : false;
  };
  const login = (address, value, sessionTokenHash = randomBytes(32), replaceSessionHash, source) => auth.signIn({
    email: address, password: value, sessionTokenHash, replaceSessionHash, source, expiresAt: new Date(now + 3_600_000),
  });
  const signup = (address, nickname = profile.nickname) => auth.requestLink({ email: address, profile: { ...profile, nickname }, password });

  try {
    const migrateLinks = async () => {
      const sql = await readFile(new URL('../mariadb/006_email_links.sql', import.meta.url), 'utf8');
      for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await pool.query(statement);
    };
    for (const file of ['001_accounts.sql', '002_profiles.sql', '003_email_auth.sql', '004_password_auth.sql', '005_profiles.sql', '006_email_links.sql']) {
      const migration = await readFile(new URL(`../mariadb/${file}`, import.meta.url), 'utf8');
      for (const statement of migration.split(';').map(part => part.trim()).filter(Boolean)) await pool.query(statement);
    }
    const legacyKey = randomBytes(32);
    await pool.query(`
      INSERT INTO pixkit_email_challenges
        (email_key, flow_hash, code_hash, attempts_left, issued_at, expires_at, window_start, issued_count)
      VALUES (?, ?, ?, 5, ?, ?, ?, 1)
    `, [legacyKey, randomBytes(32), randomBytes(32), now, now + 600_000, now]);
    await migrateLinks();
    const [retired] = await pool.query('SELECT flow_hash, code_hash, attempts_left FROM pixkit_email_challenges WHERE email_key = ?', [legacyKey]);
    assert.equal(retired.flow_hash, null);
    assert.equal(retired.code_hash, null);
    assert.equal(Number(retired.attempts_left), 0, 'Migration retires the old six-digit code flow');
    const googleId = randomUUID();
    await pool.query(`
      INSERT INTO pixkit_users (id, google_subject, email, display_name, is_admin, created_at, last_sign_in_at)
      VALUES (?, ?, ?, 'Existing Google account', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    `, [googleId, Buffer.from(randomUUID()), email]);
    const flows = await Promise.all([signup(email), signup(email)]);
    assert.equal(flows.filter(Boolean).length, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].locale, 'ja');
    const firstLink = linkFields();
    await migrateLinks();
    const [pending] = await pool.query('SELECT password_hash, signup_profile, flow_hash, code_hash, verification_hash FROM pixkit_email_challenges WHERE email_key = ?', [limitKey('email', email)]);
    assert.match(pending.password_hash, /^scrypt\$/);
    assert.equal(pending.code_hash, null);
    assert.ok(Buffer.isBuffer(pending.verification_hash));
    assert.ok(!JSON.stringify(pending).includes(firstLink.verificationToken));
    assert.ok(!JSON.stringify(pending).includes(password));
    assert.equal(await login(email, password), false, 'An email link must be verified before sign-in');
    assert.equal(await verify({ ...firstLink, verificationToken: randomBytes(32).toString('base64url') }), false);
    assert.equal(await verify(firstLink, replacementPassword), false,
      'A click cannot activate a password chosen by someone else during preregistration');
    const sessionOne = randomBytes(32);
    const sessionTwo = randomBytes(32);
    const outcomes = await Promise.all([verify(firstLink, password, sessionOne), verify(firstLink, password, sessionTwo)]);
    assert.equal(outcomes.filter(Boolean).length, 1);
    const firstSession = outcomes[0] ? sessionOne : sessionTwo;
    const [account] = await pool.query(`
      SELECT u.id, u.nickname, u.given_name, u.family_name, u.country_code, u.preferred_locale, u.google_subject, u.is_admin
      FROM pixkit_sessions s JOIN pixkit_users u ON u.id = s.user_id WHERE s.token_hash = ?
    `, [firstSession]);
    assert.equal(account.nickname, profile.nickname);
    assert.equal(account.given_name, profile.givenName);
    assert.equal(account.google_subject, null);
    assert.equal(Number(account.is_admin), 0);
    assert.notEqual(account.id, googleId, 'Email confirmation cannot adopt a Google account or its role');
    assert.equal(await verify(firstLink), false, 'Confirmation link replay must fail');
    assert.equal(await login(email, 'wrong password'), false);
    assert.equal(await login(unknown, password), false);
    const passwordSession = randomBytes(32);
    assert.equal(await login(email, password, passwordSession, firstSession), true);
    assert.equal((await pool.query('SELECT user_id FROM pixkit_sessions WHERE token_hash = ?', [firstSession])).length, 0);

    now += 61_000;
    const collisionEmail = `collision-${randomUUID()}@example.test`;
    await signup(collisionEmail);
    const collisionLink = linkFields();
    assert.equal(await verify(collisionLink), false, 'A unique nickname prevents concurrent adoption');
    await pool.query('UPDATE pixkit_users SET nickname = ? WHERE id = ?', ['UpdatedNickname', account.id]);
    assert.equal(await verify(collisionLink), 'signup', 'A nickname conflict rolls back without consuming the link');

    const sentBefore = deliveries.length;
    const fakeReset = await auth.requestPasswordReset({ email: unknown, locale: 'fr' });
    assert.match(fakeReset, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(deliveries.length, sentBefore, 'Unknown recovery never sends mail');
    now += 61_000;
    await auth.requestPasswordReset({ email, locale: 'fr', password: 'Ignored attacker-selected value' });
    assert.equal(deliveries.at(-1).purpose, 'reset');
    const resetLink = linkFields();
    const [recovery] = await pool.query('SELECT password_hash FROM pixkit_email_challenges WHERE email_key = ?',
      [limitKey('email', email)]);
    assert.equal(recovery.password_hash, null, 'Recovery does not preselect a new password');
    assert.equal(await verify(resetLink, 'short'), false);
    assert.equal(await verify(resetLink, replacementPassword), 'reset');
    assert.equal((await pool.query('SELECT user_id FROM pixkit_sessions WHERE user_id = ?', [account.id])).length, 0,
      'A reset link never authenticates the browser into the link owner account');
    assert.equal((await pool.query('SELECT user_id FROM pixkit_sessions WHERE token_hash = ?', [passwordSession])).length, 0);
    assert.equal(await login(email, password), false);
    assert.equal(await login(email, replacementPassword), true);
    assert.equal(await verify(resetLink, replacementPassword), false);

    now += 61_000;
    const legacyEmail = `legacy-${randomUUID()}@example.test`;
    const legacyId = randomUUID();
    await pool.query(`
      INSERT INTO pixkit_users (id, email, display_name, created_at, last_sign_in_at)
      VALUES (?, ?, 'Legacy email member', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    `, [legacyId, legacyEmail]);
    await pool.query('INSERT INTO pixkit_email_identities (email, user_id) VALUES (?, ?)', [Buffer.from(legacyEmail), legacyId]);
    assert.equal(await login(legacyEmail, password), false);
    await auth.requestPasswordReset({ email: legacyEmail, locale: 'fr' });
    assert.equal(await verify(linkFields()), 'reset');
    assert.equal(await login(legacyEmail, password), true);
    const [legacy] = await pool.query('SELECT user_id, verified_at FROM pixkit_email_identities WHERE email = ?', [Buffer.from(legacyEmail)]);
    assert.equal(legacy.user_id, legacyId);
    assert.ok(legacy.verified_at);

    now += 61_000;
    deliveryFails = true;
    await assert.rejects(signup(`failed-${randomUUID()}@example.test`, 'FailedDelivery'), /could not be submitted/);
    deliveryFails = false;
    const [failed] = await pool.query('SELECT password_hash, email_address, verification_hash FROM pixkit_email_challenges WHERE flow_hash IS NULL AND issued_at = ? LIMIT 1', [now]);
    assert.equal(failed.password_hash, null);
    assert.equal(failed.email_address, null);
    assert.equal(failed.verification_hash, null);

    now += 3_600_001;
    const expiringEmail = `expiring-${randomUUID()}@example.test`;
    await signup(expiringEmail, 'ExpiryMember');
    const expired = linkFields();
    now += EMAIL_FLOW_SECONDS * 1000 + 1;
    assert.equal(await verify(expired), false);
    await signup(expiringEmail, 'ExpiryMember');
    const current = linkFields();
    assert.equal(await verify(expired), false, 'Issuing another link invalidates the previous token');
    for (let attempt = 0; attempt < 5; attempt++) assert.equal(await verify(current, replacementPassword), false);
    assert.equal(await verify(current), false, 'Wrong confirmation password attempts are bounded');
    for (let issue = 0; issue < 3; issue++) {
      now += 61_000;
      assert.match(await signup(expiringEmail, 'ExpiryMember'), /^[A-Za-z0-9_-]{43}$/);
    }
    now += 61_000;
    assert.equal(await signup(expiringEmail, 'ExpiryMember'), null, 'Mailbox hourly sends are bounded');

    const mailboxKey = limitKey('password-mailbox', email);
    await pool.query(`
      INSERT INTO pixkit_password_limits (subject_key, window_start, attempts) VALUES (?, ?, 19)
      ON DUPLICATE KEY UPDATE window_start = VALUES(window_start), attempts = VALUES(attempts)
    `, [mailboxKey, now]);
    assert.equal(await login(email, replacementPassword), true, 'A valid password succeeds on the final mailbox attempt');
    assert.equal((await pool.query('SELECT attempts FROM pixkit_password_limits WHERE subject_key = ?', [mailboxKey])).length, 0);
    await pool.query('INSERT INTO pixkit_password_limits (subject_key, window_start, attempts) VALUES (?, ?, 20)', [mailboxKey, now]);
    assert.equal(await login(email, replacementPassword), false);
    assert.equal(await login(legacyEmail, password), true);
    now += 15 * 60_000 + 1;
    assert.equal(await login(email, replacementPassword), true);
    const blockedSource = '203.0.113.5';
    await pool.query('INSERT INTO pixkit_password_limits (subject_key, window_start, attempts) VALUES (?, ?, 60)',
      [limitKey('password-source', blockedSource), now]);
    assert.equal(await login(email, replacementPassword, randomBytes(32), undefined, blockedSource), false);
    assert.equal(await login(email, replacementPassword, randomBytes(32), undefined, '203.0.113.6'), true);

    now += 3_600_001;
    const mixedAddress = `Member-${randomUUID()}@example.test`;
    const lowerAddress = mixedAddress.toLowerCase();
    await signup(mixedAddress, 'CaseUpperMember');
    const upperLink = linkFields();
    const beforeCaseVariant = deliveries.length;
    assert.equal(await signup(lowerAddress, 'CaseLowerMember'), null);
    assert.equal(deliveries.length, beforeCaseVariant);
    assert.equal(await verify(upperLink), 'signup');
    now += 61_000;
    await signup(lowerAddress, 'CaseLowerMember');
    assert.equal(await verify(linkFields()), 'signup');
    const caseIdentities = await pool.query('SELECT email, user_id FROM pixkit_email_identities WHERE email IN (?, ?)',
      [Buffer.from(mixedAddress), Buffer.from(lowerAddress)]);
    assert.equal(caseIdentities.length, 2);
    assert.notEqual(caseIdentities[0].user_id, caseIdentities[1].user_id);
    await pool.query('UPDATE pixkit_email_delivery_limits SET issued_count = 5, window_start = ? WHERE subject_key = ?',
      [now, limitKey('mail-delivery', lowerAddress)]);
    now += 61_000;
    assert.equal(await signup(mixedAddress, 'UnusedCaseMember'), null);
    const sourceAddress = `source-${randomUUID()}@example.test`;
    await pool.query(`
      INSERT INTO pixkit_email_delivery_limits (subject_key, window_start, issued_count, issued_at) VALUES (?, ?, 20, ?)
    `, [limitKey('mail-source', blockedSource), now, now]);
    assert.equal(await auth.requestLink({ email: sourceAddress, password, profile: { ...profile, nickname: 'SourceBlocked' },
      source: blockedSource }), null);
    assert.match(await auth.requestLink({ email: sourceAddress, password, profile: { ...profile, nickname: 'SourceAllowed' },
      source: '203.0.113.6' }), /^[A-Za-z0-9_-]{43}$/);
    await pool.query('UPDATE pixkit_email_send_limit SET issued_count = 120, window_start = ? WHERE scope_id = 1', [now]);
    const finalSent = deliveries.length;
    assert.equal(await signup(`other-${randomUUID()}@example.test`, 'GlobalBlocked'), null);
    assert.equal(deliveries.length, finalSent);
  } finally {
    await pool.end();
  }
});
