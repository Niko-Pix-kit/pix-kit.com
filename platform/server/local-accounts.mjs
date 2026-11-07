import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { escapeHtml, localPath, renderShell } from '../ui/shell.mjs';
import { HttpError } from './backend.mjs';
import { avatarPresets } from '../profile.mjs';
import { normalizeEmail, validNewPassword } from './email-auth.mjs';
import { readProfile, renderLocalAccount, renderPublicProfile } from '../ui/local-account.mjs';

const FLOW_SECONDS = 600;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const PAGE_SIZE = 25;
const formType = 'application/x-www-form-urlencoded';
const accountPages = new Set(['/account/', '/account/sign-up/', '/account/password/reset/', '/account/email/pending/', '/admin/users/']);
const accountActions = new Set([
  '/account/logout/', '/account/delete/', '/account/profile/',
  '/account/password/reset/', '/account/email/sign-up/', '/account/email/sign-in/', '/account/email/confirm/',
]);
const randomToken = () => randomBytes(32).toString('base64url');
const hash = (token) => createHash('sha256').update(token).digest('hex');
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const safeAvatar = (value) => {
  if (avatarPresets.some(preset => preset.url === value)) return value;
  try {
    const url = new URL(value);
    return url.origin === 'https://lh3.googleusercontent.com' && !url.username && !url.password
      ? url.href : '';
  } catch {
    return '';
  }
};

function cookieValue(request, name) {
  const matches = (request.headers.get('cookie') ?? '').split(';')
    .map(value => value.trim()).filter(value => value.startsWith(name + '='));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : '';
}

function respond(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https://lh3.googleusercontent.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      ...headers,
    },
  });
}

const redirect = (location) => respond(null, 303, { Location: location });
const html = (body) => respond(body, 200, {
  'Content-Type': 'text/html; charset=utf-8',
  'Referrer-Policy': 'same-origin',
});

async function readForm(request) {
  if (request.headers.get('content-type')?.split(';', 1)[0] !== formType ||
      Number(request.headers.get('content-length')) > 4096) return null;
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function avatarMarkup(value) {
  const avatar = safeAvatar(value);
  return avatar ? `<img src="${escapeHtml(avatar)}" alt="" width="32" height="32" loading="lazy" referrerpolicy="no-referrer">` : '—';
}

function directoryPage({ users, total }, page, locale) {
  const rows = users.map(user => `<tr>
    <td>${avatarMarkup(user.avatarUrl)}</td>
    <td><bdi>${escapeHtml(user.displayName)}</bdi></td>
    <td><bdi>${escapeHtml(user.email)}</bdi></td>
    <td>${escapeHtml(user.createdAt)}</td>
    <td>${escapeHtml(user.lastSignInAt)}</td>
  </tr>`).join('');
  const route = localPath(locale, '/admin/users/');
  const previous = page > 1 ? `<a href="${route}?page=${page - 1}">Previous</a>` : '';
  const next = page * PAGE_SIZE < total ? `<a href="${route}?page=${page + 1}">Next</a>` : '';
  return `<h1>Users</h1><p>Total users: ${total}</p>
    <div class="portal-table-scroll"><table class="portal-table">
      <thead><tr><th scope="col">Avatar</th><th scope="col">Name</th><th scope="col">Email</th>
      <th scope="col">Created (UTC)</th><th scope="col">Last sign-in (UTC)</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <nav class="portal-actions" aria-label="User pages">${previous}${next}</nav>`;
}

export function createLocalAccounts({ origin, store, google, emailAuth, languages, publicHandler, trustedProxy = false, now = Date.now }) {
  const secure = new URL(origin).protocol === 'https:';
  const prefix = secure ? '__Host-pixkit-' : 'pixkit-local-';
  const flowCookie = prefix + 'google-flow';
  const sessionCookie = prefix + 'session';
  const emailFlowCookie = prefix + 'email-flow';
  const confirmationCookie = prefix + 'email-confirmation';
  const supported = new Set(languages);
  const language = (value) => supported.has(value) ? value : 'en';

  function setCookie(response, name, value, maxAge) {
    response.headers.append('Set-Cookie',
      `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    return response;
  }

  async function callback(request, url, sessionHash) {
    let locale = 'en';
    let response;
    try {
      const encoded = cookieValue(request, flowCookie);
      if (!/^[A-Za-z0-9_-]{1,600}$/.test(encoded)) throw new HttpError(401, 'authentication_failed');
      const flow = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      locale = language(flow.locale);
      const states = url.searchParams.getAll('state');
      const codes = url.searchParams.getAll('code');
      const age = now() - flow.issuedAt;
      if (!Number.isFinite(age) || age < 0 || age > FLOW_SECONDS * 1000 ||
          !tokenPattern.test(flow.state) || !tokenPattern.test(flow.nonce) || !tokenPattern.test(flow.verifier) ||
          states.length !== 1 || !tokenPattern.test(states[0]) ||
          !timingSafeEqual(Buffer.from(states[0]), Buffer.from(flow.state)) ||
          url.searchParams.has('error') || codes.length !== 1 || !codes[0] || codes[0].length > 2048) {
        throw new HttpError(401, 'authentication_failed');
      }
      const identity = await google.exchange(codes[0], flow);
      const token = randomToken();
      await store.signIn(identity, hash(token), new Date(now() + SESSION_SECONDS * 1000), {
        replaceSessionHash: sessionHash || undefined,
      });
      response = setCookie(redirect(localPath(locale, '/account/')), sessionCookie, token, SESSION_SECONDS);
    } catch (error) {
      const rejected = error instanceof SyntaxError || (error instanceof HttpError && error.status < 500);
      const failure = rejected ? 'authentication_failed' : 'service_unavailable';
      response = redirect(`${localPath(locale, '/account/')}?error=${failure}`);
    }
    return setCookie(response, flowCookie, '', 0);
  }

  return async function handle(request) {
    const url = new URL(request.url);
    if (url.origin !== origin) return respond('Invalid request.', 400);
    const first = url.pathname.split('/')[1];
    const locale = language(first);
    const path = locale === 'en' ? url.pathname : url.pathname.slice(first.length + 1) || '/';
    const token = cookieValue(request, sessionCookie);
    const sessionHash = tokenPattern.test(token) ? hash(token) : '';
    const readable = request.method === 'GET' || request.method === 'HEAD';
    const sourceHeader = request.headers.get('x-pixkit-client-ip');
    const source = trustedProxy && isIP(sourceHeader ?? '') ? sourceHeader : undefined;
    try {
      if (url.pathname === '/auth/start' && request.method === 'GET') {
        if (url.searchParams.get('provider') !== 'google') return respond('Not found.', 404);
        const flow = {
          state: randomToken(), nonce: randomToken(), verifier: randomToken(),
          locale: language(url.searchParams.get('locale')), issuedAt: now(),
        };
        const encoded = Buffer.from(JSON.stringify(flow)).toString('base64url');
        return setCookie(redirect(google.authorizationUrl(flow)), flowCookie, encoded, FLOW_SECONDS);
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        return await callback(request, url, sessionHash);
      }
      if (path === '/account/email/verify/') {
        return redirect(localPath(locale, '/account/') + '?error=authentication_failed');
      }
      if (path === '/account/email/confirm/' && readable) {
        if (!emailAuth) return respond('Not found.', 404);
        const confirmationToken = randomToken();
        const page = html(renderLocalAccount({
          locale, path, confirmationToken, emailEnabled: true,
        }));
        return setCookie(page, confirmationCookie, confirmationToken, FLOW_SECONDS);
      }
      const member = path.match(/^\/members\/([A-Za-z0-9_]{3,24})\/$/);
      if (member) {
        if (!readable) return respond('Method not allowed.', 405, { Allow: 'GET, HEAD' });
        const profile = await store.publicProfile(member[1]);
        if (!profile) return respond('Not found.', 404);
        const user = sessionHash ? await store.session(sessionHash) : null;
        return html(renderPublicProfile({ locale, path, profile, viewer: user }));
      }
      if (accountPages.has(path) && (readable || !accountActions.has(path))) {
        if (!readable) return respond('Method not allowed.', 405, { Allow: 'GET, HEAD' });
        const user = sessionHash ? await store.session(sessionHash) : null;
        if (path === '/admin/users/') {
          if (!user?.isAdmin) return respond('Not found.', 404);
          const requestedPage = url.searchParams.get('page') ?? '1';
          if (!/^[1-9][0-9]{0,5}$/.test(requestedPage)) return respond('Invalid page.', 400);
          const currentPage = Number(requestedPage);
          const data = await store.listUsers({ limit: PAGE_SIZE, offset: (currentPage - 1) * PAGE_SIZE });
          return html(renderShell({
            locale, path, profile: user, title: 'Users', noindex: true,
            body: directoryPage(data, currentPage, locale),
          }));
        }
        if (user && path === '/account/sign-up/') return redirect(localPath(locale, '/account/'));
        const error = url.searchParams.get('error');
        return html(renderLocalAccount({
          locale, path, user, emailEnabled: Boolean(emailAuth),
          flowPurpose: url.searchParams.get('purpose') === 'reset' ? 'reset' : 'signup',
          passwordUpdated: path === '/account/' && url.searchParams.get('reset') === 'complete',
          error: ['authentication_failed', 'service_unavailable', 'invalid_profile', 'nickname_taken', 'invalid_password'].includes(error) ? error : null,
        }));
      }
      if (accountActions.has(path)) {
        if (request.method !== 'POST') return respond('Method not allowed.', 405, { Allow: 'POST' });
        if (request.headers.get('origin') !== origin) return respond('Invalid origin.', 403);
        const accountUrl = localPath(locale, '/account/');
        if (path === '/account/logout/') {
          if (sessionHash) await store.revokeSession(sessionHash);
          return setCookie(redirect(accountUrl), sessionCookie, '', 0);
        }
        if (path === '/account/delete/') {
          if (sessionHash) {
            const form = await readForm(request);
            if (!form || form.size !== 1 || form.get('confirm') !== 'yes') {
              return respond('Confirmation required.', 400);
            }
            await store.deleteAccount(sessionHash);
          }
          return setCookie(redirect(accountUrl), sessionCookie, '', 0);
        }
        if (path === '/account/profile/') {
          if (!sessionHash) return redirect(accountUrl);
          const form = await readForm(request);
          const profile = form && readProfile(form, supported);
          if (!profile) return redirect(accountUrl + '?error=invalid_profile');
          const result = await store.updateProfile(sessionHash, profile);
          if (result?.status === 'expired') return redirect(accountUrl);
          if (result?.status === 'nickname_taken') {
            const user = await store.session(sessionHash);
            return html(renderLocalAccount({
              locale, path: '/account/', user, emailEnabled: Boolean(emailAuth),
              error: 'nickname_taken', profileValues: profile, nicknameSuggestions: result.suggestions,
            }));
          }
          return redirect(localPath(profile.preferredLocale, '/account/'));
        }
        if (!emailAuth) return respond('Not found.', 404);
        const form = await readForm(request);
        if (path === '/account/email/confirm/') {
          const invalid = () => {
            const page = html(renderLocalAccount({ locale, path, error: true, emailEnabled: true }));
            return page;
          };
          const confirmationToken = form?.get('confirmationToken');
          const csrfCookie = cookieValue(request, confirmationCookie);
          const selector = form?.get('selector');
          const verificationToken = form?.get('verificationToken');
          const password = form?.get('password');
          if (!form || form.size !== 4 ||
              ['confirmationToken', 'selector', 'verificationToken', 'password'].some(key => form.getAll(key).length !== 1) ||
              !tokenPattern.test(confirmationToken ?? '') || !tokenPattern.test(csrfCookie) ||
              !timingSafeEqual(Buffer.from(confirmationToken), Buffer.from(csrfCookie)) ||
              !tokenPattern.test(selector ?? '') || !tokenPattern.test(verificationToken ?? '') ||
              typeof password !== 'string') return invalid();
          const newToken = randomToken();
          const verified = await emailAuth.verifyLink({
            selector, verificationToken, password, sessionTokenHash: hash(newToken),
            expiresAt: new Date(now() + SESSION_SECONDS * 1000),
            replaceSessionHash: sessionHash || undefined,
          });
          if (!verified?.verified || !['signup', 'reset'].includes(verified.purpose)) return invalid();
          const response = verified.purpose === 'reset'
            ? setCookie(redirect(accountUrl + '?reset=complete'), sessionCookie, '', 0)
            : setCookie(redirect(accountUrl), sessionCookie, newToken, SESSION_SECONDS);
          setCookie(response, emailFlowCookie, '', 0);
          return setCookie(response, confirmationCookie, '', 0);
        }
        const email = form && form.getAll('email').length === 1 && normalizeEmail(form.get('email'));
        const password = form?.get('password');
        const validPasswordField = form?.getAll('password').length === 1 && typeof password === 'string';
        if (path === '/account/email/sign-in/') {
          if (!email || !validPasswordField) return redirect(accountUrl + '?error=authentication_failed');
          const newToken = randomToken();
          const accepted = await emailAuth.signIn({
            email, password, source, sessionTokenHash: hash(newToken),
            expiresAt: new Date(now() + SESSION_SECONDS * 1000),
            replaceSessionHash: sessionHash || undefined,
          });
          return accepted ? setCookie(redirect(accountUrl), sessionCookie, newToken, SESSION_SECONDS)
            : redirect(accountUrl + '?error=authentication_failed');
        }
        const signUp = path === '/account/email/sign-up/';
        const formPath = signUp ? '/account/sign-up/' : '/account/password/reset/';
        const profile = signUp && form ? readProfile(form, supported, true) : null;
        if (!email || (signUp && !profile)) {
          return redirect(localPath(locale, formPath) + '?error=invalid_profile');
        }
        if (signUp && (!validPasswordField || !validNewPassword(password))) {
          return html(renderLocalAccount({
            locale, path: formPath, emailEnabled: true, email, profileValues: profile, error: 'invalid_password',
          }));
        }
        if (signUp) {
          const availability = await store.nicknameAvailability(profile.nickname);
          if (!availability.available) {
            return html(renderLocalAccount({
              locale, path: formPath, emailEnabled: true, email, profileValues: profile,
              error: 'nickname_taken', nicknameSuggestions: availability.suggestions,
            }));
          }
        }
        const flowToken = signUp
          ? await emailAuth.requestLink({ email, profile, locale, password, source })
          : await emailAuth.requestPasswordReset({ email, locale, source });
        const pending = localPath(locale, '/account/email/pending/') + (signUp ? '' : '?purpose=reset');
        const page = redirect(pending);
        return flowToken ? setCookie(page, emailFlowCookie, flowToken, FLOW_SECONDS) : page;
      }
      if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/account/')) {
        return respond('Not found.', 404);
      }
      const asset = /^\/(?:assets|_platform)\//.test(url.pathname);
      const profile = !asset && sessionHash ? await store.session(sessionHash) : null;
      // Supabase cookies are not credentials for the MariaDB backend.
      const headers = new Headers(request.headers);
      headers.delete('cookie');
      return await publicHandler(new Request(request, { headers }), { profile });
    } catch {
      return respond('Service unavailable.', 503);
    }
  };
}
