import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createLocalAccounts } from '../server/local-accounts.mjs';
import { renderMemberPage } from './index.mjs';

const { chromium, firefox } = createRequire(import.meta.url)('playwright');
const sessionName = 'pixkit-local-session';
const user = { id: 'fixture-member', displayName: 'Test Member', email: 'member@example.invalid' };

async function verifyLogout(browser) {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const sessions = new Map([[hash, user]]);
  const attempts = [];
  const server = createServer();
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const handle = createLocalAccounts({
    origin, languages: ['en'], renderMember: renderMemberPage, google: {},
    store: {
      async session(key) { return sessions.get(key); },
      async revokeSession(key) { sessions.delete(key); },
    },
    publicHandler: async () => new Response('Not found', { status: 404 }),
  });
  server.on('request', async (incoming, outgoing) => {
    const target = new URL(incoming.url, origin);
    const response = await handle(new Request(target, {
      method: incoming.method, headers: incoming.headers,
      ...(incoming.method === 'POST' && { body: Readable.toWeb(incoming), duplex: 'half' }),
    }));
    if (target.pathname === '/account/logout/') {
      attempts.push({ method: incoming.method, origin: incoming.headers.origin, status: response.status });
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await context.addCookies([{ name: sessionName, value: token, url: origin, httpOnly: true }]);
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${origin}/account/`);
    await page.getByRole('heading', { name: 'My account' }).waitFor();
    await page.getByRole('button', { name: 'Sign out' }).click();
    assert.deepEqual(attempts, [{ method: 'POST', origin, status: 303 }]);
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    assert.equal(sessions.size, 0);
    assert.equal((await context.cookies(origin)).some(cookie => cookie.name === sessionName), false);
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
    await verifyLogout(browser);
    console.log(`${engine.name()} passed: native sign-out form sends the same-origin header and revokes the session.`);
  } finally {
    await browser.close();
  }
}
