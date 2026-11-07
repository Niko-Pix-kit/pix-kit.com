import locales from '../../data/i18n/locales.json' with { type: 'json' };
import accountMessages from './account-messages.json' with { type: 'json' };
import { avatarPresets, countryLabel, countryOptions, normalizeCountryCode, normalizeNickname } from '../profile.mjs';
import { googleSignInLink } from './index.mjs';
import { escapeHtml as esc, localPath, messagesFor, renderShell } from './shell.mjs';

const localizedCountries = new Map(locales.map(({ code, tag }) => [code, countryOptions(tag)]));
const avatarIds = new Set(avatarPresets.map(({ id }) => id));
const avatarUrls = new Set(avatarPresets.map(({ url }) => url));

function copyFor(locale) {
  return { ...messagesFor(locale), ...accountMessages[locale] };
}

function option(value, label, current) {
  return `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
}

function visibility(copy, name, checked) {
  return `<label class="account-visibility"><input type="checkbox" name="${name}" value="yes"${checked ? ' checked' : ''}> ${esc(copy.makePublic)}</label>`;
}

function field(copy, { id, label, control, privacyName, visible, privacy }) {
  return `<div class="account-field">
    <div class="account-field-heading"><label for="${id}">${esc(label)}</label>
      ${privacy ? visibility(copy, privacyName, visible) : ''}
    </div>${control}
  </div>`;
}

function profileFields(locale, copy, values = {}, { required = false, privacy = false } = {}) {
  return `
    ${field(copy, {
      id: 'given-name', label: copy.givenName, privacyName: 'publicGivenName', visible: values.publicGivenName, privacy,
      control: `<input id="given-name" name="givenName" autocomplete="given-name" dir="auto" maxlength="60" value="${esc(values.givenName)}"${required ? ' required' : ''}>`,
    })}
    ${field(copy, {
      id: 'family-name', label: copy.familyName, privacyName: 'publicFamilyName', visible: values.publicFamilyName, privacy,
      control: `<input id="family-name" name="familyName" autocomplete="family-name" dir="auto" maxlength="60" value="${esc(values.familyName)}"${required ? ' required' : ''}>`,
    })}
    ${field(copy, {
      id: 'country-code', label: copy.country, privacyName: 'publicCountry', visible: values.publicCountry, privacy,
      control: `<select id="country-code" name="countryCode" autocomplete="country"${required ? ' required' : ''}>
        ${option('', '—', values.countryCode)}${localizedCountries.get(locale).map(({ code, label }) => option(code, label, normalizeCountryCode(values.countryCode))).join('')}
      </select>`,
    })}
    ${field(copy, {
      id: 'preferred-locale', label: copy.language, privacyName: 'publicLanguage', visible: values.publicLanguage, privacy,
      control: `<select id="preferred-locale" name="preferredLocale">${locales.map(({ code, name }) =>
        option(code, name, values.preferredLocale ?? locale)).join('')}</select>`,
    })}`;
}

function nicknameField(copy, values, suggestions) {
  const choices = suggestions.filter(value => normalizeNickname(value)).slice(0, 5);
  return `<div class="account-field">
    <label for="account-nickname">${esc(copy.nickname)}</label>
    <input id="account-nickname" name="nickname" autocomplete="nickname" dir="ltr"
      minlength="3" maxlength="24" pattern="[A-Za-z0-9][A-Za-z0-9_]{2,23}"
      value="${esc(values.nickname)}" aria-describedby="nickname-help"${choices.length ? ' list="nickname-suggestions"' : ''} required>
    <p id="nickname-help" class="portal-note account-help">${esc(copy.nicknameHelp)}</p>
    ${choices.length ? `<datalist id="nickname-suggestions">${choices.map(value => `<option value="${esc(value)}"></option>`).join('')}</datalist>
      <p class="portal-status" role="status">${choices.map(esc).join(' · ')}</p>` : ''}
  </div>`;
}

function avatarUrl(value, publicOnly = false) {
  if (avatarUrls.has(value)) return value;
  if (publicOnly) return '';
  try {
    const url = new URL(value);
    return url.origin === 'https://lh3.googleusercontent.com' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function avatarImage(value, copy, publicOnly = false, size = 72) {
  const source = avatarUrl(value, publicOnly);
  if (source) return `<img class="account-avatar" src="${esc(source)}" width="${size}" height="${size}" alt="${esc(copy.avatar)}" decoding="async" referrerpolicy="no-referrer">`;
  return `<svg class="account-avatar account-avatar-placeholder" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${esc(copy.avatar)}">
    <rect x="1" y="1" width="62" height="62" rx="16" fill="#edf6fd"/>
    <path d="M23 12h18v18H23z" fill="#0088cc"/>
    <path d="M14 53V41l10-7h16l10 7v12z" fill="#ff6b00"/>
  </svg>`;
}

function avatarPicker(copy, values) {
  const chosen = avatarIds.has(values.avatarPreset) ? values.avatarPreset : '';
  const choices = [
    { id: '', label: copy.defaultAvatar, url: '' },
    ...avatarPresets.map(({ id, url }, index) => ({ id, url, label: `${copy.avatar} ${index + 1}` })),
  ];
  return `<fieldset class="account-avatar-picker">
    <legend>${esc(copy.avatar)}</legend>
    <div class="account-avatar-options">${choices.map(({ id, label, url }) => `
      <label class="account-avatar-option">
        <input type="radio" name="avatarPreset" value="${id}"${chosen === id ? ' checked' : ''}>
        ${avatarImage(url || (id === '' && !values.avatarPreset ? values.avatarUrl : ''), copy, false, 56)}
        <span>${esc(label)}</span>
      </label>`).join('')}
    </div>
  </fieldset>`;
}

export function readProfile(form, supported, required = false) {
  const name = (key) => {
    const value = form.get(key);
    if (typeof value !== 'string' || form.getAll(key).length !== 1) return undefined;
    const normalized = value.normalize('NFC').trim();
    return [...normalized].length <= 60 && !/[\p{Cc}\p{Cs}]/u.test(normalized) ? normalized : undefined;
  };
  const givenName = name('givenName');
  const familyName = name('familyName');
  const rawCountryCode = form.get('countryCode');
  const countryCode = rawCountryCode ? normalizeCountryCode(rawCountryCode) : rawCountryCode;
  const preferredLocale = form.get('preferredLocale');
  if (givenName === undefined || familyName === undefined || countryCode === null ||
      form.getAll('countryCode').length !== 1 || form.getAll('preferredLocale').length !== 1 ||
      (required && (!givenName || !familyName || !countryCode)) ||
      (rawCountryCode && !countryCode) || !supported.has(preferredLocale)) return null;
  const profile = { givenName: givenName || null, familyName: familyName || null,
    countryCode: countryCode || null, preferredLocale };
  if (form.has('nickname')) {
    const nickname = normalizeNickname(form.get('nickname'));
    if (!nickname || form.getAll('nickname').length !== 1) return null;
    profile.nickname = nickname;
  } else if (required) {
    return null;
  }
  if (form.has('avatarPreset')) {
    const preset = form.get('avatarPreset');
    if (form.getAll('avatarPreset').length !== 1 || (preset && !avatarIds.has(preset))) return null;
    profile.avatarPreset = preset || null;
  }
  for (const key of ['publicGivenName', 'publicFamilyName', 'publicCountry', 'publicLanguage']) {
    if (form.getAll(key).length > 1 || (form.has(key) && form.get(key) !== 'yes')) return null;
    profile[key] = form.has(key);
  }
  return profile;
}

const button = (label, classes = '', attributes = '') =>
  `<button class="portal-button${classes}" type="submit"${attributes}>${esc(label)}</button>`;
const form = (locale, path, content, attributes = '') =>
  `<form method="post" action="${localPath(locale, path)}" class="portal-form account-form"${attributes}>${content}</form>`;
const alert = (message) => message ? `<p class="portal-status" role="alert">${esc(message)}</p>` : '';

function passwordField(copy, newPassword) {
  return `<div class="account-field">
    <label for="account-password">${esc(newPassword ? copy.newPassword : copy.password)}</label>
    <input id="account-password" name="password" type="password"
      autocomplete="${newPassword ? 'new-password' : 'current-password'}"
      ${newPassword ? 'minlength="15" ' : ''}maxlength="256" required${newPassword ? ' aria-describedby="password-help"' : ''}>
    ${newPassword ? `<p id="password-help" class="portal-note account-help">${esc(copy.passwordHelp)}</p>` : ''}
  </div>`;
}

function emailField(copy, email) {
  return `<div class="account-field">
    <label for="account-email">${esc(copy.email)}</label>
    <input id="account-email" name="email" type="email" autocomplete="email" dir="ltr" maxlength="254" value="${esc(email)}" required>
  </div>`;
}

export function renderLocalAccount({
  locale, path, user = null, emailEnabled = false, email = '', error,
  profileValues = null, nicknameSuggestions = [], confirmationToken = '', flowPurpose = 'signup', passwordUpdated = false,
}) {
  const copy = copyFor(locale);
  const signUp = path === '/account/sign-up/';
  const pending = path === '/account/email/pending/';
  const confirmation = path === '/account/email/confirm/';
  const resetting = path === '/account/password/reset/';
  const title = user ? copy.account : pending || confirmation ? copy.verifyEmail : resetting ? copy.resetPassword : signUp ? copy.signUp : copy.signIn;
  const values = { ...user, ...profileValues };
  let content;
  if (user) {
    const admin = user.isAdmin
      ? `<a href="${localPath(locale, '/admin/users/')}" class="portal-button">Users</a>` : '';
    const publicLink = user.nickname
      ? `<a href="${localPath(locale, `/members/${encodeURIComponent(user.nickname)}/`)}">${esc(copy.publicProfile)}</a>` : '';
    content = `
      <section class="portal-card">
        <div class="account-summary">${avatarImage(user.avatarUrl, copy)}
          <div><h2>${esc(copy.profile)}</h2><p><bdi>${esc(user.nickname || user.displayName)}</bdi></p>${publicLink}</div>
        </div>
        <p>${esc(copy.email)} · <bdi>${esc(user.email)}</bdi></p>
        ${alert(error && (error === 'nickname_taken' ? copy.nicknameTaken : copy.error))}
        ${form(locale, '/account/profile/', `
          ${avatarPicker(copy, values)}
          ${nicknameField(copy, values, nicknameSuggestions)}
          <p class="portal-note account-help">${esc(copy.visibilityHelp)}</p>
          ${profileFields(locale, copy, values, { privacy: true })}`, ' id="account-profile-form"')}
        <div class="portal-actions account-actions">
          ${button(copy.save, '', ' form="account-profile-form"')}
          ${form(locale, '/account/logout/', button(copy.signOut, ' portal-signout'))}
          ${admin}
        </div>
      </section>
      <section class="portal-card">
        <h2>${esc(copy.deleteAccount)}</h2><p>${esc(copy.deleteWarning)}</p>
        ${form(locale, '/account/delete/', `
          <label class="portal-check"><input type="checkbox" name="confirm" value="yes" required> ${esc(copy.deleteConfirm)}</label>
          ${button(copy.deleteAccount, ' portal-danger')}`)}
      </section>`;
  } else if (confirmation) {
    content = `<section class="portal-card">
      <p role="status" data-confirmation-status data-invalid-link="${esc(copy.invalidLink)}">${esc(error ? copy.invalidLink : copy.confirmationPrompt)}</p>
      ${form(locale, '/account/email/confirm/', `
        <input type="hidden" name="confirmationToken" value="${esc(confirmationToken)}">
        <input type="hidden" name="selector" value="">
        <input type="hidden" name="verificationToken" value="">
        ${passwordField(copy, false)}
        <p class="portal-note account-help">${esc(copy.confirmationPasswordHelp)}</p>
        ${button(copy.verifyEmail, '', ' disabled')}`, ' data-email-confirmation')}
      <noscript><p class="portal-note">${esc(copy.enableJavaScript)}</p></noscript>
      <div class="portal-actions">
        <a class="portal-button" href="${localPath(locale, '/')}">${esc(copy.continueBrowsing)}</a>
        <a href="${localPath(locale, flowPurpose === 'reset' ? '/account/password/reset/' : '/account/sign-up/')}" data-confirmation-retry>${esc(copy.requestAnotherLink)}</a>
      </div>
    </section>`;
  } else if (pending) {
    content = `<section class="portal-card">
      <p role="status">${esc(copy.linkSent)}</p>
      <p class="portal-note">${esc(copy.pendingAccess)}</p>
      <div class="portal-actions">
        <a class="portal-button" href="${localPath(locale, '/')}">${esc(copy.continueBrowsing)}</a>
        <a href="${localPath(locale, flowPurpose === 'reset' ? '/account/password/reset/' : '/account/sign-up/')}">${esc(copy.requestAnotherLink)}</a>
      </div>
    </section>`;
  } else {
    const endpoint = resetting ? '/account/password/reset/' : signUp ? '/account/email/sign-up/' : '/account/email/sign-in/';
    content = `<section class="portal-card">
      ${passwordUpdated ? `<p class="portal-status" role="status">${esc(copy.passwordUpdated)}</p>` : ''}
      ${alert(error && (error === 'service_unavailable' ? copy.unavailable : error === 'nickname_taken' ? copy.nicknameTaken : copy.error))}
      ${!emailEnabled ? `<p class="portal-note" role="status">${esc(copy.signInUnavailable)}</p>` : ''}
      ${form(locale, endpoint, `<fieldset class="account-credentials"${!emailEnabled ? ' disabled' : ''}${!signUp && !resetting ? ' data-account-login' : ''}>
        ${signUp ? nicknameField(copy, values, nicknameSuggestions) + profileFields(locale, copy, values, { required: true }) : ''}
        ${emailField(copy, email)}
        ${!resetting ? passwordField(copy, signUp) : ''}
        ${button(resetting ? copy.resetSend : signUp ? copy.verifySend : copy.signIn)}
      </fieldset>`)}
      ${!signUp && !resetting && emailEnabled ? `<p><a href="${localPath(locale, '/account/password/reset/')}">${esc(copy.resetPassword)}</a></p>` : ''}
      <div class="portal-actions account-auth-alternatives">
        <a class="portal-button" href="${localPath(locale, signUp || resetting ? '/account/' : '/account/sign-up/')}">${esc(signUp || resetting ? copy.signIn : copy.signUp)}</a>
        ${googleSignInLink(locale, copy)}
      </div>
    </section>`;
  }
  return renderShell({
    locale, path, profile: user, title, noindex: true,
    analytics: !confirmation, script: confirmation ? '/assets/js/email-confirm.js' : undefined,
    body: `<h1>${esc(title)}</h1><div class="portal-stack portal-narrow">${content}</div>`,
  });
}

export function renderPublicProfile({ locale, profile, viewer = null }) {
  const copy = copyFor(locale);
  const rows = [];
  if (profile.givenName) rows.push([copy.givenName, profile.givenName]);
  if (profile.familyName) rows.push([copy.familyName, profile.familyName]);
  if (normalizeCountryCode(profile.countryCode)) {
    rows.push([copy.country, countryLabel(profile.countryCode, locales.find(language => language.code === locale)?.tag ?? 'en')]);
  }
  if (profile.preferredLocale) {
    const language = locales.find(({ code }) => code === profile.preferredLocale);
    if (language) rows.push([copy.language, language.name]);
  }
  return renderShell({
    locale, path: `/members/${encodeURIComponent(profile.nickname)}/`, profile: viewer, title: profile.nickname, noindex: true,
    body: `<h1>${esc(copy.publicProfile)}</h1><section class="portal-card portal-narrow">
      <div class="account-summary">${avatarImage(profile.avatarUrl, copy, true)}
        <h2><bdi>${esc(profile.nickname)}</bdi></h2>
      </div>
      ${rows.length ? `<dl class="account-public-details">${rows.map(([label, value]) =>
        `<div><dt>${esc(label)}</dt><dd><bdi>${esc(value)}</bdi></dd></div>`).join('')}</dl>` : ''}
    </section>`,
  });
}
