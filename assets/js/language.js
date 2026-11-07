'use strict';
(() => {
  let config;
  try { config = JSON.parse(document.querySelector('#locale-config').textContent); } catch { return; }
  if (!Array.isArray(config.locales)) return;
  const supported = new Set(config.locales.map(locale => locale.code));
  const current = document.documentElement.dataset.locale;
  const route = document.documentElement.dataset.route;
  if (!supported.has(current) || !route?.startsWith('/')) return;
  const preferences = window.pixkitPreferences;
  const query = new URLSearchParams(location.search);
  const cleanBase = value => typeof value === 'string' &&
    (value === '' || (value.startsWith('/') && !value.startsWith('//'))) &&
    !/[?#\\]/.test(value) && !value.split('/').some(part => part === '..' || part === '.')
      ? value.replace(/\/+$/, '') : null;
  const configuredBase = cleanBase(config.basePath);
  const pathname = new URL(location.href).pathname.replace(/\/index\.html$/, '/');
  const pageSuffix = (current === 'en' ? '' : '/' + current) + route;
  const inferredBase = pathname.endsWith(pageSuffix) ? pathname.slice(0, -pageSuffix.length) : '';
  const basePath = configuredBase === null ? inferredBase : configuredBase;
  function normalize(tag) {
    const value = String(tag || '').toLowerCase().replace(/_/g, '-');
    if (/^zh-(tw|hk|mo|hant)/.test(value)) return 'zh-tw';
    if (value.startsWith('zh')) return 'zh-cn';
    if (value.startsWith('pt-br')) return 'pt-br';
    if (value === 'in' || value.startsWith('in-')) return 'id';
    const base = value.split('-')[0];
    return supported.has(base) ? base : null;
  }
  function destination(lang, explicit = false) {
    const url = new URL(location.href);
    url.pathname = basePath + (lang === 'en' ? '' : '/' + lang) + route;
    url.searchParams.delete('lang');
    // Keep explicit choices in every language URL, including with storage blocked.
    if (explicit) url.searchParams.set('lang', lang);
    return url;
  }
  function navigate(lang, explicit = false) {
    if (supported.has(lang) && lang !== current) {
      document.documentElement.dataset.languageRedirecting = 'true';
      location.replace(destination(lang, explicit).href);
    }
  }
  function setMode(auto) {
    const label = document.querySelector('[data-language-mode]');
    if (label) label.hidden = !auto;
  }
  const preferred = (navigator.languages?.length ? navigator.languages : [navigator.language]).map(normalize).filter(Boolean);
  function detect() {
    setMode(true);
    navigate(preferred[0] || 'en');
  }
  for (const link of document.querySelectorAll('[data-locale-choice]')) {
    const lang = link.dataset.localeChoice;
    if (!supported.has(lang)) continue;
    link.href = destination(lang, true).href;
    link.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
      preferences?.setLanguage(lang);
      setMode(false);
    });
  }
  const automaticButton = document.querySelector('[data-language-auto]');
  if (automaticButton) {
    automaticButton.hidden = false;
    automaticButton.addEventListener('click', () => {
      preferences?.clearLanguage();
      document.querySelector('.language-picker')?.removeAttribute('open');
      const target = preferred[0] || 'en';
      // Clear stale ?lang even when automatic mode selects the current edition.
      if (target === current && query.has('lang')) {
        const url = destination(current);
        window.history?.replaceState?.(null, '', url.href);
        for (const link of document.querySelectorAll('a[href]')) {
          if (link.dataset?.localeChoice) continue;
          const internal = new URL(link.href, location.href);
          if (internal.origin === url.origin && internal.pathname.startsWith(basePath + '/') && internal.pathname.endsWith('/')) {
            internal.searchParams.delete('lang');
            link.href = internal.href;
          }
        }
      }
      detect();
    });
  }
  // A crawler always sees the static edition for the URL it requested.
  if (/bot|crawler|spider|slurp|bingpreview/i.test(navigator.userAgent || '') || route === '/404.html') return;
  const explicit = normalize(query.get('lang'));
  if (explicit === current) {
    // URL state keeps an intentional edition through navigation even when both
    // cookies and sessionStorage are unavailable. Language-switch links keep
    // their own explicit destination.
    for (const link of document.querySelectorAll('a[href]')) {
      if (link.dataset?.localeChoice) continue;
      const url = new URL(link.href, location.href);
      if (url.origin === new URL(location.href).origin && url.pathname.startsWith(basePath + '/') && url.pathname.endsWith('/')) {
        url.searchParams.set('lang', current);
        link.href = url.href;
      }
    }
  }
  if (explicit) {
    preferences?.setLanguage(explicit);
    setMode(false);
    navigate(explicit, true);
    return;
  }
  const stored = preferences?.getLanguage();
  // Localized URLs, including search landings, retain the edition they name.
  if (current !== 'en') { setMode(stored !== current); return; }
  if (supported.has(stored)) { setMode(false); navigate(stored); return; }
  // Only the unlocalized home entry automatically selects a browser language.
  if (route !== '/') { setMode(false); return; }
  detect();
})();
