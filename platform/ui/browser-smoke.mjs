import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { renderMemberPage } from './index.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const source = new URL('../../', import.meta.url);
const assets = new Map([
  ['/_platform/member/member.css', ['platform/ui/member.css', 'text/css']],
  ['/_platform/member/member.js', ['platform/ui/member.js', 'application/javascript']],
  ['/assets/css/site.css', ['assets/css/site.css', 'text/css']],
  ['/assets/css/letter-colors.css', ['assets/css/letter-colors.css', 'text/css']],
  ['/assets/css/consent.css', ['assets/css/consent.css', 'text/css']],
  ['/assets/js/consent.js', ['assets/js/consent.js', 'application/javascript']],
  ['/assets/js/language.js', ['assets/js/language.js', 'application/javascript']],
  ['/assets/js/letter-colors.js', ['assets/js/letter-colors.js', 'application/javascript']],
  ['/assets/brand/symbol.webp', ['assets/brand/symbol.webp', 'image/webp']],
  ['/assets/brand/google-g.png', ['assets/brand/google-g.png', 'image/png']],
  ['/assets/pix-kit-logo-symbol.png', ['assets/pix-kit-logo-symbol.png', 'image/png']],
]);
const account = {
  id: '6924bfde-9b52-4661-9899-78b1c39685e9', display_name: 'Browser sample',
  email: 'account@example.test', preferred_language: 'en', status: 'active',
};
const preview = {
  id: 'preview', course_id: 'browser-course', title: 'Public intro', body: 'Learn with `safe_code`.',
  access: 'public', available: true,
};
const privateLesson = {
  id: 'private', course_id: 'browser-course', title: 'Member details', body: 'Private example',
  access: 'registered', available: true,
};
const catalog = [{
  id: 'browser-course', title: 'Browser fixture', description: 'Only for this test',
  lessons: [preview, privateLesson],
}];
const requests = [];
const progress = [];
let failCompletion = true;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const profile = req.headers.cookie?.includes('fixture=member') ? account : null;
  if (url.pathname.startsWith('/api/')) {
    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    requests.push({ url: url.pathname, body, account: req.headers['x-pixkit-account'] });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/account/verify') {
      res.setHeader('Set-Cookie', 'fixture=member; HttpOnly; SameSite=Lax; Path=/');
    }
    if (url.pathname === '/api/learning/progress' && !body) return res.end(JSON.stringify(progress));
    if (url.pathname === '/api/learning/progress' && body?.p_completed && failCompletion) {
      failCompletion = false;
      res.statusCode = 503;
      return res.end('{}');
    }
    if (url.pathname === '/api/learning/import') {
      for (const entry of body.p_completed) progress.push({ ...entry, completed_at: '2026-11-06T01:02:03Z' });
    }
    return res.end('{}');
  }
  const asset = assets.get(url.pathname);
  if (asset) {
    const [file, type] = asset;
    res.setHeader('Content-Type', type);
    return res.end(await readFile(new URL(file, source)));
  }
  const locale = url.pathname.startsWith('/ar/') ? 'ar' : 'en';
  const path = locale === 'ar' ? url.pathname.slice(3) : url.pathname;
  const lesson = path.endsWith('/preview/') ? preview
    : path.endsWith('/private/') ? profile ? privateLesson : { ...privateLesson, available: false } : null;
  const html = renderMemberPage({
    locale, path, profile, catalog, lesson, progress, authOptions: { google: true, apple: true, email: true },
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (!html) res.statusCode = 404;
  res.end(html ?? '');
});
const executablePath = process.env.PIXKIT_BROWSER_EXECUTABLE;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  await page.context().addCookies([{ name: 'cookie_consent', value: 'v2:0:0', url: base }]);
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/ar/learn/');
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  assert.equal(await page.locator('html').getAttribute('lang'), 'ar');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '#main');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
  await page.locator('.language-picker summary').click();
  await page.locator('.language-picker').getByRole('link', { name: 'English' }).click();
  await page.waitForURL(base + '/learn/?lang=en');
  await page.getByRole('link', { name: 'Member details' }).click();
  assert.equal(await page.getByText('Private example', { exact: true }).count(), 0);
  await page.goto(base + '/learn/browser-course/preview/');
  await page.getByRole('button', { name: 'Mark complete' }).click();
  await page.getByRole('status').filter({ hasText: 'Completed · Progress saved.' }).waitFor();
  assert.equal(requests.length, 0);
  await page.reload();
  await page.getByRole('status').filter({ hasText: 'Completed · Progress saved.' }).waitFor();
  await page.goto(base + '/account/');
  const googleButton = page.getByRole('link', { name: 'Continue with Google' });
  assert.equal(await googleButton.getAttribute('href'), '/auth/start?provider=google&locale=en');
  assert.ok(await googleButton.locator('img').evaluate(img => img.complete && img.naturalWidth > 0));
  assert.equal(await page.locator('.nav-links a[href="/community/"]').count(), 1);
  await page.getByLabel('Email address').fill('account@example.test');
  await page.getByRole('button', { name: 'Send a sign-in code' }).click();
  await page.getByLabel('Sign-in code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'My account' }).waitFor();
  assert.equal(await page.locator('.nav-links a[href="/community/"]').count(), 1);
  assert.deepEqual(requests.slice(0, 2).map(row => row.body), [
    { email: 'account@example.test', locale: 'en' },
    { email: 'account@example.test', token: '123456' },
  ]);
  await page.getByRole('button', { name: 'Import progress' }).click();
  await page.waitForURL(base + '/learn/progress/');
  await page.getByText('50%', { exact: true }).waitFor();
  const imported = requests.find(row => row.url === '/api/learning/import');
  assert.equal(imported.account, account.id);
  assert.equal(requests.find(row => row.url === '/api/learning/progress' && !row.body).account, account.id);
  assert.deepEqual(imported.body, { p_completed: [{ course_id: 'browser-course', lesson_id: 'preview' }] });
  assert.equal(await page.evaluate(() => localStorage.getItem('pixkit.guest-progress.v1')), null);
  await page.getByRole('link', { name: 'Resume' }).click();
  await page.getByText('Private example').waitFor();
  await page.getByRole('button', { name: 'Mark complete' }).click();
  await page.getByRole('alert').filter({ hasText: 'We couldn’t complete that request. Please try again.' }).waitFor();
  await page.getByRole('button', { name: 'Mark complete' }).click();
  await page.getByRole('status').filter({ hasText: 'Completed · Progress saved.' }).waitFor();
  assert.ok(requests.filter(row => row.url === '/api/learning/progress' && row.body).every(row => row.account === account.id));
  const completions = requests.filter(row => row.body?.p_completed === true);
  assert.equal(completions[0].body.p_seen_at, completions[1].body.p_seen_at);
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(base + '/ar/account/');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  await page.setViewportSize({ width: 1200, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1200);
  assert.ok(await page.locator('.brand img').evaluate(img => img.complete && img.naturalWidth > 0));
  assert.deepEqual(errors, []);
  console.log('Chromium passed: mobile RTL, keyboard skip link, locale switch, lesson gating, local guest progress, email code sign-in, authorized import, retry after 503, and no page errors.');
} finally {
  await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
