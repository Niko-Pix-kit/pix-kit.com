const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { chromium } = require('playwright');

const root = join(__dirname, '../..');
const topicId = '02305318-134b-4122-a0e8-c34005dc908f';
const commentId = '311e7766-211d-4024-beb1-94f6d87a442f';
const accountId = '932d819a-425f-47e5-a22a-8b46979841fd';
const category = { slug: 'general-programming', title: 'General Programming', description: '' };
const maliciousText = '<img src=x onerror="globalThis.forumXss = true">';
const reply = {
  id: commentId, parent: topicId, title: null, body: 'Example reply.', author: 'Learner', created_at: '2026-11-06T12:00:00Z',
  score: 0, vote: 0, depth: 1, version: 1, own: false,
};
const topic = {
  id: topicId, category: category.slug, title: 'Debugging parser output', author: 'Learner', depth: 0, parent: null,
  created_at: '2026-11-06T11:00:00Z', score: 2, comment_count: 1, own: true, vote: 0, version: 1,
  body: 'A parser prints ' + maliciousText + '\n\n```js\nconst value = "hello";\n```',
};

const contentType = new Map([
  ['.css', 'text/css'], ['.mjs', 'text/javascript'], ['.js', 'text/javascript'],
  ['.webp', 'image/webp'], ['.png', 'image/png'],
]);
const staticPaths = new Map([
  ['/_platform/community/community.mjs', 'platform/community-ui/community.mjs'],
  ['/_platform/community/community.css', 'platform/community-ui/community.css'],
  ['/_platform/member/member.css', 'platform/ui/member.css'],
  ['/assets/css/site.css', 'assets/css/site.css'],
  ['/assets/css/letter-colors.css', 'assets/css/letter-colors.css'],
  ['/assets/css/consent.css', 'assets/css/consent.css'],
  ['/assets/js/consent.js', 'assets/js/consent.js'],
  ['/assets/js/language.js', 'assets/js/language.js'],
  ['/assets/js/letter-colors.js', 'assets/js/letter-colors.js'],
  ['/assets/brand/symbol.webp', 'assets/brand/symbol.webp'],
  ['/assets/pix-kit-logo-symbol.png', 'assets/pix-kit-logo-symbol.png'],
]);

async function main() {
  const { renderCommunityPage } = await import('./index.mjs');
  let writingOpen = false;
  let appeal = null;
  const mutations = [];
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const member = /role=(member|moderator)/.exec(req.headers.cookie ?? '');
      const roles = member?.[1] === 'moderator' ? ['moderator'] : ['user'];
      const profile = member ? { id: accountId, roles } : null;
      if (url.pathname.startsWith('/api/community/')) {
        const action = url.pathname.split('/').at(-1);
        if (member) assert.equal(req.headers['x-pixkit-account'], accountId);
        requests.push({ action, query: Object.fromEntries(url.searchParams) });
        let result;
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const payload = JSON.parse(body);
          assert.equal(req.headers['x-pixkit-account'], accountId);
          mutations.push({ action, payload });
          if (action === 'appeal') appeal = { reason: payload.p_reason, status: 'pending' };
          result = { ok: true, status: 'pending' };
        } else {
          result = {
            categories: [category],
            settings: { writing_open: writingOpen },
            topics: [topic],
            thread: { topic, replies: [reply], reply_count: 1, writing_open: writingOpen },
            activity: { posts: [{ ...reply, topic: topicId, status: 'held', reason: 'Needs review.', appeal }], sanctions: [] },
            queue: { posts: [{ ...reply, topic: topicId, user: accountId, status: 'held', reports: [{ reason: 'Check this link' }],
              signals: { automated: 'hold' }, appeal }], history: [], total: 1 },
          }[action];
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
        return;
      }
      if (staticPaths.has(url.pathname)) {
        const file = staticPaths.get(url.pathname);
        res.writeHead(200, { 'Content-Type': contentType.get(file.slice(file.lastIndexOf('.'))) });
        res.end(await readFile(join(root, file)));
        return;
      }
      const match = url.pathname.match(/^\/(fr|ar)(\/community\/.*)$/);
      const html = renderCommunityPage({ locale: match?.[1] ?? 'en', path: match?.[2] ?? url.pathname, profile });
      if (!html) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; form-action 'self'",
      });
      res.end(html);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
    await page.context().addCookies([{ name: 'cookie_consent', value: 'v2:0:0', url: origin }]);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(origin + '/fr/community/');
    await page.getByText('Le forum est actuellement en lecture seule.').waitFor();
    await page.getByRole('link', { name: topic.title }).waitFor();
    assert(await page.locator('select[name="p_category"] option').allTextContents().then((options) => options.includes('Programmation générale')));
    await page.getByRole('searchbox', { name: 'Rechercher' }).fill('parser');
    await page.getByLabel('Trier par').selectOption('discussed');
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/community/topics?p_search=parser')),
      page.getByRole('button', { name: 'Rechercher' }).click(),
    ]);
    assert(requests.some(({ action, query }) => action === 'topics' && query.p_search === 'parser' && query.p_sort === 'discussed'));
    await page.getByRole('link', { name: topic.title }).click();
    await page.getByRole('heading', { level: 1, name: topic.title }).waitFor();
    assert((await page.locator('.forum-prose').first().innerText()).includes(maliciousText));
    assert.equal(await page.locator('.forum-prose img').count(), 0);
    assert.equal(await page.locator('pre code').innerText(), 'const value = "hello";');
    assert.equal(await page.evaluate(() => window.forumXss), undefined);
    assert.equal(await page.getByRole('button', { name: 'Vote positif' }).count(), 0);

    await page.goto(origin + '/ar/community/');
    await page.getByRole('link', { name: topic.title }).waitFor();
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.COMMUNITY_TEST_SCREENSHOT) {
      await page.screenshot({ path: process.env.COMMUNITY_TEST_SCREENSHOT, fullPage: true });
    }

    writingOpen = true;
    await page.context().addCookies([{ name: 'role', value: 'member', url: origin }]);
    await page.goto(origin + '/community/');
    await page.getByText('New topic', { exact: true }).click();
    const form = page.locator('[data-submit-topic]');
    await form.getByLabel('Title').fill('Question about parser output');
    await form.getByLabel('Message').fill('I need help finding an error.');
    await form.getByRole('button', { name: 'Submit' }).click();
    await form.getByText('Submitted for moderation.', { exact: false }).waitFor();
    assert.match(mutations[0].payload.p_request, /^[a-f0-9-]{36}$/);
    assert.equal(mutations[0].payload.p_category, category.slug);

    await page.getByRole('link', { name: topic.title }).click();
    const mainPost = page.locator('.forum-card').first();
    await mainPost.getByRole('button', { name: 'Upvote' }).click();
    await mainPost.getByRole('button', { name: 'Upvote', pressed: true }).waitFor();
    await mainPost.getByText('Reply', { exact: true }).click();
    await mainPost.locator('details[open]').getByLabel('Message').fill('The output is escaped.');
    await mainPost.getByRole('button', { name: 'Submit' }).click();
    await mainPost.getByText('Submitted for moderation.', { exact: false }).waitFor();
    assert(mutations.some(({ action, payload }) => action === 'submit' && payload.p_parent === topicId));

    const reportSummary = mainPost.locator('summary').filter({ hasText: /^Report$/ });
    await reportSummary.click();
    const report = mainPost.locator('details[open]').filter({ has: page.locator('summary').filter({ hasText: /^Report$/ }) });
    await report.getByLabel('Reason').fill('Please check the example.');
    await report.getByRole('button', { name: 'Report' }).click();
    await report.getByText('Changes saved.', { exact: true }).waitFor();
    assert(mutations.some(({ action }) => action === 'report'));

    await page.goto(origin + '/community/activity/');
    await page.locator('summary').filter({ hasText: /^Request review$/ }).click();
    await page.getByLabel('Reason').fill('Please verify the output.');
    await page.getByRole('button', { name: 'Request review' }).click();
    await page.getByText('Changes saved.', { exact: true }).waitFor();
    assert(mutations.some(({ action }) => action === 'appeal'));

    await page.context().addCookies([{ name: 'role', value: 'moderator', url: origin }]);
    await page.goto(origin + '/community/moderation/');
    const filter = page.locator('[data-queue-filter]');
    await filter.getByRole('combobox').selectOption('blocked');
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/community/queue?p_status=blocked')),
      filter.getByRole('button', { name: 'Apply' }).click(),
    ]);
    const queue = page.locator('[data-content]');
    await queue.getByText('Reports', { exact: true }).click();
    await queue.getByText('Check this link').waitFor();
    await queue.getByLabel('Action').selectOption('appeal_accept');
    await queue.getByLabel('Reason').fill('Verified by a moderator.');
    await queue.getByRole('button', { name: 'Apply' }).click();
    await page.getByText('Changes saved.', { exact: true }).waitFor();
    assert(mutations.some(({ action, payload }) => action === 'review' && payload.p_action === 'appeal_accept'));

    await queue.getByRole('button', { name: 'Account actions' }).click();
    const sanction = page.locator('[data-sanction]');
    assert.equal(await sanction.getByLabel('Account ID').inputValue(), accountId);
    await sanction.getByLabel('Action').selectOption('suspend');
    await sanction.getByLabel('Days').fill('5');
    await sanction.getByLabel('Reason').fill('Repeat offense.');
    await sanction.getByRole('button', { name: 'Apply' }).click();
    await page.getByText('Changes saved.', { exact: true }).waitFor();
    assert(mutations.some(({ action, payload }) => action === 'sanction' && payload.p_days === 5));
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => console.log('Community browser checks passed.')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
