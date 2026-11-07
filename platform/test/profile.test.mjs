import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { avatarPresets, normalizeNickname, presetAvatarUrl, publicProfile } from '../profile.mjs';
import { createMariaStore } from '../server/mariadb.mjs';

test('nicknames use one bounded case-insensitive database representation', () => {
  assert.equal(normalizeNickname('  Pixel_Explorer  '), 'Pixel_Explorer');
  for (const value of ['', null, [], 'ab', '_pixel', 'name with spaces', '<b>nick</b>', 'éclair', 'a'.repeat(25)]) {
    assert.equal(normalizeNickname(value), null);
  }
  assert.equal(normalizeNickname('a'.repeat(24)), 'a'.repeat(24));
  assert.equal(new Set(avatarPresets.map(preset => preset.id)).size, avatarPresets.length);
  for (const preset of avatarPresets) assert.match(presetAvatarUrl(preset.id), /^\/assets\/avatars\/[a-z]+\.svg$/);
  assert.equal(presetAvatarUrl('https://example.invalid/avatar'), null);
});

test('public profile projection is deny-by-default and never includes Google data or credentials', () => {
  const profile = {
    nickname: 'Pixel_Explorer', email: 'private@example.invalid', id: 'private-id', isAdmin: true,
    avatarUrl: 'https://lh3.googleusercontent.com/private-photo',
    givenName: 'Private', familyName: 'Member', countryCode: 'JP', preferredLocale: 'fr',
  };
  assert.deepEqual(publicProfile(profile), { nickname: 'Pixel_Explorer', avatarUrl: null });
  assert.deepEqual(publicProfile({ ...profile, avatarPreset: 'robot', publicGivenName: true, publicCountry: true }), {
    nickname: 'Pixel_Explorer', avatarUrl: '/assets/avatars/robot.svg', givenName: 'Private', countryCode: 'JP',
  });
  assert.deepEqual(publicProfile({ ...profile, publicLanguage: 1 }), { nickname: 'Pixel_Explorer', avatarUrl: null });
  assert.equal(publicProfile({ ...profile, nickname: null }), null);
});

test('invalid profile preferences fail before the database and preserve old caller semantics', async () => {
  let queries = 0;
  const store = createMariaStore({ pool: { async query() { queries++; return { affectedRows: 1 }; } } });
  const hash = randomBytes(32);
  const base = { givenName: 'Test', familyName: 'Member', countryCode: 'JP', preferredLocale: 'en' };
  for (const extra of [{ nickname: null }, { nickname: 'bad nickname' }, { avatarPreset: 'external' }, { publicCountry: 'yes' }]) {
    await assert.rejects(store.updateProfile(hash, { ...base, ...extra }), /Invalid/);
  }
  assert.equal(queries, 0);
  assert.deepEqual(await store.nicknameAvailability('bad nickname'), { available: false, suggestions: [] });
  assert.equal(await store.publicProfile('bad nickname'), null);
  assert.equal(queries, 0);
  assert.deepEqual(await store.updateProfile(hash, base), { status: 'ok' });
});
