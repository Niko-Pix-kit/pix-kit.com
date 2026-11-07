'use strict';
// Real layout checks: the runtime DOM fixture cannot detect a shrinking media box.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium, firefox} = require('playwright');
const root = path.resolve(__dirname, '..');
const artifacts = process.env.BROWSER_TEST_ARTIFACTS;
const mime = {'.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.json':'application/json',
  '.webp':'image/webp', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml'};
const server = http.createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = path.resolve(root, '.' + pathname);
    if ((file !== root && !file.startsWith(root + path.sep)) || pathname.split('/').some(part => part.startsWith('.'))) {
      response.writeHead(403); response.end(); return;
    }
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    response.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(response);
  } catch {response.writeHead(404); response.end();}
});

async function inspect(page, galleryIndex, slideIndex) {
  await page.waitForFunction(({galleryIndex, slideIndex}) => {
    const gallery = document.querySelectorAll('[data-gallery]')[galleryIndex];
    const track = gallery.querySelector('.gallery-track');
    const slide = track.querySelectorAll('.slide')[slideIndex];
    const image = slide.querySelector('img');
    return gallery.querySelector('[data-status]').textContent.startsWith(`${slideIndex + 1} /`)
      && Math.abs(track.scrollLeft - slideIndex * track.clientWidth) < 1
      && image.complete && image.naturalWidth > 0;
  }, {galleryIndex, slideIndex}, {timeout: 10000});
  const geometry = await page.locator('[data-gallery]').nth(galleryIndex).evaluate((gallery, slideIndex) => {
    const track = gallery.querySelector('.gallery-track');
    const slide = track.querySelectorAll('.slide')[slideIndex];
    const media = slide.querySelector('.slide-media'), image = slide.querySelector('img');
    const box = element => {
      const r = element.getBoundingClientRect();
      return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height};
    };
    return {track:box(track), media:box(media), image:box(image), objectFit:getComputedStyle(image).objectFit,
      objectPosition:getComputedStyle(image).objectPosition, viewportHeight:innerHeight,
      detail:Boolean(gallery.closest('.detail-hero'))};
  }, slideIndex);
  const center = rect => (rect.left + rect.right) / 2;
  assert.ok(Math.abs(geometry.media.width - geometry.track.width) < 2,
    `media must fill the slide width: ${JSON.stringify(geometry)}`);
  assert.ok(Math.abs(center(geometry.media) - center(geometry.track)) < 2, 'media frame must stay centered');
  assert.ok(Math.abs(center(geometry.image) - center(geometry.track)) < 2, 'image must stay centered in the track');
  assert.ok(geometry.image.top >= geometry.media.top - 1 && geometry.image.bottom <= geometry.media.bottom + 1,
    'image must remain inside the capped media frame');
  assert.ok(geometry.media.height <= Math.min(geometry.detail ? 680 : 620,
    geometry.viewportHeight * (geometry.detail ? 0.72 : 0.70)) + 2, 'existing height cap must be preserved');
  assert.equal(geometry.objectFit, 'contain', 'preserve the entire image without stretching or cropping');
  assert.equal(geometry.objectPosition, '50% 50%', 'paint the contained image at the frame center');
}

async function check(browserType, viewport, base, rtl = false, rotate = false) {
  const browser = await browserType.launch({headless:true});
  let page;
  const name = `${browserType.name()}-${viewport.width}${rtl ? '-rtl' : ''}`;
  try {
    const context = await browser.newContext({viewport, reducedMotion:'reduce', locale:'en-US'});
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const [pageIndex, route] of ['/', '/apps/pix-graph/', '/apps/pix-moments/'].entries()) {
      await page.setViewportSize(viewport);
      await page.goto(base + (rtl ? '/ar' : '') + route + (rtl ? '?lang=ar' : '?lang=en'), {waitUntil:'networkidle'});
      const reject = page.locator('#cookie-banner [data-cookie-reject]');
      if (await reject.isVisible()) await reject.click();
      const galleries = page.locator('[data-gallery]');
      assert.equal(await galleries.count(), pageIndex === 0 ? 2 : 1);
      for (let galleryIndex = 0; galleryIndex < await galleries.count(); galleryIndex++) {
        const gallery = galleries.nth(galleryIndex);
        await gallery.scrollIntoViewIfNeeded();
        await inspect(page, galleryIndex, 0);
        await gallery.locator('[data-next]').click();
        await inspect(page, galleryIndex, 1);
        if (artifacts) {
          fs.mkdirSync(artifacts, {recursive:true});
          await gallery.screenshot({path:path.join(artifacts, `${name}-page${pageIndex}-gallery${galleryIndex}.png`)});
        }
      }
      if (rotate && pageIndex === 0) {
        await page.setViewportSize({width:844, height:390});
        for (let galleryIndex = 0; galleryIndex < await galleries.count(); galleryIndex++) await inspect(page, galleryIndex, 1);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false,
        'document must not overflow horizontally');
    }
    assert.deepEqual(errors, [], 'no runtime errors');
    console.log(`PASS ${name}: centered landscape/portrait frames on homepage and details, proportions, height caps${rotate ? ', phone rotation' : ''}`);
    await context.close();
  } catch (error) {
    if (page && artifacts) {
      fs.mkdirSync(artifacts, {recursive:true});
      await page.screenshot({path:path.join(artifacts, `${name}-failure.png`), fullPage:true}).catch(() => {});
      fs.writeFileSync(path.join(artifacts, `${name}-failure.html`), await page.content());
    }
    throw error;
  } finally {await browser.close();}
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/assets/css/site.css')).status, 200);
    if (process.argv.includes('--server-check')) {console.log('PASS browser-test HTTP server'); return;}
    await check(firefox, {width:1730, height:1200}, base);
    await check(chromium, {width:1440, height:1000}, base);
    await check(chromium, {width:390, height:844}, base, false, true);
    await check(firefox, {width:390, height:844}, base, true);
  } finally {await new Promise(resolve => server.close(resolve));}
})().catch(error => {console.error(error); process.exitCode = 1;});
