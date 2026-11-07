import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createMariaStore } from '../server/mariadb.mjs';

test('invalid identity, hashes and pagination fail before touching MariaDB', async () => {
  let queries = 0;
  const pool = {
    getConnection() { queries += 1; },
    query() { queries += 1; },
  };
  const store = createMariaStore({ pool });
  const hash = randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + 60_000);
  await assert.rejects(store.signIn({ subject: 'subject ', email: 'member@example.test' }, hash, expiry), /identity/);
  await assert.rejects(store.signIn({ subject: 'subject', email: 'invalid' }, hash, expiry), /identity/);
  await assert.rejects(
    store.signIn({ subject: 'subject', email: 'member@example.test' }, hash, expiry, { replaceSessionHash: hash }),
    /replacement/,
  );
  await assert.rejects(store.session('raw-token'), /token hash/);
  await assert.rejects(store.revokeSession(Buffer.alloc(31)), /token hash/);
  await assert.rejects(store.deleteAccount(''), /token hash/);
  await assert.rejects(store.listUsers({ limit: 101 }), /account page/);
  assert.equal(queries, 0);
});

test('a failed session insert rolls back the signup and sanitizes connector errors', async () => {
  const events = [];
  const id = randomUUID();
  const email = 'member@example.test';
  const token = randomBytes(32);
  const connection = {
    async beginTransaction() { events.push('begin'); },
    async query(sql) {
      if (sql.includes('INSERT INTO pixkit_users')) {
        events.push('write identity');
      } else if (sql.includes('SELECT')) {
        events.push('read identity');
        return [{
          id,
          email,
          display_name: 'Member',
          avatar_url: null,
          is_admin: 0,
          created_at: '2026-01-01T08:00:00.000000Z',
          last_sign_in_at: '2026-01-01T08:00:00.000000Z',
        }];
      } else if (sql.includes('INSERT INTO pixkit_sessions')) {
        events.push('write session');
        throw Object.assign(new Error(`Bound values: ${email}, ${token.toString('hex')}`), { code: 'ER_DUP_ENTRY' });
      } else {
        events.push('unexpected query');
      }
    },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    async release() { events.push('release'); },
  };
  const store = createMariaStore({ pool: { getConnection: async () => connection } });
  await assert.rejects(
    store.signIn({ subject: 'fixture', email }, token, new Date(Date.now() + 60_000),
      { replaceSessionHash: randomBytes(32) }),
    (error) => error.message === 'MariaDB operation failed' && error.code === 'ER_DUP_ENTRY' && !error.cause,
  );
  assert.deepEqual(events, ['begin', 'write identity', 'read identity', 'write session', 'rollback', 'release']);
});

test('sign-in retries transient lock failures with fresh transactions', async () => {
  let started = 0;
  let rolledBack = 0;
  let released = 0;
  const store = createMariaStore({ pool: {
    async getConnection() {
      return {
        async beginTransaction() { started += 1; },
        async query() { throw Object.assign(new Error('lock conflict'), { code: 'ER_LOCK_DEADLOCK' }); },
        async rollback() { rolledBack += 1; },
        async release() { released += 1; },
      };
    },
  } });
  await assert.rejects(
    store.signIn({ subject: 'fixture', email: 'member@example.test' }, randomBytes(32), new Date(Date.now() + 60_000)),
    { code: 'ER_LOCK_DEADLOCK' },
  );
  assert.deepEqual([started, rolledBack, released], [3, 3, 3]);
});

const port = process.env.PIXKIT_TEST_DB_PORT;

test('MariaDB applies the production schema and isolates concurrent sign-ins and sessions', {
  skip: !port && 'Set PIXKIT_TEST_DB_PORT for an isolated MariaDB database',
  timeout: 30_000,
}, async () => {
  const { PIXKIT_TEST_DB_USER: user, PIXKIT_TEST_DB_PASSWORD: password, PIXKIT_TEST_DB_NAME: database } = process.env;
  assert.ok(user && password && database, 'Set all PIXKIT_TEST_DB connection variables');
  assert.match(port, /^\d{1,5}$/);
  assert.ok(Number(port) > 0 && Number(port) < 65536);
  const { createPool } = await import('mariadb');
  const pool = createPool({ host: '127.0.0.1', port: Number(port), user, password, database, connectionLimit: 8 });
  const store = createMariaStore({ pool });
  const namespace = randomUUID();
  const identity = {
    subject: `User-${namespace}`,
    email: 'same-address@example.test',
    displayName: "Name with 'quotes'",
    avatarUrl: 'https://lh3.googleusercontent.com/fixture',
    isAdmin: true,
  };
  const separate = { ...identity, subject: `user-${namespace}` };
  const sessionHash = () => randomBytes(32);
  const expiry = () => new Date(Date.now() + 60 * 60_000);
  let schemaReady = false;

  try {
    for (const file of ['001_accounts.sql', '002_profiles.sql', '005_profiles.sql']) {
      const migration = await readFile(new URL(`../mariadb/${file}`, import.meta.url), 'utf8');
      for (const statement of migration.split(';').map((part) => part.trim()).filter(Boolean)) {
        await pool.query(statement);
      }
    }
    schemaReady = true;
    assert.deepEqual(await store.listUsers(), { total: 0, users: [] }, 'Use an empty test database');

    const concurrentHashes = Array.from({ length: 8 }, sessionHash);
    const firstSignIns = await Promise.all(concurrentHashes.map((hash) => store.signIn(identity, hash, expiry())));
    const alice = firstSignIns[0];
    assert.equal(new Set(firstSignIns.map(({ id }) => id)).size, 1);
    assert.equal(new Set(firstSignIns.map(({ createdAt }) => createdAt)).size, 1);
    assert.match(alice.id, /^[a-f0-9]{8}-[a-f0-9-]{27}$/);
    assert.equal(alice.displayName, identity.displayName);
    assert.equal(alice.avatarUrl, identity.avatarUrl);
    assert.equal(alice.isAdmin, false);
    assert.equal(Object.hasOwn(alice, 'googleSubject'), false);
    assert.equal((await store.session(concurrentHashes[0].toString('hex'))).id, alice.id);
    assert.equal(await store.session(sessionHash()), null);

    const separateHash = sessionHash();
    const bob = await store.signIn(separate, separateHash, expiry());
    assert.notEqual(bob.id, alice.id);
    assert.equal(bob.email, alice.email);
    await assert.rejects(store.signIn({ ...identity, displayName: 'Must roll back' }, separateHash, expiry(),
      { replaceSessionHash: concurrentHashes[0] }), { code: 'ER_DUP_ENTRY' });
    assert.equal((await store.session(concurrentHashes[0])).displayName, identity.displayName);

    await pool.query('UPDATE pixkit_users SET is_admin = TRUE WHERE id = ?', [alice.id]);
    assert.equal((await store.session(concurrentHashes[0])).isAdmin, true);
    assert.equal((await store.session(separateHash)).isAdmin, false);
    await store.updateProfile(concurrentHashes[0], {
      givenName: 'Edited', familyName: 'Member', countryCode: 'JP', preferredLocale: 'fr',
    });
    const replacement = sessionHash();
    const current = await store.signIn({ ...identity, email: 'new-address@example.test', avatarUrl: 'javascript:alert(1)' },
      replacement, expiry(), { replaceSessionHash: concurrentHashes[0] });
    assert.equal(current.id, alice.id);
    assert.equal(current.displayName, 'Edited Member');
    assert.equal(current.preferredLocale, 'fr');
    assert.equal(current.createdAt, alice.createdAt);
    assert.equal(current.email, 'new-address@example.test');
    assert.equal(current.avatarUrl, null);
    assert.equal(current.isAdmin, true);
    assert.ok(current.lastSignInAt >= alice.lastSignInAt);
    const preferences = { givenName: 'Private', familyName: 'Member', countryCode: 'JP', preferredLocale: 'fr',
      nickname: 'Pixel_Explorer', avatarPreset: 'robot', publicGivenName: false, publicFamilyName: false,
      publicCountry: true, publicLanguage: false };
    assert.deepEqual(await store.updateProfile(replacement, preferences), { status: 'ok' });
    assert.equal((await store.session(replacement)).avatarUrl, '/assets/avatars/robot.svg');
    assert.equal((await store.nicknameAvailability('pixel_explorer')).available, false);
    assert.deepEqual(await store.nicknameAvailability('pixel_explorer', alice.id), { available: true, suggestions: [] });
    assert.equal((await store.nicknameAvailability('PIXEL_EXPLORER')).available, false);
    const conflict = await store.updateProfile(separateHash, { ...preferences, nickname: 'pIXEL_eXPLORER' });
    assert.equal(conflict.status, 'nickname_taken');
    assert.equal(conflict.suggestions.length, 3);
    for (const suggestion of conflict.suggestions) assert.equal((await store.nicknameAvailability(suggestion)).available, true);
    assert.deepEqual(await store.publicProfile('pixel_explorer'), {
      nickname: 'Pixel_Explorer', avatarUrl: '/assets/avatars/robot.svg', countryCode: 'JP',
    });
    assert.equal((await store.session(separateHash)).nickname, null, 'A collision must preserve the other account');
    const concurrentNames = await Promise.all([
      store.updateProfile(replacement, { ...preferences, nickname: 'New_Explorer' }),
      store.updateProfile(separateHash, { ...preferences, nickname: 'new_EXPLORER' }),
    ]);
    assert.equal(concurrentNames.filter(result => result.status === 'ok').length, 1);
    assert.equal(concurrentNames.filter(result => result.status === 'nickname_taken').length, 1);
    const returningHash = sessionHash();
    const returning = await store.signIn(identity, returningHash, expiry());
    assert.equal(returning.avatarUrl, '/assets/avatars/robot.svg', 'Google sign-in must preserve a selected avatar');
    assert.equal(returning.publicCountry, true);
    assert.equal(returning.publicGivenName, false);
    assert.equal(await store.session(concurrentHashes[0]), null);

    const pageOne = await store.listUsers({ limit: 1 });
    const pageTwo = await store.listUsers({ limit: 1, offset: 1 });
    assert.equal(pageOne.total, 2);
    assert.equal(pageTwo.total, 2);
    assert.deepEqual(new Set([pageOne.users[0].id, pageTwo.users[0].id]), new Set([alice.id, bob.id]));
    assert.deepEqual(await store.listUsers({ limit: 1, offset: 2 }), { total: 2, users: [] });

    const expired = concurrentHashes[1];
    await pool.query(`
      UPDATE pixkit_sessions SET
        created_at = UTC_TIMESTAMP(3) - INTERVAL 2 DAY,
        expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 DAY
      WHERE token_hash = ?
    `, [expired]);
    assert.equal(await store.session(expired), null);
    assert.equal(await store.deleteAccount(expired), false);
    assert.equal(await store.pruneExpiredSessions(), 1);
    assert.equal(await store.revokeSession(concurrentHashes[2]), true);
    assert.equal(await store.revokeSession(concurrentHashes[2]), false);

    assert.equal(await store.deleteAccount(replacement), true);
    assert.equal(await store.session(replacement), null);
    assert.equal(await store.session(concurrentHashes[3]), null);
    assert.equal((await store.session(separateHash)).id, bob.id);
    assert.equal((await store.listUsers()).total, 1);
    assert.equal(await store.deleteAccount(separateHash), true);
    assert.deepEqual(await store.listUsers(), { total: 0, users: [] });
  } finally {
    try {
      if (schemaReady) {
        await pool.query('DELETE FROM pixkit_users WHERE google_subject IN (?, ?)',
          [Buffer.from(identity.subject), Buffer.from(separate.subject)]);
      }
    } finally {
      await pool.end();
    }
  }
});
