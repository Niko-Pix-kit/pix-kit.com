import { HttpError } from './backend.mjs';
import { requestSession, tokenClaims } from './session.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const CONTENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMUNITY_READ = {
  settings: [],
  categories: [],
  topics: ['p_category', 'p_sort', 'p_search', 'p_offset'],
  thread: ['p_topic', 'p_offset'],
  activity: [],
  queue: ['p_status', 'p_offset'],
};
const COMMUNITY_WRITE = {
  submit: ['p_request', 'p_category', 'p_parent', 'p_title', 'p_body'],
  edit: ['p_post', 'p_version', 'p_title', 'p_body'],
  delete: ['p_post'],
  vote: ['p_post', 'p_value'],
  report: ['p_post', 'p_reason'],
  appeal: ['p_post', 'p_reason'],
  review: ['p_post', 'p_version', 'p_action', 'p_reason'],
  sanction: ['p_user', 'p_action', 'p_reason', 'p_days'],
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://lh3.googleusercontent.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function redirect(path) {
  return new Response(null, {
    status: 303,
    headers: { Location: path, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

function page(content, status = 200) {
  return new Response(content, { status, headers: PAGE_HEADERS });
}

function invalidRequest() {
  return new HttpError(400, 'invalid_request');
}

async function readObject(request) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type');
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'request_too_large');
  }
  if (!request.body) throw invalidRequest();
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'request_too_large');
      }
      body += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(body + decoder.decode());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest();
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidRequest();
  } finally {
    reader.releaseLock();
  }
}

function fields(data, names) {
  if (Object.keys(data).some((key) => !names.includes(key))) throw invalidRequest();
  return data;
}

function queryFields(url, names) {
  const result = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (!names.includes(key) || Object.hasOwn(result, key) || value.length > 256) throw invalidRequest();
    if (key === 'p_offset') {
      if (!/^[0-9]{1,6}$/.test(value)) throw invalidRequest();
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function textField(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw invalidRequest();
  return value.trim();
}

function emailField(value) {
  const email = textField(value, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw invalidRequest();
  return email;
}

function parsePath(path, languages) {
  const first = path.split('/')[1];
  return first !== 'en' && languages.has(first)
    ? { locale: first, path: path.slice(first.length + 1) || '/' }
    : { locale: 'en', path };
}

function accountPath(locale) {
  return locale === 'en' ? '/account/' : `/${locale}/account/`;
}

function checkAccount(request, token) {
  const displayedAccount = request.headers.get('x-pixkit-account');
  // This is only an extra denial check. The backend still verifies the JWT
  // before authorizing any operation; this header never supplies identity.
  if (displayedAccount && displayedAccount !== tokenClaims(token)?.sub) {
    throw new HttpError(409, 'account_changed');
  }
}

function accountError(error) {
  return error.status >= 500 ? 'service_unavailable' : 'authentication_failed';
}

export function createPlatform({
  origin, backend, languages, authOptions = {}, renderMember, renderCommunity, renderPolicy, readPublic,
}) {
  const base = new URL(origin);
  const loopbackHttp = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.origin !== origin || (base.protocol !== 'https:' && !loopbackHttp)) {
    throw new Error('PIXKIT_ORIGIN must be an HTTPS origin or a loopback HTTP origin');
  }
  const supportedLanguages = new Set(languages);
  const chooseLocale = (value) => supportedLanguages.has(value) ? value : 'en';
  const secure = base.protocol === 'https:';

  async function accountApi(route, body, session, request) {
    if (route === 'email') {
      if (!authOptions.email) throw new HttpError(404, 'not_found');
      fields(body, ['email', 'locale']);
      const email = emailField(body.email);
      try {
        await backend.sendEmail(email);
      } catch (error) {
        // Give the same result for user-specific rejection and a successful request.
        if (error.status !== 401) throw error;
      }
      return json({ ok: true });
    }
    if (route === 'verify') {
      if (!authOptions.email) throw new HttpError(404, 'not_found');
      fields(body, ['email', 'token']);
      const otp = textField(body.token, 10);
      if (!/^[0-9]{6,10}$/.test(otp)) throw invalidRequest();
      session.set(await backend.verifyEmail(emailField(body.email), otp));
      return json({ ok: true });
    }
    const token = await session.access();
    checkAccount(request, token);
    if (route === 'logout') {
      fields(body, []);
      try {
        if (token) await backend.signOut(token);
      } catch (error) {
        if (error.status !== 401) throw error;
      } finally {
        session.clear();
      }
      return json({ ok: true });
    }
    if (!token) throw new HttpError(401, 'authentication_required');
    if (route === 'profile') {
      fields(body, ['p_display_name', 'p_preferred_language']);
      const locale = body.p_preferred_language;
      if (!supportedLanguages.has(locale)) throw invalidRequest();
      return json(await backend.rpc('pixkit_update_profile', {
        p_display_name: textField(body.p_display_name, 80),
        p_preferred_language: locale,
      }, token));
    }
    if (route === 'delete') {
      fields(body, []);
      await backend.deleteAccount(token);
      session.clear();
      return json({ ok: true });
    }
    throw new HttpError(404, 'not_found');
  }

  async function learningApi(route, body, session, request) {
    const token = await session.access();
    checkAccount(request, token);
    if (!token) throw new HttpError(401, 'authentication_required');
    if (route === 'progress' && !body) return json(await backend.rpc('pixkit_progress', {}, token));
    if (route === 'progress') {
      fields(body, ['p_course_id', 'p_lesson_id', 'p_completed', 'p_seen_at']);
      if (typeof body.p_completed !== 'boolean' || typeof body.p_seen_at !== 'string' ||
          body.p_seen_at.length > 40 ||
          !CONTENT_ID.test(textField(body.p_course_id, 100)) ||
          !CONTENT_ID.test(textField(body.p_lesson_id, 100))) throw invalidRequest();
      return json(await backend.rpc('pixkit_record_progress', body, token));
    }
    if (route === 'import' && body) {
      fields(body, ['p_completed']);
      if (!Array.isArray(body.p_completed) || body.p_completed.length > 200) throw invalidRequest();
      return json(await backend.rpc('pixkit_import_progress', body, token));
    }
    throw new HttpError(404, 'not_found');
  }

  async function communityApi(route, url, body, session, request, localContext) {
    const registry = body ? COMMUNITY_WRITE : COMMUNITY_READ;
    if (!Object.hasOwn(registry, route)) throw new HttpError(404, 'not_found');
    if (localContext) {
      const profile = localContext.profile;
      const privateOperation = Boolean(body) || route === 'activity' || route === 'queue';
      if (privateOperation && !profile) throw new HttpError(401, 'authentication_required');
      const displayedAccount = request.headers.get('x-pixkit-account');
      if (displayedAccount && displayedAccount !== profile?.id) {
        throw new HttpError(409, 'account_changed');
      }
      if (privateOperation) throw new HttpError(503, 'service_unavailable');
      return json(await backend.rpc(`pixkit_forum_${route}`, queryFields(url, registry[route]), ''));
    }
    const token = await session.access();
    checkAccount(request, token);
    if ((body || route === 'activity' || route === 'queue') && !token) {
      throw new HttpError(401, 'authentication_required');
    }
    const params = body ? fields(body, registry[route]) : queryFields(url, registry[route]);
    return json(await backend.rpc(`pixkit_forum_${route}`, params, token));
  }

  async function platformPage(url, locale, path, session, localContext) {
    const policy = renderPolicy?.({ locale, path, profile: localContext?.profile });
    if (policy) return page(policy);
    const member = path === '/account/' || path.startsWith('/learn/');
    const community = path === '/community' || path.startsWith('/community/');
    if (!member && !community) return readPublic?.(url.pathname, localContext?.profile);
    let token = localContext ? '' : await session.access();
    let profile = localContext?.profile ?? null;
    if (token) {
      try {
        profile = await backend.rpc('pixkit_profile', {}, token);
      } catch (error) {
        if (error.status !== 401) throw error;
        session.clear();
        token = '';
      }
    }
    const activeToken = profile?.status === 'active' ? token : '';
    if (community) {
      const html = renderCommunity?.({ locale, path, profile: localContext || activeToken ? profile : null });
      return html ? page(html) : null;
    }
    const data = { locale, path, profile, authOptions, error: null, catalog: [], lesson: null, progress: [] };
    if (path === '/account/') {
      const authError = url.searchParams.get('error');
      if (['authentication_failed', 'service_unavailable'].includes(authError)) data.error = authError;
    } else {
      data.catalog = await backend.rpc('pixkit_catalog', { p_locale: locale }, activeToken);
      if (activeToken) data.progress = await backend.rpc('pixkit_progress', {}, activeToken);
      const match = /^\/learn\/([a-z0-9-]{1,100})\/([a-z0-9-]{1,100})\/$/.exec(path);
      if (match) {
        const [, courseId, lessonId] = match;
        const metadata = data.catalog.find(({ id }) => id === courseId)?.lessons.find(({ id }) => id === lessonId);
        if (metadata?.available) {
          data.lesson = await backend.rpc('pixkit_lesson', {
            p_course_id: courseId, p_lesson_id: lessonId, p_locale: locale,
          }, activeToken);
        } else if (metadata) {
          data.lesson = { ...metadata, course_id: courseId, body: null, available: false };
        }
      }
    }
    const html = renderMember?.(data);
    if (!html) return null;
    const status = path.startsWith('/learn/') && !['/learn/', '/learn/progress/'].includes(path) && !data.lesson
      ? 404 : 200;
    return page(html, status);
  }

  return async function handle(request, localContext) {
    const url = new URL(request.url);
    if (url.origin !== origin) return json({ error: 'invalid_origin' }, 400);
    const session = requestSession(request, { backend, secure });
    try {
      const method = request.method;
      const api = /^\/api\/(account|learning|community)\/([a-z_]+)$/.exec(url.pathname);
      if (api) {
        const [, section, route] = api;
        if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'method_not_allowed');
        if (method === 'POST' && request.headers.get('origin') !== origin) {
          throw new HttpError(403, 'invalid_origin');
        }
        const body = method === 'POST' ? await readObject(request) : null;
        let response;
        if (section === 'account' && body) response = await accountApi(route, body, session, request);
        else if (section === 'learning') response = await learningApi(route, body, session, request);
        else if (section === 'community') response = await communityApi(route, url, body, session, request, localContext);
        else throw new HttpError(405, 'method_not_allowed');
        return session.apply(response);
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
      if (url.pathname === '/auth/start' && method === 'GET') {
        const provider = url.searchParams.get('provider');
        const locale = chooseLocale(url.searchParams.get('locale'));
        if (!['google', 'apple'].includes(provider) || !authOptions[provider]) {
          throw new HttpError(404, 'not_found');
        }
        session.setOAuthLocale(locale);
        const location = await backend.startOAuth(provider, `${origin}/auth/callback`, session.oauthStorage());
        return session.apply(redirect(location));
      }
      if (url.pathname === '/auth/callback' && method === 'GET') {
        const location = accountPath(chooseLocale(session.readOAuthLocale()));
        let target = location;
        try {
          const code = textField(url.searchParams.get('code'), 256);
          session.set(await backend.finishOAuth(code, session.oauthStorage()));
        } catch (error) {
          target = `${location}?error=${accountError(error)}`;
        }
        session.clearOAuth();
        return session.apply(redirect(target));
      }
      const { locale, path } = parsePath(url.pathname, supportedLanguages);
      const response = await platformPage(url, locale, path, session, localContext);
      return session.apply(response || json({ error: 'not_found' }, 404));
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known) console.error('PixKit request failed unexpectedly');
      return session.apply(json({
        error: known ? error.code : 'service_unavailable',
      }, known ? error.status : 503));
    }
  };
}
