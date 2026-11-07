import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { renderLocalAccount } from './local-account.mjs';

const { chromium, firefox } = createRequire(import.meta.url)('playwright');
const source = new URL('../../', import.meta.url);
const types = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };
const selector = 'A'.repeat(43);
const token = 'B'.repeat(43);
const confirmationToken = 'C'.repeat(43);

async function verifyConfirmation(browser) {
  const submissions = [];
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/account/email/confirm/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('Referrer-Policy', 'same-origin');
      response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
      if (request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const values = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        submissions.push({ values, origin: request.headers.origin });
        if (values.get('password') !== 'A private meadow above the blue sea') {
          response.end(renderLocalAccount({ locale: 'en', path: url.pathname, confirmationToken, error: true }));
        } else {
          response.writeHead(303, { Location: '/account/' }).end();
        }
      } else {
        response.end(renderLocalAccount({ locale: 'en', path: url.pathname, confirmationToken }));
      }
      return;
    }
    if (url.pathname === '/account/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<h1>Confirmation received</h1>');
      return;
    }
    const path = url.pathname === '/_platform/member/member.css' ? '/platform/ui/member.css' : url.pathname;
    if (!path.startsWith('/assets/') && path !== '/platform/ui/member.css') {
      response.writeHead(404).end();
      return;
    }
    try {
      response.setHeader('Content-Type', types[path.split('.').at(-1)] ?? 'application/octet-stream');
      response.end(await readFile(new URL('.' + path, source)));
    } catch {
      response.writeHead(404).end();
    }
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  const externalRequests = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${origin}/account/email/confirm/#selector=${selector}&token=${token}&purpose=signup`);
    await page.waitForFunction(() => !document.querySelector('form[data-email-confirmation] button').disabled);
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(submissions.length, 0, 'Opening the email link never confirms the account');
    assert.equal(await page.locator('input[name="selector"]').inputValue(), selector);
    assert.equal(await page.locator('input[name="verificationToken"]').inputValue(), token);
    assert.equal(await page.locator('input[name="confirmationToken"]').inputValue(), confirmationToken);
    await page.locator('input[name="password"]').fill('Incorrect password provided once');
    await page.getByRole('button', { name: 'Verify email', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-confirmation-status]').textContent.includes('invalid') &&
      !document.querySelector('form[data-email-confirmation] button').disabled);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].origin, origin);
    assert.equal(await page.locator('input[name="verificationToken"]').inputValue(), token, 'A rejected password allows a corrected retry without reopening the email');
    await page.locator('input[name="password"]').fill('A private meadow above the blue sea');
    await page.getByRole('button', { name: 'Verify email', exact: true }).click();
    await page.getByRole('heading', { name: 'Confirmation received' }).waitFor();
    assert.equal(submissions.length, 2);
    assert.equal(submissions[1].origin, origin, 'Explicit same-origin fetch preserves strict Origin checking in Firefox');
    assert.equal(submissions[1].values.get('selector'), selector);
    assert.equal(submissions[1].values.get('verificationToken'), token);
    assert.equal(submissions[1].values.get('confirmationToken'), confirmationToken);
    assert.equal(submissions[1].values.get('password'), 'A private meadow above the blue sea');
    assert.ok(requests.every(value => !value.includes(selector) && !value.includes(token)), 'Secrets never occur in request URLs');
    assert.deepEqual(externalRequests, []);

    await page.goto(`${origin}/account/email/confirm/#selector=${selector}&token=${token}&purpose=reset`);
    await page.waitForFunction(() => !document.querySelector('form[data-email-confirmation] button').disabled);
    assert.equal(await page.locator('input[name="password"]').getAttribute('autocomplete'), 'new-password');
    assert.equal(await page.locator('[data-confirmation-retry]').getAttribute('href'), `${origin}/account/password/reset/`);

    for (const fragment of ['', '#token=invalid', `#selector=${selector}&token=${token}&token=${token}`]) {
      await page.goto(`${origin}/account/email/confirm/${fragment}`);
      await page.waitForFunction(() => document.querySelector('[data-confirmation-status]').textContent.includes('invalid'));
      assert.equal(new URL(page.url()).hash, '');
      assert.equal(await page.getByRole('button', { name: 'Verify email', exact: true }).isDisabled(), true);
      assert.equal(submissions.length, 2);
    }
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
  }
}

const executablePath = process.env.PIXKIT_BROWSER_EXECUTABLE;
const targets = executablePath ? [[chromium, { executablePath }]] : [[chromium, {}], [firefox, {}]];
for (const [engine, options] of targets) {
  const browser = await engine.launch(options);
  try {
    await verifyConfirmation(browser);
    console.log(`${engine.name()} passed: email confirmation strips private fragments, waits for explicit password confirmation, and blocks malformed links.`);
  } finally {
    await browser.close();
  }
}
