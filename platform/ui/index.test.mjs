import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import locales from '../../data/i18n/locales.json' with { type: 'json' };
import { renderLessonBody, renderMemberPage } from './index.mjs';
import { applySiteChrome, localPath, messagesFor, renderShell } from './shell.mjs';

const account = {
  id: '0f9a11d3-a57e-499a-965e-a9fbb064c49b',
  display_name: 'Name" <svg onload=alert(1)>',
  email: 'sample@example.test',
  preferred_language: 'ar',
  status: 'active',
};
const first = { id: 'first', course_id: 'test-course', title: 'Preview', body: 'Preview text.', access: 'public' };
const second = { id: 'second', course_id: 'test-course', title: 'Member lesson', body: 'Private lesson body.', access: 'registered' };
const catalog = [{
  id: 'test-course',
  title: 'Course <name>',
  description: 'Short description.',
  lessons: [{ ...first, available: true }, { ...second, available: true }],
}];

test('portal copy covers every existing language and uses localized routes', () => {
  const keys = Object.keys(messagesFor('en'));
  assert.equal(locales.length, 19);
  for (const { code, tag, dir } of locales) {
    const copy = messagesFor(code);
    assert.deepEqual(Object.keys(copy), keys);
    assert.ok(Object.values(copy).every(value => typeof value === 'string' && value.trim()));
    const html = renderMemberPage({ locale: code, path: '/learn/' });
    assert.ok(html.includes(`<html lang="${tag}" dir="${dir ?? 'ltr'}"`));
    assert.ok(html.includes(copy.catalogEmpty));
    assert.ok(html.includes(`href="${localPath(code, '/about/')}"`));
    assert.ok(html.includes(`href="${localPath(code, '/community/')}"`));
  }
  assert.throws(() => localPath('en', '//external.example.test'));
  assert.throws(() => localPath('en', '/\\external.example.test'));
});

test('registered content and locked payloads never reach the guest document', () => {
  const preview = renderMemberPage({ path: '/learn/test-course/first/', lesson: first });
  assert.ok(preview.includes('Preview text.'));
  assert.ok(preview.includes('data-action="guest-progress"'));
  assert.ok(!preview.includes('data-seen'));
  const lessonPath = '/learn/test-course/second/';
  const guest = renderMemberPage({ path: lessonPath, lesson: second });
  assert.ok(!guest.includes(second.body));
  assert.ok(guest.includes('Sign in to open this lesson.'));
  const locked = renderMemberPage({ path: lessonPath, profile: account, lesson: { ...second, available: false } });
  assert.ok(!locked.includes(second.body));
  const member = renderMemberPage({ path: lessonPath, profile: account, lesson: second });
  assert.ok(member.includes(second.body));
  assert.ok(member.includes('data-seen'));
  assert.ok(member.includes(`data-account-id="${account.id}"`));
  assert.ok(member.includes('noindex'));
});

test('profile forms are safe and do not offer edits to a deleting account', () => {
  const html = renderMemberPage({ path: '/account/', profile: account });
  assert.ok(html.includes('Name&quot; &lt;svg'));
  assert.ok(html.includes('data-action="import"'));
  assert.ok(!html.includes('<svg onload='));
  assert.match(html, /value="ar" selected/);
  assert.match(html, /type="checkbox" required/);
  const deleting = renderMemberPage({ path: '/account/', profile: { ...account, status: 'deleting' } });
  assert.ok(!deleting.includes('data-action="profile"'));
  assert.ok(!deleting.includes('data-action="import"'));
  assert.ok(deleting.includes('data-action="logout"'));
  assert.ok(deleting.includes('data-action="delete"'));
});

test('dashboard resumes the next available lesson and ignores unavailable course entries', () => {
  const progress = [{
    course_id: 'test-course', lesson_id: 'first',
    completed_at: '2026-11-06T01:02:03Z', last_accessed_at: '2026-11-06T01:02:03Z',
  }, { course_id: 'another-course', lesson_id: 'another-lesson', completed_at: null }];
  const html = renderMemberPage({ locale: 'fr', path: '/learn/progress/', profile: account, catalog, progress });
  assert.match(html, /max="2" value="1"/);
  assert.match(html, /href="\/fr\/learn\/test-course\/second\/">Reprendre/);
  assert.ok(!html.includes('another-course'));
  assert.ok(html.includes('data-action="import"'));
});

test('Markdown renders headings and code without interpreting raw HTML', () => {
  const html = renderLessonBody([
    '# Intro', '', 'Run `<cmd>` before <img onerror="bad">.',
    '', '```js', 'console.log("<script>");', '```',
  ].join('\n'));
  assert.ok(html.includes('<h2 dir="auto">Intro</h2>'));
  assert.ok(html.includes('<code>&lt;cmd&gt;</code>'));
  assert.ok(html.includes('<pre dir="ltr"><code>console.log'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script'));
});

test('public and member pages share the same chrome and expose community to every visitor', () => {
  const homepage = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const profile = { ...account, avatarUrl: 'https://lh3.googleusercontent.com/test-avatar' };
  for (const currentProfile of [null, profile]) {
    const publicPage = applySiteChrome(homepage, { locale: 'en', path: '/', profile: currentProfile });
    const memberPage = renderMemberPage({ path: '/learn/', profile: currentProfile });
    const header = /<header class="site-nav">[\s\S]*?<\/header>/;
    const footer = /<footer class="footer">[\s\S]*?<\/footer>/;
    const links = (html) => html.match(header)[0].replace(' aria-current="page"', '');
    assert.equal(links(publicPage), links(memberPage));
    assert.equal(publicPage.match(footer)[0], memberPage.match(footer)[0]);
    assert.match(publicPage.match(footer)[0], /© 2026 Pix-kit · Build\. Learn\. Play\./);
    assert.equal(links(publicPage).includes('href="/community/"'), true);
    assert.equal(links(publicPage).includes('class="nav-avatar"'), Boolean(currentProfile));
  }
  const preset = applySiteChrome(homepage, { locale: 'en', path: '/',
    profile: { ...account, avatarUrl: '/assets/avatars/robot.svg' } });
  assert.match(preset.match(/<header class="site-nav">[\s\S]*?<\/header>/)[0], /src="\/assets\/avatars\/robot\.svg"/);
  const profileWithBadAvatar = { ...account, avatarUrl: 'https://other.example.test/test-avatar' };
  const unsafe = applySiteChrome(homepage, { locale: 'en', path: '/', profile: profileWithBadAvatar });
  assert.ok(!unsafe.match(/<header class="site-nav">[\s\S]*?<\/header>/)[0].includes('test-avatar'));
});

test('all localized member pages retain site legal links and working cookie controls', () => {
  for (const { code } of locales) {
    const html = renderMemberPage({ locale: code, path: '/learn/' });
    const footer = html.match(/<footer class="footer">[\s\S]*?<\/footer>/)[0];
    for (const route of ['/platform-privacy/', '/terms-of-use/', '/cookie-policy/']) {
      assert.ok(footer.includes(`href="${localPath(code, route)}"`));
    }
    assert.match(footer, /<button type="button" data-cookie-manage>/);
    assert.match(html, /id="cookie-dialog"/);
    assert.match(html, /src="\/assets\/js\/consent\.js\?v=/);
  }
});

test('sensitive confirmation shells expose only their explicit script and safe footer links', () => {
  for (const code of ['en', 'fr', 'ar']) {
    const html = renderShell({ locale: code, path: '/account/email/confirm/', title: 'Confirm email',
      body: '<p>Confirm email</p>', analytics: false, script: '/assets/js/email-confirm.js' });
    const sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(sources.map(source => source.split('?')[0]), ['/assets/js/email-confirm.js']);
    assert.doesNotMatch(html, /locale-config|cookie-dialog|analytics\.js|googletagmanager/);
    assert.ok(html.includes(`href="${localPath(code, '/cookie-policy/')}#cookie-preferences"`));
    assert.doesNotMatch(html, /data-cookie-manage/);
  }
});
