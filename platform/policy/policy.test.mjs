import assert from 'node:assert/strict';
import test from 'node:test';
import locales from '../../data/i18n/locales.json' with { type: 'json' };
import { escapeHtml, localPath } from '../ui/shell.mjs';
import { renderPolicyPage } from './index.mjs';
import translations from './messages.json' with { type: 'json' };

const routes = {
  guidelines: '/community-guidelines/',
  privacy: '/platform-privacy/',
  terms: '/platform-terms/',
};

test('the canonical policy routes render complete localized sections for every site locale', () => {
  assert.deepEqual(Object.keys(translations), locales.map(locale => locale.code));
  const pageNames = Object.keys(routes);

  for (const { code, tag, dir = 'ltr' } of locales) {
    assert.deepEqual(Object.keys(translations[code]), pageNames);
    for (const [page, path] of Object.entries(routes)) {
      const [title, ...sections] = translations[code][page];
      const document = renderPolicyPage({ locale: code, path });

      assert.ok(document.includes(`<html lang="${tag}" dir="${dir}"`), code);
      assert.ok(document.includes(`<h1>${escapeHtml(title)}</h1>`), code);
      assert.equal(sections.length, translations.en[page].length - 1, code);
      assert.equal(document.match(/<h2 id="heading-/g)?.length, sections.length, code);
      assert.ok(document.includes('href="mailto:info@pix-kit.com"'), code);
      assert.ok(document.includes(`href="${localPath(code, '/account/')}"`), code);

      if (code !== 'en') assert.notEqual(title, translations.en[page][0], code);
      for (const [heading, paragraph] of sections) {
        assert.ok(heading.trim() && paragraph.trim(), code);
        assert.ok(document.includes(escapeHtml(heading)), code);
        assert.ok(document.includes(escapeHtml(paragraph)), code);
      }
    }
  }
});

test('the policy renderer handles an unsupported route and falls back to English for an unknown locale', () => {
  assert.equal(renderPolicyPage({ locale: 'en', path: '/unrelated/' }), null);
  assert.equal(renderPolicyPage({ locale: 'unknown', path: routes.guidelines }),
    renderPolicyPage({ locale: 'en', path: routes.guidelines }));
});
