'use strict';
(() => {
  const CONSENT = 'cookie_consent';
  const LANGUAGE = 'site_language';
  const SESSION_LANGUAGE = 'pixkit.session-language.v1';
  const SESSION_CONSENT = 'pixkit.session-consent.v1';
  const DECISION_SECONDS = 180 * 24 * 60 * 60;
  const LANGUAGE_SECONDS = 365 * 24 * 60 * 60;
  let supported = new Set();
  try {
    const config = JSON.parse(document.querySelector('#locale-config').textContent);
    supported = new Set(config.locales.map(locale => locale.code));
  } catch { /* An incomplete page must remain usable. */ }
  const validLanguage = value => supported.has(value) ? value : null;
  const sessionRead = key => { try { return window.sessionStorage.getItem(key); } catch { return null; } };
  const sessionWrite = (key, value) => { try { window.sessionStorage.setItem(key, value); } catch { /* Localized URLs still work. */ } };
  const sessionRemove = key => { try { window.sessionStorage.removeItem(key); } catch { /* Storage may be blocked. */ } };
  function readCookie(name) {
    try {
      const item = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
      return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
    } catch { return null; }
  }
  function writeCookie(name, value, seconds) {
    try {
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${seconds}; Path=/; SameSite=Lax${secure}`;
      return readCookie(name) === value;
    } catch { return false; }
  }
  function deleteCookie(name) { writeCookie(name, '', 0); }
  function parseDecision(value) {
    const current = /^v2:([01]):([01])$/.exec(value || '');
    if (current) return { version: 2, preferences: current[1] === '1', analytics: current[2] === '1' };
    // Language-only choices must never grant consent to a newly added purpose.
    if (value === 'v1:accept') return { version: 1, preferences: true, analytics: false };
    if (value === 'v1:reject') return { version: 1, preferences: false, analytics: false };
    return null;
  }
  function readDecision() {
    const saved = parseDecision(readCookie(CONSENT));
    if (saved) return saved;
    try {
      const fallback = JSON.parse(sessionRead(SESSION_CONSENT));
      if (fallback?.expires > Date.now()) return parseDecision(fallback.value);
    } catch { /* Expired or malformed session fallback. */ }
    return null;
  }
  let decision = readDecision();
  let consentChannel;
  try { consentChannel = new BroadcastChannel('pixkit-cookie-consent'); } catch { /* Focus rechecks consent. */ }
  // Earlier site versions wrote a persistent language choice without consent.
  // Remove it rather than carrying that behavior into the new consent model.
  try { window.localStorage.removeItem('pixkit.language.v1'); } catch { /* Restricted storage. */ }
  try { window.sessionStorage.removeItem('pixkit.auto-language.v1'); } catch { /* Retired location cache. */ }
  if (!decision?.preferences) deleteCookie(LANGUAGE);
  const banner = document.querySelector('#cookie-banner');
  const dialog = document.querySelector('#cookie-dialog');
  const checkbox = document.querySelector('#cookie-preferences');
  const analyticsCheckbox = document.querySelector('#cookie-analytics');
  let previousFocus = null;
  function reserveBannerSpace() {
    const height = banner && !banner.hidden ? Math.ceil(banner.getBoundingClientRect?.().height || 0) : 0;
    document.documentElement.style?.setProperty('--cookie-banner-height', height + 'px');
  }
  function focusMain() {
    const main = document.querySelector('main');
    if (!main) return;
    const tabindex = main.getAttribute('tabindex');
    if (tabindex === null) main.setAttribute('tabindex', '-1');
    main.focus({ preventScroll: true });
    if (tabindex === null) main.removeAttribute('tabindex');
  }
  function close(restoreFocus = true) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    if (restoreFocus) previousFocus?.focus?.();
    previousFocus = null;
  }
  function open() {
    if (!dialog) return;
    previousFocus = document.activeElement;
    if (checkbox) checkbox.checked = decision?.preferences === true;
    if (analyticsCheckbox) analyticsCheckbox.checked = decision?.analytics === true;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    checkbox?.focus?.();
  }
  function getLanguage() {
    return validLanguage(sessionRead(SESSION_LANGUAGE)) ||
      (decision?.preferences ? validLanguage(readCookie(LANGUAGE)) : null);
  }
  function setLanguage(value) {
    const lang = validLanguage(value);
    if (!lang) return;
    sessionWrite(SESSION_LANGUAGE, lang);
    if (decision?.preferences) writeCookie(LANGUAGE, lang, LANGUAGE_SECONDS);
  }
  function clearLanguage() {
    sessionRemove(SESSION_LANGUAGE);
    deleteCookie(LANGUAGE);
  }
  function notifyConsentChange() {
    window.dispatchEvent(new Event('pixkit:consentchange'));
  }
  function syncConsent() {
    const next = readDecision();
    if (next?.version === decision?.version && next?.preferences === decision?.preferences &&
        next?.analytics === decision?.analytics) return;
    decision = next;
    if (!decision?.preferences) deleteCookie(LANGUAGE);
    if (banner) banner.hidden = decision?.version === 2;
    if (dialog?.open) {
      if (checkbox) checkbox.checked = decision?.preferences === true;
      if (analyticsCheckbox) analyticsCheckbox.checked = decision?.analytics === true;
    }
    reserveBannerSpace();
    notifyConsentChange();
  }
  function setConsent(preferences, analytics = false) {
    // A choice hides the banner. Keep keyboard focus on a visible landmark,
    // including when the preferences dialog was opened from that banner.
    const focusWasInBanner = banner?.contains(document.activeElement) || banner?.contains(previousFocus);
    const selectedLanguage = getLanguage();
    decision = { version: 2, preferences: preferences === true, analytics: analytics === true };
    const value = `v2:${Number(decision.preferences)}:${Number(decision.analytics)}`;
    if (writeCookie(CONSENT, value, DECISION_SECONDS)) sessionRemove(SESSION_CONSENT);
    else sessionWrite(SESSION_CONSENT, JSON.stringify({ value, expires: Date.now() + DECISION_SECONDS * 1000 }));
    if (decision.preferences && selectedLanguage) writeCookie(LANGUAGE, selectedLanguage, LANGUAGE_SECONDS);
    else if (!decision.preferences) deleteCookie(LANGUAGE);
    if (banner) banner.hidden = true;
    reserveBannerSpace();
    close(!focusWasInBanner);
    if (focusWasInBanner) focusMain();
    notifyConsentChange();
    consentChannel?.postMessage(null);
  }
  consentChannel?.addEventListener('message', syncConsent);
  window.addEventListener('focus', syncConsent);
  window.pixkitPreferences = {
    getConsent: () => decision ? { preferences: decision.preferences, analytics: decision.analytics } : null,
    setConsent, getLanguage, setLanguage, clearLanguage, open
  };
  if (banner) banner.hidden = decision?.version === 2;
  reserveBannerSpace();
  if (banner && typeof ResizeObserver === 'function') new ResizeObserver(reserveBannerSpace).observe(banner);
  else window.addEventListener?.('resize', reserveBannerSpace);
  document.querySelectorAll('[data-cookie-accept]').forEach(button => button.addEventListener('click', () => setConsent(true, true)));
  document.querySelectorAll('[data-cookie-reject]').forEach(button => button.addEventListener('click', () => setConsent(false)));
  document.querySelectorAll('[data-cookie-manage]').forEach(button => button.addEventListener('click', open));
  document.querySelectorAll('[data-cookie-save]').forEach(button => button.addEventListener('click', () => setConsent(checkbox?.checked === true, analyticsCheckbox?.checked === true)));
  document.querySelectorAll('[data-cookie-close]').forEach(button => button.addEventListener('click', close));
  dialog?.addEventListener('cancel', event => { event.preventDefault(); close(); });
  if (location.hash === '#cookie-preferences') open();
})();
