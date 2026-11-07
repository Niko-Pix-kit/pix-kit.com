import assert from 'node:assert/strict';
import { test } from 'node:test';
import locales from '../../data/i18n/locales.json' with { type: 'json' };
import { countryCodes, countryFlag, countryLabel, countryOptions, normalizeCountryCode, publicProfile } from '../profile.mjs';
import { readProfile, renderLocalAccount, renderPublicProfile } from '../ui/local-account.mjs';

test('country choices contain each assigned country and territory once and exclude aliases and groups', () => {
  assert.equal(countryCodes.length, 249);
  assert.equal(new Set(countryCodes).size, countryCodes.length);
  for (const code of ['FR', 'JP', 'US', 'GB', 'GF', 'PF', 'GP', 'RE', 'AX', 'BQ', 'TW', 'HK', 'PS']) {
    assert.ok(countryCodes.includes(code), code);
  }
  for (const code of ['FX', 'EU', 'EZ', 'UN', 'UK', 'AC', 'SU', 'ZZ', 'XX', 'AA']) {
    assert.ok(!countryCodes.includes(code), code);
  }
  const english = countryOptions('en');
  assert.equal(english.filter(country => country.name === 'France').length, 1);
  assert.equal(english.find(country => country.name === 'France').code, 'FR');
});

test('localized country options carry matching flag sequences and remain sorted in every site language', () => {
  for (const { tag } of locales) {
    const options = countryOptions(tag);
    const collator = new Intl.Collator(tag);
    assert.equal(options.length, 249, tag);
    assert.equal(new Set(options.map(option => option.code)).size, 249, tag);
    assert.equal(new Set(options.map(option => option.name)).size, 249, tag);
    assert.ok(Object.isFrozen(options));
    for (const [index, option] of options.entries()) {
      const flag = countryFlag(option.code);
      assert.equal([...flag].length, 2);
      assert.deepEqual([...flag].map(character => character.codePointAt(0) - 0x1f1e6 + 65),
        [...option.code].map(character => character.codePointAt(0)));
      assert.equal(option.label, `${option.name} ${flag}`);
      assert.ok(Object.isFrozen(option));
      if (index) assert.ok(collator.compare(options[index - 1].name, option.name) <= 0, tag);
    }
  }
  assert.equal(countryLabel('FR', 'fr'), 'France 🇫🇷');
  assert.equal(countryLabel('JP', 'ja'), '日本 🇯🇵');
});

test('legacy France selections normalize for display and validation without mutating stored profiles', () => {
  assert.equal(normalizeCountryCode(' fx '), 'FR');
  assert.equal(normalizeCountryCode(' fr '), 'FR');
  assert.equal(normalizeCountryCode('jp'), 'JP');
  assert.equal(countryFlag('FX'), '🇫🇷');
  assert.equal(countryLabel('FX', 'en'), countryLabel('FR', 'en'));
  const stored = { nickname: 'LegacyMember', countryCode: 'FX', publicCountry: true };
  assert.equal(publicProfile(stored).countryCode, 'FR');
  assert.equal(stored.countryCode, 'FX');
  assert.ok(!Object.hasOwn(publicProfile({ ...stored, publicCountry: false }), 'countryCode'));
  for (const [legacy, canonical] of Object.entries({ BU: 'MM', DD: 'DE', TP: 'TL', UK: 'GB', YD: 'YE', ZR: 'CD' })) {
    assert.equal(normalizeCountryCode(legacy), canonical);
    assert.equal(countryFlag(legacy), countryFlag(canonical));
    const saved = { ...stored, countryCode: legacy };
    assert.equal(publicProfile(saved).countryCode, canonical);
    assert.equal(saved.countryCode, legacy);
  }
});

test('unassigned, malformed, and grouped region values never produce a country or flag', () => {
  for (const value of [null, undefined, [], {}, 250, '', 'EU', 'EZ', 'UN', 'ZZ', 'XX', 'AN', 'CS', 'SU', 'FRA', '<script>', 'F\0R']) {
    assert.equal(normalizeCountryCode(value), null);
    assert.equal(countryFlag(value), '');
    assert.equal(countryLabel(value, 'en'), '');
  }
  const profile = publicProfile({ nickname: 'LegacyMember', countryCode: 'EU', publicCountry: true });
  assert.ok(!Object.hasOwn(profile, 'countryCode'));
});

test('account and signup dropdowns render canonical flag choices and preserve legacy France selection', () => {
  const user = {
    id: 'fixture', nickname: 'LegacyMember', displayName: 'Legacy Member', email: 'private@example.invalid',
    countryCode: 'FX', preferredLocale: 'en',
  };
  for (const { code } of locales) {
    for (const profile of [null, user]) {
      const body = renderLocalAccount({ locale: code, path: '/account/sign-up/', user: profile, emailEnabled: true });
      const dropdown = body.match(/<select id="country-code"[^>]*>([\s\S]*?)<\/select>/)?.[1];
      assert.ok(dropdown, code);
      const choices = [...dropdown.matchAll(/<option value="([A-Z]*)"/g)].map(match => match[1]);
      assert.equal(choices.length, 250, code);
      assert.equal(new Set(choices).size, 250, code);
      assert.ok(!choices.includes('FX'));
      assert.ok(!choices.includes('EU'));
      assert.ok(!choices.includes('EZ'));
      assert.match(dropdown, profile ? /<option value="FR" selected>[^<]+ 🇫🇷<\/option>/ : /<option value="FR">[^<]+ 🇫🇷<\/option>/);
      assert.match(dropdown, /<option value="JP"[^>]*>[^<]+ 🇯🇵<\/option>/);
      if (code === 'en') assert.equal([...dropdown.matchAll(/>France 🇫🇷<\/option>/g)].length, 1);
    }
  }
  const body = renderPublicProfile({ locale: 'en', profile: publicProfile({ ...user, publicCountry: true }) });
  assert.match(body, /France 🇫🇷/);
});

test('profile form validation canonicalizes aliases and rejects group or tampered country selections', () => {
  const languages = new Set(locales.map(locale => locale.code));
  const values = { givenName: 'Example', familyName: 'Member', countryCode: 'FX', preferredLocale: 'en' };
  assert.equal(readProfile(new URLSearchParams(values), languages).countryCode, 'FR');
  for (const countryCode of ['EU', 'EZ', 'UN', 'ZZ', 'AA', 'FRA', '<script>']) {
    assert.equal(readProfile(new URLSearchParams({ ...values, countryCode }), languages), null, countryCode);
  }
  const duplicate = new URLSearchParams(values);
  duplicate.append('countryCode', 'JP');
  assert.equal(readProfile(duplicate, languages), null);
  assert.equal(readProfile(new URLSearchParams({ ...values, countryCode: '' }), languages).countryCode, null);
});
