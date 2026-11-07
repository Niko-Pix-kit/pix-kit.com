import assert from 'node:assert/strict';
import test from 'node:test';
import locales from '../../data/i18n/locales.json' with { type: 'json' };
import { renderCommunityPage } from './index.mjs';
import dictionaries from './translations.json' with { type: 'json' };

const accountId = '932d819a-425f-47e5-a22a-8b46979841fd';
const topicId = '02305318-134b-4122-a0e8-c34005dc908f';

test('forum controls and feedback cover every site locale', () => {
  const keys = Object.keys(dictionaries.en).sort();
  assert.deepEqual(Object.keys(dictionaries).sort(), locales.map(({ code }) => code).sort());
  for (const locale of locales) {
    const dictionary = dictionaries[locale.code];
    assert.deepEqual(Object.keys(dictionary).sort(), keys, locale.code);
    assert(Object.values(dictionary).every((label) => typeof label === 'string' && label.trim()));
    const html = renderCommunityPage({ locale: locale.code, path: '/community/' });
    assert(html.includes(`<html lang="${locale.tag}" dir="${locale.dir ?? 'ltr'}"`));
    assert(html.includes(`<title>${dictionary.forum} | Pix-kit</title>`));
    const labels = html.match(/<template data-labels>([^<]*)<\/template>/)[1];
    assert(labels.includes(dictionary.loading));
  }
});

test('guest, member, moderator and admin only receive their applicable controls', () => {
  const member = { id: accountId, roles: ['user'], email: 'member@example.invalid', display_name: '<img onerror=alert(1)>' };
  const guest = renderCommunityPage({ path: '/community/' });
  assert.doesNotMatch(guest, /data-submit-topic|data-account-id|moderation\//);
  const signedIn = renderCommunityPage({ locale: 'fr', path: '/community/', profile: member });
  assert.match(signedIn, /\/fr\/community\/activity\//);
  assert.match(signedIn, /data-submit-topic/);
  assert.match(signedIn, new RegExp(`data-account-id="${accountId}"`));
  assert.doesNotMatch(signedIn, /member@example|onerror/);
  for (const profile of [null, member]) {
    assert.doesNotMatch(renderCommunityPage({ path: '/community/moderation/', profile }), /data-sanction|community\.mjs/);
  }
  const moderation = (role) => renderCommunityPage({ path: '/community/moderation/', profile: { ...member, roles: [role] } });
  assert.match(moderation('moderator'), /data-sanction/);
  assert.doesNotMatch(moderation('moderator'), /value="ban"/);
  assert.match(moderation('admin'), /value="ban"/);
  assert.match(moderation('admin'), /value="restore"/);
});

test('only forum routes and UUID-shaped topic paths are recognized', () => {
  assert.match(renderCommunityPage({ path: `/community/topic/${topicId.toUpperCase()}/` }),
    new RegExp(`data-topic="${topicId}"`));
  for (const path of ['/community/topic/invalid/', '/community/topic/"><img>/', '/community-guidelines/', '/learn/']) {
    assert.equal(renderCommunityPage({ path }), null);
  }
});
