'use strict';
(() => {
  const configNode = document.querySelector('#locale-config');
  if (!configNode) return;
  const config = JSON.parse(configNode.textContent);
  const supported = new Set(config.locales.map((locale) => locale.code));
  const current = document.documentElement.dataset.locale;
  const route = document.documentElement.dataset.route;
  const preferenceKey = 'pixkit.language.v1';
  const cacheKey = 'pixkit.auto-language.v1';
  const query = new URLSearchParams(location.search);
  let manual = false;
  let interacted = false;
  let sequence = 0;
  const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
  const write = (storage, key, value) => { try { storage.setItem(key, value); } catch { /* Private browsing still works via the URL. */ } };
  const remove = (storage, key) => { try { storage.removeItem(key); } catch { /* Optional persistence. */ } };
  // Accessing a storage object itself can fail in restricted browsing contexts.
  let persistent = null, session = null;
  try { persistent = window.localStorage; } catch { /* Use URL choice. */ }
  try { session = window.sessionStorage; } catch { /* No cache. */ }

  function normalize(tag) {
    const value = String(tag || '').toLowerCase().replace(/_/g, '-');
    if (/^zh-(tw|hk|mo|hant)/.test(value)) return 'zh-tw';
    if (value.startsWith('zh')) return 'zh-cn';
    if (value.startsWith('pt-br')) return 'pt-br';
    if (value === 'in' || value.startsWith('in-')) return 'id';
    const base = value.split('-')[0];
    return supported.has(base) ? base : null;
  }
  const preferred = (navigator.languages?.length ? navigator.languages : [navigator.language]).map(normalize).filter(Boolean);
  function fromCountry(country) {
    const groups = {
      fr: 'FR MC', ja: 'JP', de: 'DE AT LI', es: 'ES MX AR BO CL CO CR CU DO EC GT HN NI PA PE PR PY SV UY VE',
      it: 'IT SM VA', pt: 'PT AO MZ CV GW ST', 'pt-br': 'BR', nl: 'NL SR', pl: 'PL', ru: 'RU BY', uk: 'UA',
      'zh-cn': 'CN', 'zh-tw': 'TW HK MO', ko: 'KR', ar: 'SA AE BH EG IQ JO KW LB LY OM PS QA SY YE DZ',
      hi: 'IN', id: 'ID', tr: 'TR', en: 'US GB AU NZ IE'
    };
    const multilingual = { CH: ['de','fr','it'], BE: ['nl','fr','de'], CA: ['en','fr'], LU: ['fr','de'],
      SG: ['en','zh-cn'], MY: ['en','zh-cn'], MA: ['ar','fr'], TN: ['ar','fr'], IN: ['hi','en'], ZA: ['en'] };
    if (multilingual[country]) return preferred.find((lang) => multilingual[country].includes(lang)) || multilingual[country][0];
    for (const [lang, codes] of Object.entries(groups)) if (codes.split(' ').includes(country)) return lang;
    return preferred[0] || 'en';
  }
  function destination(lang, explicit = false) {
    const url = new URL(location.href);
    url.pathname = (lang === 'en' ? '' : '/' + lang) + route;
    url.searchParams.delete('lang');
    if (explicit && lang === 'en') url.searchParams.set('lang', 'en');
    return url;
  }
  function navigate(lang, explicit = false) {
    if (!supported.has(lang)) return;
    if (lang !== current) location.replace(destination(lang, explicit).href);
  }
  function setMode(auto) {
    const label = document.querySelector('[data-language-mode]');
    if (label) label.hidden = !auto;
  }
  for (const link of document.querySelectorAll('[data-locale-choice]')) {
    link.href = destination(link.dataset.localeChoice, true).href;
    link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      manual = true; sequence++;
      write(persistent, preferenceKey, link.dataset.localeChoice);
      setMode(false);
    });
  }
  for (const event of ['pointerdown','keydown','touchstart']) {
    document.addEventListener(event, () => { interacted = true; }, { once: true, passive: true });
  }
  async function detect(force = false) {
    const ticket = ++sequence;
    setMode(true);
    let cached = null;
    try { cached = JSON.parse(read(session, cacheKey)); } catch { /* Invalid cache is ignored. */ }
    if (!force && cached && supported.has(cached.language) && Date.now() - cached.time < 3600000) {
      navigate(cached.language); return;
    }
    let lang = preferred[0] || 'en';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2200);
    try {
      const response = await fetch('https://api.country.is/', { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      if (response.ok) {
        const result = await response.json();
        if (typeof result.country === 'string' && /^[A-Z]{2}$/.test(result.country)) lang = fromCountry(result.country);
      }
    } catch { /* Blocked lookup, offline, or timeout: use the browser language. */ }
    finally { clearTimeout(timeout); }
    // Do not override a manual choice or move a visitor after they start interacting.
    if (ticket !== sequence || manual || (!force && interacted)) return;
    write(session, cacheKey, JSON.stringify({ language: lang, time: Date.now() }));
    navigate(lang);
  }
  const automaticButton = document.querySelector('[data-language-auto]');
  if (automaticButton) {
    automaticButton.hidden = false;
    automaticButton.addEventListener('click', () => {
      manual = false; remove(persistent, preferenceKey); remove(session, cacheKey);
      document.querySelector('.language-picker')?.removeAttribute('open');
      void detect(true);
    });
  }
  const explicit = normalize(query.get('lang'));
  if (explicit) {
    manual = true; write(persistent, preferenceKey, explicit); setMode(false); navigate(explicit, true); return;
  }
  // A shared localized URL always keeps its explicit language, including search landings.
  if (current !== 'en') { setMode(!read(persistent, preferenceKey)); return; }
  const stored = read(persistent, preferenceKey);
  if (supported.has(stored)) { manual = true; setMode(false); navigate(stored); return; }
  // Leave static content stable for crawlers. Every language has a real URL and hreflang.
  if (/bot|crawler|spider|slurp|bingpreview/i.test(navigator.userAgent || '')) return;
  // Do not redirect the custom 404 to another missing URL.
  if (route === '/404.html') return;
  void detect();
})();
