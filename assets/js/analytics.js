'use strict';
(() => {
  // This public destination identifier is not a credential. No API secret is used.
  const ID = 'G-Y3KP2PKKS3';
  const DISABLED = 'ga-disable-' + ID;
  const DOMAIN = 'pix-kit.com';
  if (window.pixkitAnalytics) return;
  let analyticsFrame;
  window[DISABLED] = true;

  function clearCookies() {
    for (const name of ['_ga', '_ga_' + ID.slice(2).replace(/-/g, '_')]) {
      for (const domain of ['', '; Domain=' + DOMAIN, '; Domain=.' + DOMAIN,
        '; Domain=' + location.hostname]) {
        try {
          document.cookie = `${name}=; Max-Age=0; Path=/${domain}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
        } catch { /* The browser may block cookie access. */ }
      }
    }
  }

  function referrerOrigin() {
    try {
      const referrer = new URL(document.referrer);
      return ['https:', 'http:'].includes(referrer.protocol) ? referrer.origin + '/' : '';
    } catch { return ''; }
  }

  function canonicalPage() {
    try {
      const url = new URL(document.querySelector('link[rel="canonical"]').href);
      if (url.protocol !== 'https:' || url.hostname !== DOMAIN) return null;
      return url.origin + url.pathname;
    } catch { return null; }
  }

  function hasAnalyticsConsent() {
    return window.pixkitPreferences?.getConsent()?.analytics === true;
  }

  function startTag(frame, page) {
    if (analyticsFrame !== frame || !hasAnalyticsConsent()) return;
    const target = frame.contentWindow;
    const referrer = referrerOrigin();
    const cleanUrl = location.origin + new URL(page).pathname;
    try {
      // The Google tag can read browser fields independently of its config.
      // Give it a blank document with a clean address and an origin-only referrer.
      target.document.open();
      target.document.write('<!doctype html><html><head></head><body></body></html>');
      target.document.close();
      target.history.replaceState(null, '', cleanUrl);
      Object.defineProperty(target.document, 'referrer', { value: referrer });
      target.document.title = document.title;
      if (target.location.href !== cleanUrl || target.document.referrer !== referrer) {
        throw new Error('Analytics document privacy setup failed.');
      }
    } catch {
      frame.remove();
      analyticsFrame = null;
      return;
    }

    target[DISABLED] = false;
    target.dataLayer = [];
    target.gtag = function () { target.dataLayer.push(arguments); };
    const denied = { ad_storage: 'denied', ad_user_data: 'denied',
      ad_personalization: 'denied', analytics_storage: 'denied' };
    target.gtag('consent', 'default', denied);
    target.gtag('consent', 'update', { ...denied, analytics_storage: 'granted' });
    target.gtag('js', new Date());
    target.gtag('config', ID, {
      page_location: page,
      page_referrer: referrer,
      page_title: document.title,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_domain: DOMAIN,
      cookie_path: '/',
      cookie_expires: 180 * 24 * 60 * 60,
      cookie_update: false,
      cookie_flags: 'SameSite=Lax;Secure',
      send_page_view: true
    });
    const script = target.document.createElement('script');
    script.id = 'pixkit-analytics-tag';
    script.async = true;
    script.referrerPolicy = 'origin';
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
    target.document.head.appendChild(script);
  }

  function applyConsent() {
    if (!hasAnalyticsConsent()) {
      const frame = analyticsFrame;
      analyticsFrame = null;
      if (frame) {
        const target = frame.contentWindow;
        if (target) target[DISABLED] = true;
        frame.remove();
      }
      clearCookies();
      // Reload after withdrawal to end the old document's measurement lifecycle.
      if (frame) location.reload();
      return;
    }

    const page = canonicalPage();
    if (analyticsFrame || !page || location.protocol !== 'https:' ||
        ![DOMAIN, 'www.' + DOMAIN].includes(location.hostname) ||
        document.documentElement.dataset.languageRedirecting === 'true') return;

    const frame = document.createElement('iframe');
    frame.id = 'pixkit-analytics-frame';
    frame.hidden = true;
    frame.referrerPolicy = 'origin';
    frame.srcdoc = '<!doctype html>';
    frame.addEventListener('load', () => startTag(frame, page), { once: true });
    analyticsFrame = frame;
    document.body.appendChild(frame);
  }

  window.pixkitAnalytics = { applyConsent };
  window.addEventListener('pixkit:consentchange', applyConsent);
  // Re-check a restored page: the consent cookie may have changed in another tab.
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  applyConsent();
})();
