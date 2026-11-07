import assert from 'node:assert/strict';
import { test } from 'node:test';
import locales from '../../data/i18n/locales.json' with { type: 'json' };
import { publicProfile } from '../profile.mjs';
import { readProfile, renderLocalAccount, renderPublicProfile } from './local-account.mjs';

const user = {
  id: 'fixture-member', displayName: 'Fixture Member', email: 'private@example.invalid',
  givenName: 'Private First', familyName: 'Private Last', countryCode: 'JP', preferredLocale: 'fr',
  nickname: 'PixelMember', avatarPreset: 'robot', avatarUrl: '/assets/avatars/robot.svg',
};

test('account forms use email and password, with aligned native alternatives and unavailable state', () => {
  const html = renderLocalAccount({ locale: 'en', path: '/account/', emailEnabled: true });
  assert.match(html, /name="email" type="email"/);
  assert.match(html, /name="password" type="password"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /data-account-login/);
  assert.match(html, /account-auth-alternatives[\s\S]*Sign up[\s\S]*Continue with Google/);
  assert.doesNotMatch(html, /name="nickname"/);
  const disabled = renderLocalAccount({ locale: 'en', path: '/account/', emailEnabled: false });
  assert.match(disabled, /class="account-credentials" disabled/);
  assert.match(disabled, /name="email" type="email"/);
  assert.match(disabled, /name="password" type="password"/);
});

test('profile view provides presets, private defaults, nickname suggestions and one action row', () => {
  const html = renderLocalAccount({
    locale: 'en', path: '/account/', user, error: 'nickname_taken', nicknameSuggestions: ['PixelMember2'],
  });
  assert.match(html, /src="\/assets\/avatars\/robot.svg"/);
  assert.match(html, /name="nickname"/);
  assert.match(html, /<option value="PixelMember2">/);
  for (const key of ['publicGivenName', 'publicFamilyName', 'publicCountry', 'publicLanguage']) {
    assert.match(html, new RegExp(`name="${key}" value="yes">`));
  }
  assert.match(html, /account-actions[\s\S]*form="account-profile-form"[\s\S]*portal-signout/);
  assert.doesNotMatch(html, /name="email"/);
});

test('profile reader accepts allowlisted settings and rejects duplicate or unknown selections', () => {
  const form = new URLSearchParams({
    givenName: 'First', familyName: 'Last', countryCode: 'JP', preferredLocale: 'en',
    nickname: 'PixelMember', avatarPreset: 'robot', publicGivenName: 'yes',
  });
  const result = readProfile(form, new Set(['en']));
  assert.equal(result.nickname, 'PixelMember');
  assert.equal(result.avatarPreset, 'robot');
  assert.equal(result.publicGivenName, true);
  assert.equal(result.publicFamilyName, false);
  form.set('avatarPreset', 'https://other.invalid/avatar.svg');
  assert.equal(readProfile(form, new Set(['en'])), null);
  form.set('avatarPreset', 'robot');
  form.append('publicGivenName', 'yes');
  assert.equal(readProfile(form, new Set(['en'])), null);
});

test('public profile renders only projected fields and never renders private email or Google photo', () => {
  const projected = publicProfile({ ...user, avatarPreset: null, avatarUrl: 'https://lh3.googleusercontent.com/private' });
  const html = renderPublicProfile({ locale: 'en', profile: projected }).match(/<main[\s\S]*?<\/main>/)[0];
  assert.match(html, /PixelMember/);
  assert.doesNotMatch(html, /private@example|Private First|Private Last|googleusercontent\.com\/private|日本|Japan/);
  const shared = renderPublicProfile({
    locale: 'en', profile: publicProfile({ ...user, publicGivenName: true, publicCountry: true }),
  });
  assert.match(shared, /Private First/);
  assert.match(shared, /Japan/);
  assert.doesNotMatch(shared, /Private Last|private@example/);
});

test('new account controls and password reset render in every supported locale', () => {
  for (const { code } of locales) {
    const signup = renderLocalAccount({ locale: code, path: '/account/sign-up/', emailEnabled: true });
    assert.match(signup, /name="nickname"/);
    assert.match(signup, /autocomplete="new-password"/);
    assert.doesNotMatch(signup, /undefined/);
    const reset = renderLocalAccount({ locale: code, path: '/account/password/reset/', emailEnabled: true });
    assert.match(reset, /action="[^"]*\/account\/password\/reset\/"/);
    assert.match(reset, /name="email" type="email"/);
    assert.doesNotMatch(reset, /name="password"/);
    assert.doesNotMatch(reset, /undefined/);
    const completedReset = renderLocalAccount({ locale: code, path: '/account/', emailEnabled: true, passwordUpdated: true });
    assert.match(completedReset, /class="portal-status" role="status"/);
    assert.doesNotMatch(completedReset, /undefined/);
    const pending = renderLocalAccount({ locale: code, path: '/account/email/pending/', flowPurpose: 'reset' });
    assert.match(pending, /href="[^"]*\/account\/password\/reset\/"/);
    assert.doesNotMatch(pending, /name="code"|name="password"|undefined/);
    const confirmation = renderLocalAccount({
      locale: code, path: '/account/email/confirm/', confirmationToken: 'C'.repeat(43),
    });
    assert.match(confirmation, /name="confirmationToken" value="C{43}"/);
    assert.match(confirmation, /name="selector" value=""/);
    assert.match(confirmation, /name="verificationToken" value=""/);
    assert.match(confirmation, /name="password" type="password"/);
    assert.match(confirmation, /type="submit" disabled/);
    assert.match(confirmation, /\/assets\/js\/email-confirm\.js(?:\?[^"<>]*)?"/);
    assert.doesNotMatch(confirmation, /src="[^"]*(?:consent|language|letter-colors)\.js|id="cookie-dialog"|id="locale-config"|undefined/);
    assert.equal((confirmation.match(/<script\b/g) ?? []).length, 1);
  }
});
