/* Dependency-free behavioral tests for language routing and privacy fallbacks. */
'use strict';
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = resolve(__dirname, '..');
const source = readFileSync(resolve(root, 'assets/js/language.js'), 'utf8');
const locales = JSON.parse(readFileSync(resolve(root, 'data/i18n/locales.json'), 'utf8'));
const PREF = 'pixkit.language.v1', CACHE = 'pixkit.auto-language.v1';
const storage = (initial = {}) => ({
  data: new Map(Object.entries(initial)),
  getItem(key) { return this.data.get(key) ?? null; },
  setItem(key, value) { this.data.set(key, String(value)); },
  removeItem(key) { this.data.delete(key); }
});
const element = (props = {}) => ({
  hidden: true, listeners: {}, ...props,
  addEventListener(type, callback) { this.listeners[type] = callback; },
  removeAttribute() {},
  click(event = {}) { this.listeners.click?.(event); }
});

function boot(options = {}) {
  const current = options.current || 'en';
  const route = options.route || '/apps/pix-graph/';
  const url = new URL(`https://pix-kit.com${current === 'en' ? '' : '/' + current}${route}${options.suffix || ''}`);
  const location = { href: url.href, search: url.search, redirects: [], replace(value) { this.redirects.push(value); } };
  const persistent = storage(options.stored ? { [PREF]: options.stored } : {});
  const session = storage(options.cache ? { [CACHE]: options.cache } : {});
  const choices = locales.map(l => element({ dataset: { localeChoice: l.code } }));
  const mode = element(), auto = element(), picker = element();
  const document = {
    documentElement: { dataset: { locale: current, route } }, listeners: {},
    querySelector(selector) {
      return { '#locale-config': { textContent: JSON.stringify({locales}) }, '[data-language-mode]': mode,
        '[data-language-auto]': auto, '.language-picker': picker }[selector] || null;
    },
    querySelectorAll: () => choices,
    addEventListener(type, callback) { this.listeners[type] = callback; }
  };
  const window = { localStorage: persistent, sessionStorage: session };
  if (options.blockStorage) {
    for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(window, key, { get() { throw new Error('Storage blocked'); } });
  }
  let complete, calls = [];
  const timers = new Map();
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (options.network === 'offline') throw new Error('Offline');
    if (options.network === 'pending') return new Promise((yes, no) => {
      complete = country => yes({ ok: true, json: async () => ({ country }) });
      init.signal.addEventListener('abort', () => no(new Error('Aborted')));
    });
    return { ok: options.ok !== false, json: async () => ({country: options.country || 'FR', ip: '203.0.113.1'}) };
  };
  vm.runInNewContext(source, {
    document, window, location, navigator: { languages: options.languages || ['en-US'], language: options.language || 'en-US', userAgent: options.ua || 'Browser' },
    URL, URLSearchParams, AbortController, fetch,
    setTimeout: (fn, delay) => { const id = timers.size + 1; timers.set(id, {fn, delay}); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { location, persistent, session, choices, mode, auto, document, calls, timers, complete: country => complete(country) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function redirected(state, language, route = '/apps/pix-graph/') {
  assert.equal(state.location.redirects.length, language === 'en' ? 0 : 1);
  if (language !== 'en') assert.equal(new URL(state.location.redirects[0]).pathname, `/${language}${route}`);
}

(async () => {
  let cases = 0;
  const countries = { FR: 'fr', JP: 'ja', DE: 'de', ES: 'es', IT: 'it', PT: 'pt', BR: 'pt-br', NL: 'nl', PL: 'pl', RU: 'ru', UA: 'uk', CN: 'zh-cn', TW: 'zh-tw', KR: 'ko', EG: 'ar', IN: 'hi', ID: 'id', TR: 'tr', US: 'en' };
  for (const [country, language] of Object.entries(countries)) {
    const state = boot({country, languages:['xx']}); await settle(); redirected(state, language);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].init.credentials, 'omit');
    assert.equal(state.calls[0].init.referrerPolicy, 'no-referrer');
    const cached = JSON.parse(state.session.getItem(CACHE));
    assert.deepEqual(Object.keys(cached).sort(), ['language','time']);
    assert.equal(cached.language, language); cases++;
  }
  for (const [country, languages, expected] of [['CA',['fr-CA'],'fr'], ['CH',['it-CH'],'it'], ['BE',['de-BE'],'de'], ['IN',['en-IN'],'en'], ['SG',['zh-SG'],'zh-cn'], ['ZZ',['uk-UA'],'uk']]) {
    const state=boot({country,languages});await settle();redirected(state,expected);cases++;
  }
  for (const [browser, expected] of [['pt-BR','pt-br'],['pt-PT','pt'],['zh-Hant-HK','zh-tw'],['zh-Hans-CN','zh-cn'],['in-ID','id'],['ar-SA','ar'],['unsupported','en']]) {
    const state = boot({network:'offline',languages:[browser]});await settle();redirected(state,expected);cases++;
  }
  let state = boot({stored:'ja', country:'FR'});await settle();redirected(state,'ja');assert.equal(state.calls.length,0);cases++;
  state = boot({suffix:'?lang=en', stored:'ja'});await settle();redirected(state,'en');assert.equal(state.persistent.getItem(PREF),'en');assert.equal(state.calls.length,0);cases++;
  state = boot({current:'fr', stored:'ja'});await settle();assert.equal(state.location.redirects.length,0);assert.equal(state.calls.length,0);cases++;
  state = boot({cache:JSON.stringify({language:'pl',time:Date.now()})});await settle();redirected(state,'pl');assert.equal(state.calls.length,0);cases++;
  for (const cache of ['broken json',JSON.stringify({language:'pl',time:Date.now()-3600001}),JSON.stringify({language:'xx',time:Date.now()})]) {
    state=boot({cache,country:'TR'});await settle();redirected(state,'tr');assert.equal(state.calls.length,1);cases++;
  }
  state = boot({blockStorage:true,country:'JP'});await settle();redirected(state,'ja');cases++;
  state = boot({network:'pending',languages:['fr']});assert.equal([...state.timers.values()][0].delay,2200);[...state.timers.values()][0].fn();await settle();redirected(state,'fr');cases++;
  state = boot({network:'pending'});state.choices.find(l=>l.dataset.localeChoice==='de').click();state.complete('JP');await settle();assert.equal(state.location.redirects.length,0);assert.equal(state.persistent.getItem(PREF),'de');cases++;
  state = boot({network:'pending'});state.document.listeners.pointerdown();state.complete('JP');await settle();assert.equal(state.location.redirects.length,0);cases++;
  state = boot({current:'fr',stored:'fr',country:'JP'});state.auto.click();await settle();redirected(state,'ja');assert.equal(state.persistent.getItem(PREF),null);cases++;
  state = boot({current:'fr',suffix:'?letters=off&app=pix-graph#details'});await settle();
  const english = new URL(state.choices.find(l=>l.dataset.localeChoice==='en').href);
  assert.equal(english.pathname,'/apps/pix-graph/');assert.equal(english.searchParams.get('letters'),'off');assert.equal(english.searchParams.get('lang'),'en');assert.equal(english.hash,'#details');cases++;
  for (const options of [{ua:'Googlebot'},{route:'/404.html'}]) {
    state=boot(options);await settle();assert.equal(state.calls.length,0);assert.equal(state.location.redirects.length,0);cases++;
  }
  state=boot({network:'offline',languages:[],language:'fr-FR'});await settle();redirected(state,'fr');cases++;
  console.log(`PASS: ${cases} language scenarios including countries, multilingual regions, manual choice, localized URLs, timeout, offline, blocked storage, caching, crawlers and interaction races.`);
})().catch(error => { console.error(error); process.exitCode=1; });
