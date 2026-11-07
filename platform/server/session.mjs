import { HttpError } from './backend.mjs';

const ACCESS_LIFETIME = 2 * 60 * 60;
const REFRESH_LIFETIME = 30 * 24 * 60 * 60;
const OAUTH_LIFETIME = 10 * 60;

function readCookies(header) {
  const cookies = new Map();
  for (const item of (header || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    try {
      if (cookies.has(name)) cookies.set(name, '');
      else cookies.set(name, decodeURIComponent(item.slice(separator + 1).trim()));
    } catch {
      cookies.set(name, '');
    }
  }
  return cookies;
}

export function tokenClaims(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    return null;
  }
}

function expiresSoon(token, now) {
  // Untrusted expiry controls refresh timing, never authorization.
  const exp = tokenClaims(token)?.exp;
  return !Number.isFinite(exp) || exp * 1000 <= now + 15_000;
}

export function requestSession(request, { backend, secure, now = Date.now }) {
  const prefix = secure ? '__Host-pixkit-' : 'pixkit-local-';
  const incoming = readCookies(request.headers.get('cookie'));
  const outgoing = new Map();
  const read = (name) => incoming.get(prefix + name) || '';
  function write(name, value, lifetime) {
    const encoded = encodeURIComponent(value);
    if (encoded.length > 3800) throw new HttpError(503, 'service_unavailable');
    outgoing.set(name, `${prefix}${name}=${encoded}; Path=/; Max-Age=${lifetime}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  }

  let token = read('access');
  const refreshToken = read('refresh');
  function clear() {
    write('access', '', 0);
    write('refresh', '', 0);
    token = '';
  }

  function set(session) {
    if (!session?.access_token || !session?.refresh_token) {
      throw new HttpError(503, 'service_unavailable');
    }
    // Validate both sizes before mutating the outgoing headers.
    if ([session.access_token, session.refresh_token].some((value) => encodeURIComponent(value).length > 3800)) {
      throw new HttpError(503, 'service_unavailable');
    }
    write('access', session.access_token, ACCESS_LIFETIME);
    write('refresh', session.refresh_token, REFRESH_LIFETIME);
    token = session.access_token;
  }

  return {
    clear,
    set,
    async access() {
      if (token && !expiresSoon(token, now())) return token;
      if (!refreshToken) return '';
      try {
        set(await backend.refresh(refreshToken));
        return token;
      } catch (error) {
        if (error.status !== 401) throw error;
        clear();
        return '';
      }
    },
    readOAuthLocale: () => read('oauth-locale'),
    setOAuthLocale: (locale) => write('oauth-locale', locale, OAUTH_LIFETIME),
    clearOAuth() {
      write('oauth', '', 0);
      write('oauth-locale', '', 0);
    },
    oauthStorage() {
      const cache = new Map();
      const verifierKey = 'pixkit-oauth-code-verifier';
      return {
        getItem: (key) => cache.get(key) ?? (key === verifierKey ? read('oauth') || null : null),
        setItem(key, value) {
          cache.set(key, value);
          if (key === verifierKey) write('oauth', value, OAUTH_LIFETIME);
        },
        removeItem(key) {
          cache.delete(key);
          if (key === verifierKey) write('oauth', '', 0);
        },
      };
    },
    apply(response) {
      for (const cookie of outgoing.values()) response.headers.append('Set-Cookie', cookie);
      return response;
    },
  };
}
