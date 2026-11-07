'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, firefox } = require('playwright');

const root = path.resolve(__dirname, '..');
const site = 'https://pix-kit.com';
const preview = 'https://preview.example.test';
const tag = 'https://www.googletagmanager.com/gtag/js?id=G-Y3KP2PKKS3';
const collect = 'https://www.google-analytics.com/g/collect';
const isCollection = url => /(^|\.)google-analytics\.com$/.test(url.hostname) && url.pathname === '/g/collect';
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg'
};

// Stand in for Google's remote code. Any provider request is intercepted and
// counted, so the suite cannot send traffic or test data to the real property.
const fakeTag = `
  document.cookie = '_ga=browser; Path=/; Domain=pix-kit.com; Secure';
  document.cookie = '_ga_Y3KP2PKKS3=session; Path=/; Secure';
  const pixel = new Image();
  pixel.src = ${JSON.stringify(collect)} + '?' + new URLSearchParams({
    dl: location.href, dr: document.referrer
  });
`;

async function fixture(browser, options, providerTag = fakeTag) {
  const context = await browser.newContext({ locale: 'en-US', ...options });
  const google = [];
  const unexpected = [];
  const errors = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.href === tag) {
      google.push(url.href);
      return route.fulfill({ contentType: 'text/javascript', body: providerTag });
    }
    if (isCollection(url)) {
      google.push(url.href);
      return route.fulfill({ status: 204 });
    }
    if (![site, preview].includes(url.origin)) {
      unexpected.push(url.href);
      return route.abort();
    }
    const relative = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const file = path.resolve(root, '.' + relative);
    try {
      if (!file.startsWith(root + path.sep)) throw new Error('Invalid fixture path');
      const body = await fs.readFile(file);
      return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body });
    } catch {
      if (route.request().isNavigationRequest()) {
        const body = await fs.readFile(path.join(root, '404.html'));
        return route.fulfill({ status: 404, contentType: 'text/html', body });
      }
      return route.fulfill({ status: 404 });
    }
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return { context, google, unexpected, errors };
}

const banner = page => page.locator('#cookie-banner');
const dialog = page => page.locator('#cookie-dialog');
const language = page => page.locator('#cookie-preferences');
const analytics = page => page.locator('#cookie-analytics');
const decision = page => page.evaluate(() => window.pixkitPreferences.getConsent());
const save = page => dialog(page).locator('[data-cookie-save]').click();
const cookieNames = async context => (await context.cookies(site)).map(cookie => cookie.name).sort();
const manage = page => page.locator('[data-cookie-manage]').filter({ visible: true }).first().click();
const waitForCollection = page => page.waitForRequest(request => request.url().startsWith(collect + '?'));

async function verifyLifecycle(browser) {
  const { context, google, unexpected, errors } = await fixture(browser);
  try {
    const page = await context.newPage();
    await page.goto(site + '/?lang=en');
    assert.ok(await banner(page).isVisible());
    assert.deepEqual(await cookieNames(context), []);
    assert.deepEqual(google, []);

    await manage(page);
    assert.ok(await dialog(page).isVisible());
    assert.equal(await language(page).isChecked(), false);
    assert.equal(await analytics(page).isChecked(), false);
    await language(page).check();
    await save(page);
    assert.deepEqual(await decision(page), { preferences: true, analytics: false });
    assert.deepEqual(await cookieNames(context), ['cookie_consent', 'site_language']);
    assert.deepEqual(google, []);

    await page.goto(site + '/contact/?lang=en&test=private#private', {
      referer: 'https://referrer.example.test/private-path?private=yes'
    });
    assert.equal(await banner(page).isVisible(), false);
    assert.deepEqual(google, []);
    await manage(page);
    await language(page).uncheck();
    await analytics(page).check();
    const [collection] = await Promise.all([waitForCollection(page), save(page)]);
    const payload = new URL(collection.url()).searchParams;
    assert.equal(payload.get('dl'), site + '/contact/');
    assert.equal(payload.get('dr'), 'https://referrer.example.test/');
    assert.deepEqual(await decision(page), { preferences: false, analytics: true });
    assert.deepEqual(await cookieNames(context), ['_ga', '_ga_Y3KP2PKKS3', 'cookie_consent']);
    assert.equal(google.filter(url => url === tag).length, 1);
    const commands = await page.locator('#pixkit-analytics-frame').evaluate(frame =>
      frame.contentWindow.dataLayer.map(command => Array.from(command)));
    assert.equal(new URL(page.url()).searchParams.get('test'), 'private');
    assert.equal(new URL(page.url()).hash, '#private');
    assert.deepEqual(commands.slice(0, 2), [
      ['consent', 'default', {
        ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied'
      }],
      ['consent', 'update', {
        ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted'
      }]
    ]);
    assert.equal(commands[3][2].allow_google_signals, false);
    assert.equal(commands[3][2].allow_ad_personalization_signals, false);

    const other = await context.newPage();
    await Promise.all([waitForCollection(other), other.goto(site + '/privacy/pix-graph.html')]);
    assert.deepEqual(await decision(other), { preferences: false, analytics: true });
    assert.equal(google.filter(url => url === tag).length, 2);

    const beforeWithdrawal = google.length;
    await manage(page);
    await analytics(page).uncheck();
    await Promise.all([page.waitForEvent('load'), other.waitForEvent('load'), save(page)]);
    assert.deepEqual(await decision(page), { preferences: false, analytics: false });
    assert.deepEqual(await decision(other), { preferences: false, analytics: false });
    assert.deepEqual(await cookieNames(context), ['cookie_consent']);
    assert.equal(await other.locator('#pixkit-analytics-frame').count(), 0);
    assert.equal(google.length, beforeWithdrawal);

    await page.goto(site + '/fr/?lang=fr');
    assert.equal(await page.locator('html').getAttribute('lang'), 'fr');
    assert.equal(await banner(page).isVisible(), false);
    assert.equal(google.length, beforeWithdrawal);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function verifyLegacyAndPreview(browser) {
  const { context, google, unexpected, errors } = await fixture(browser);
  try {
    await context.addCookies([
      { name: 'cookie_consent', value: 'v1%3Aaccept', url: site },
      { name: 'site_language', value: 'fr', url: site }
    ]);
    const page = await context.newPage();
    await page.goto(site + '/fr/contact/');
    assert.deepEqual(await decision(page), { preferences: true, analytics: false });
    assert.ok(await banner(page).isVisible());
    assert.deepEqual(google, []);
    await banner(page).locator('[data-cookie-reject]').click();
    assert.deepEqual(await decision(page), { preferences: false, analytics: false });
    assert.deepEqual(await cookieNames(context), ['cookie_consent']);

    await page.goto(preview + '/?lang=en');
    await banner(page).locator('[data-cookie-accept]').click();
    assert.deepEqual(await decision(page), { preferences: true, analytics: true });
    assert.equal(await page.locator('#pixkit-analytics-frame').count(), 0);
    assert.deepEqual(google, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function verifyLocalizedLayout(browser) {
  const { context, google, unexpected, errors } = await fixture(browser);
  try {
    const page = await context.newPage();
    const locales = require('../data/i18n/locales.json');
    for (const { code } of locales) {
      for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        const prefix = code === 'en' ? '' : '/' + code;
        await page.goto(site + prefix + '/?lang=' + code);
        assert.ok(await banner(page).isVisible(), code);
        await manage(page);
        assert.ok(await dialog(page).isVisible(), code);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, code);
        await analytics(page).scrollIntoViewIfNeeded();
        assert.ok(await analytics(page).isVisible(), code);
        await dialog(page).locator('[data-cookie-close]').click();
      }
    }
    assert.deepEqual(google, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function verifyFooterControls(browser) {
  const { context, google, unexpected, errors } = await fixture(browser);
  try {
    await context.addCookies([{ name: 'cookie_consent', value: 'v2:0:0', url: site }]);
    const page = await context.newPage();
    const locales = require('../data/i18n/locales.json');
    for (const { code } of locales) {
      const prefix = code === 'en' ? '' : '/' + code;
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(site + prefix + '/contact/?lang=' + code);
        const footer = page.locator('footer.footer');
        for (const route of ['/platform-privacy/', '/terms-of-use/', '/cookie-policy/']) {
          const link = footer.locator(`a[href*="${route}"]`);
          assert.equal(await link.count(), 1, `${code}: ${route}`);
          assert.equal(new URL(await link.getAttribute('href'), site).pathname, prefix + route);
          assert.ok(await link.isVisible(), `${code}: visible ${route}`);
          const box = await link.boundingBox();
          assert.ok(box.height >= 44, `${code}: footer touch target`);
        }
        assert.equal(await page.locator('.contact-policy-panel').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, code);
        await footer.locator('[data-cookie-manage]').click();
        assert.ok(await dialog(page).isVisible(), `${code}: footer opens cookie settings`);
        await dialog(page).locator('[data-cookie-close]').click();
      }
    }
    await page.goto(site + '/privacy/pix-graph.html');
    assert.ok(await page.locator('footer.footer a[href="/platform-privacy/"]').isVisible());
    await page.locator('footer.footer [data-cookie-manage]').click();
    assert.ok(await dialog(page).isVisible());
    await page.goto(site + '/cookie-policy/#cookie-preferences');
    assert.ok(await dialog(page).isVisible(), 'Safe cookie-settings links open the preferences dialog');
    assert.deepEqual(google, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function verifyRealTag(browser, file) {
  const { context, google, unexpected, errors } = await fixture(browser, {}, await fs.readFile(file));
  try {
    const page = await context.newPage();
    await page.goto(site + '/?lang=en&probe=private-query#private-fragment', {
      referer: 'https://referrer.example.test/private-path?probe=private-referrer'
    });
    assert.deepEqual(google, []);
    const [request] = await Promise.all([
      page.waitForRequest(request => isCollection(new URL(request.url()))),
      banner(page).locator('[data-cookie-accept]').click()
    ]);
    const payload = new URL(request.url()).searchParams;
    assert.equal(payload.get('tid'), 'G-Y3KP2PKKS3');
    assert.equal(payload.get('en'), 'page_view');
    assert.equal(payload.get('dl'), site + '/');
    assert.equal(payload.get('dr'), 'https://referrer.example.test/');
    assert.doesNotMatch(request.url() + (request.postData() || ''), /private-(query|fragment|path|referrer)/);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

(async () => {
  for (const browserType of [chromium, firefox]) {
    const browser = await browserType.launch({
      headless: true,
      executablePath: browserType === chromium ? process.env.BROWSER_CHROMIUM_EXECUTABLE : undefined
    });
    try {
      const realTag = process.env.PIXKIT_GOOGLE_TAG_FILE;
      if (realTag) await verifyRealTag(browser, realTag);
      await verifyLifecycle(browser);
      await verifyLegacyAndPreview(browser);
      if (browserType === chromium) {
        await verifyLocalizedLayout(browser);
        await verifyFooterControls(browser);
      }
      console.log(`PASS ${browserType.name()}: consent lifecycle, legacy choices, request privacy, cookie withdrawal and preview isolation`);
    } finally {
      await browser.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
