import { readFileSync } from 'node:fs';
import messages from './messages.json' with { type: 'json' };
import locales from '../../data/i18n/locales.json' with { type: 'json' };
import { avatarPresets } from '../profile.mjs';

const canonicalLocale = locales[0];
const byCode = new Map(locales.map(locale => [locale.code, locale]));
const assetVersion = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
const versionedAsset = path => `${path}${path.includes('?') ? '&' : '?'}v=${encodeURIComponent(assetVersion)}`;
const siteKeys = {
  skip: '002',
  home: '241',
  navigation: '004',
  apps: '005',
  about: '006',
  contact: '007',
  privacy: '065',
  footer: '108',
  notFound: '222',
  language: '226',
  cookies: '248',
  terms: '307',
};

const siteMessages = new Map(locales.map(({ code }) => {
  const source = JSON.parse(readFileSync(new URL(`../../data/i18n/${code}.json`, import.meta.url), 'utf8'));
  return [code, Object.fromEntries(Object.entries(siteKeys).map(([key, id]) => [key, source[id]]))];
}));

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

export function portalLocale(code) {
  return byCode.get(code) ?? canonicalLocale;
}

export function messagesFor(locale) {
  const { code } = portalLocale(locale);
  return { ...siteMessages.get(code), ...messages[code] };
}

export function localPath(locale, path) {
  if (!/^\/(?!\/)/.test(path) || /[\\\p{Cc}]/u.test(path)) {
    throw new TypeError('A local route must begin with a single forward slash.');
  }
  const { code } = portalLocale(locale);
  return code === canonicalLocale.code ? path : `/${code}${path}`;
}

const iconPaths = {
  apps: '<path d="M2 2h8v8H2zM14 2h8v8h-8zM2 14h8v8H2z"/><path class="nav-icon-accent" d="M14 14h8v8h-8z"/>',
  about: '<path d="M4 5h16v13H4zM1 9h3m16 0h3M12 1v4"/><path class="nav-icon-accent" d="M8 10h1m6 0h1m-7 4h6"/>',
  contact: '<path d="M2 5h20v14H2z"/><path class="nav-icon-accent" d="m3 6 9 7 9-7"/>',
  tutorials: '<path d="M2 5h7l3 3 3-3h7v14h-7l-3 3-3-3H2zM12 8v14"/><path class="nav-icon-accent" d="M5 10h4m6 0h4M5 14h4m6 0h4"/>',
  community: '<path d="M2 3h16v10H9l-5 4v-4H2z"/><path class="nav-icon-accent" d="M18 8h4v10h-2v4l-5-4h-4v-3M6 8h8"/>',
  account: '<path d="M8 3h8v8H8z"/><path class="nav-icon-accent" d="M4 21v-4l4-3h8l4 3v4z"/>',
};

function navigationIcon(name) {
  return `<svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">${iconPaths[name]}</svg>`;
}

function accountIcon(profile) {
  let avatar = avatarPresets.find(({ url }) => url === profile?.avatarUrl)?.url;
  if (!avatar) {
    try {
      const url = new URL(profile?.avatarUrl);
      if (url.origin === 'https://lh3.googleusercontent.com' && !url.username && !url.password) {
        avatar = url.href;
      }
    } catch {
      // A missing or invalid avatar uses the built-in account icon.
    }
  }
  return avatar
    ? `<img class="nav-avatar" src="${escapeHtml(avatar)}" width="24" height="24" alt="" decoding="async" referrerpolicy="no-referrer">`
    : navigationIcon('account');
}

function navigation({ code, path, profile }) {
  const copy = messagesFor(code);
  const links = [
    [copy.apps, '/', path === '/' || path === '/index.html' || path.startsWith('/apps/'), 'apps'],
    [copy.about, '/about/', path.startsWith('/about/'), 'about'],
    [copy.contact, '/contact/', path.startsWith('/contact/'), 'contact'],
    [copy.tutorials, '/learn/', path.startsWith('/learn/') && path !== '/learn/progress/', 'tutorials'],
    [copy.community, '/community/', /^\/community(?:\/|$)/.test(path) || path === '/community-guidelines/', 'community'],
    ...(profile?.status === 'active' ? [[copy.progress, '/learn/progress/', path === '/learn/progress/', 'tutorials']] : []),
    [profile ? copy.account : copy.signIn, '/account/', path.startsWith('/account/'), 'account'],
  ];
  return `<nav class="nav-links nav-links-platform" aria-label="${escapeHtml(copy.navigation)}">${links.map(([label, href, current, icon]) => (
    `<a href="${escapeHtml(localPath(code, href))}"${current ? ' aria-current="page"' : ''}>${icon === 'account' ? accountIcon(profile) : navigationIcon(icon)}<span>${escapeHtml(label)}</span></a>`
  )).join('')}</nav>`;
}

const siteNavigation = /<nav class="nav-links"[^>]*>[\s\S]*?<\/nav>/;
const siteFooter = /<footer class="footer">[\s\S]*?<\/footer>/;
const siteHeader = /<header class="site-nav">[\s\S]*?<\/header>/;
const siteLanguage = /<div class="language-bar">.*<\/div>/;
const consentBanner = /<section id="cookie-banner"[\s\S]*?<\/section>/;
const consentDialog = /<dialog id="cookie-dialog"[\s\S]*?<\/dialog>/;
const consentConfig = /<script type="application\/json" id="locale-config">[^<]*<\/script>/;
const chromeByLocale = new Map();

function getSiteChrome(code) {
  if (!chromeByLocale.has(code)) {
    const homepage = readFileSync(new URL(`../..${localPath(code, '/index.html')}`, import.meta.url), 'utf8');
    const fragment = (pattern) => {
      const result = homepage.match(pattern)?.[0];
      if (!result) throw new Error('Build the localized site before starting the member platform.');
      return result;
    };
    chromeByLocale.set(code, {
      header: fragment(siteHeader), footer: fragment(siteFooter), language: fragment(siteLanguage),
      consent: fragment(consentBanner) + fragment(consentDialog), config: fragment(consentConfig),
    });
  }
  return chromeByLocale.get(code);
}

function header({ code, path, profile }) {
  return getSiteChrome(code).header.replace(siteNavigation, () => navigation({ code, path, profile }))
    .replace('<span data-brand-letters>Pix-kit</span>',
      '<span><span class="brand-p">P</span>ix-<span class="brand-k">k</span>it</span>');
}

function footer({ code, profile }) {
  const base = getSiteChrome(code).footer;
  if (!profile) return base;
  const guidelines = localPath(code, '/community-guidelines/');
  return base.replace('</nav>', () =>
    `<a href="${escapeHtml(guidelines)}">${escapeHtml(messagesFor(code).guidelines)}</a></nav>`);
}

/** Use the same navigation and footer on generated public and server-rendered pages. */
export function applySiteChrome(html, { locale, path, profile }) {
  if (!siteHeader.test(html)) return html;
  const options = { code: portalLocale(locale).code, path, profile };
  return html.replace(siteHeader, () => header(options)).replace(siteFooter, () => footer(options));
}

/** Render the site chrome around trusted HTML from a portal page renderer. */
export function renderShell({
  locale, path, profile, title, body, stylesheet, script, noindex = false, analytics = true,
}) {
  const { code, tag, dir } = portalLocale(locale);
  const copy = messagesFor(code);
  const chrome = getSiteChrome(code);
  const language = chrome.language.replace(/href="[^"]*" data-locale-choice="([^"]*)"/g, (_, target) =>
    `href="${escapeHtml(localPath(target, path))}?lang=${encodeURIComponent(target)}" data-locale-choice="${target}"`);
  const pageFooter = analytics ? footer({ code, profile }) : footer({ code, profile }).replace(
    /<button type="button" data-cookie-manage>([\s\S]*?)<\/button>/,
    `<a href="${escapeHtml(localPath(code, '/cookie-policy/'))}#cookie-preferences">$1</a>`,
  );
  return `<!doctype html>
<html lang="${escapeHtml(tag)}" dir="${dir === 'rtl' ? 'rtl' : 'ltr'}" data-locale="${escapeHtml(code)}" data-route="${escapeHtml(path)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | Pix-kit</title>
  ${noindex ? '<meta name="robots" content="noindex, follow">' : ''}
  <link rel="icon" type="image/png" href="/assets/pix-kit-logo-symbol.png">
  <link rel="stylesheet" href="${versionedAsset('/assets/css/site.css')}">
  <link rel="stylesheet" href="${versionedAsset('/assets/css/letter-colors.css')}">
  <link rel="stylesheet" href="${versionedAsset('/assets/css/consent.css')}">
  <link rel="stylesheet" href="${versionedAsset('/_platform/member/member.css')}">
  ${stylesheet ? `<link rel="stylesheet" href="${escapeHtml(versionedAsset(stylesheet))}">` : ''}
  ${analytics ? `${chrome.config}
  <script src="${versionedAsset('/assets/js/consent.js')}" defer></script>
  <script src="${versionedAsset('/assets/js/language.js')}" defer></script>
  <script src="${versionedAsset('/assets/js/letter-colors.js')}" defer></script>` : ''}
  ${script ? `<script type="module" src="${escapeHtml(versionedAsset(script))}"></script>` : ''}
</head>
<body${profile?.id ? ` data-account-id="${escapeHtml(profile.id)}"` : ''}>
  <a class="skip-link portal-skip" href="#main">${escapeHtml(copy.skip)}</a>
  ${header({ code, path, profile })}
  ${language}
  <main id="main" class="wrap portal-main" tabindex="-1" data-pixkit-copy>${body}</main>
  ${pageFooter}
  ${analytics ? chrome.consent : ''}
</body>
</html>`;
}
