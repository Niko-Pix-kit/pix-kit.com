import { createClient } from '@supabase/supabase-js';

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function authResult(result) {
  if (!result.error) return result.data;
  const status = result.error.status;
  if (status === 429) throw new HttpError(429, 'rate_limited');
  if (status >= 400 && status < 500) throw new HttpError(401, 'authentication_failed');
  throw new HttpError(503, 'service_unavailable');
}

function databaseResult(result) {
  if (!result.error) return result.data;
  const { code } = result.error;
  if (result.status === 401 || code === 'PGRST301' || code === 'PGRST303') {
    throw new HttpError(401, 'authentication_failed');
  }
  if (code === '42501' || result.status === 403) throw new HttpError(403, 'forbidden');
  if (code === 'P0002') throw new HttpError(404, 'not_found');
  if (code === '23505' || code === '40001' || code === 'PT409') {
    throw new HttpError(409, 'conflict');
  }
  if (code === 'PT429') throw new HttpError(429, 'rate_limited');
  if (code?.startsWith('22') || code === '23514' || code === 'PT400') {
    throw new HttpError(400, 'invalid_request');
  }
  throw new HttpError(503, 'service_unavailable');
}

export function createBackend({ url, publicKey, secretKey, fetchImpl = fetch }) {
  const target = new URL(url);
  const loopbackHttp = target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('SUPABASE_URL must use HTTPS outside loopback');
  }
  const authOptions = { autoRefreshToken: false, detectSessionInUrl: false };
  const boundedFetch = (input, options) => fetchImpl(input, {
    ...options,
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  const client = ({ key = publicKey, token, storage } = {}) => createClient(url, key, {
    auth: {
      ...authOptions,
      flowType: 'pkce',
      persistSession: Boolean(storage),
      ...(storage && { storageKey: 'pixkit-oauth', storage }),
    },
    global: {
      fetch: boundedFetch,
      ...(token && { headers: { Authorization: `Bearer ${token}` } }),
    },
  });
  const auth = () => client().auth;
  const privileged = secretKey ? client({ key: secretKey }) : null;

  return {
    async startOAuth(provider, callback, storage) {
      const data = authResult(await client({ storage }).auth.signInWithOAuth({
        provider,
        options: { redirectTo: callback, skipBrowserRedirect: true },
      }));
      return data.url;
    },
    async finishOAuth(code, storage) {
      const data = authResult(await client({ storage }).auth.exchangeCodeForSession(code));
      return data.session;
    },
    async sendEmail(email) {
      authResult(await auth().signInWithOtp({ email, options: { shouldCreateUser: true } }));
    },
    async verifyEmail(email, token) {
      const data = authResult(await auth().verifyOtp({ email, token, type: 'email' }));
      return data.session;
    },
    async refresh(refreshToken) {
      // Refresh on a request-scoped client; SDK refresh deduplication is per client.
      const data = authResult(await client().auth.refreshSession({ refresh_token: refreshToken }));
      return data.session;
    },
    async signOut(token) {
      authResult(await auth().admin.signOut(token, 'local'));
    },
    async deleteAccount(token) {
      if (!privileged) throw new HttpError(503, 'service_unavailable');
      const { user } = authResult(await auth().getUser(token));
      if (!user?.id) throw new HttpError(401, 'authentication_failed');
      await this.rpc('pixkit_request_account_deletion', {}, token);
      const result = await privileged.auth.admin.deleteUser(user.id);
      if (result.error && result.error.status !== 404) authResult(result);
    },
    async rpc(name, params, token) {
      return databaseResult(await client({ token }).rpc(name, params));
    },
    async serviceRpc(name, params) {
      if (!privileged) throw new HttpError(503, 'service_unavailable');
      return databaseResult(await privileged.rpc(name, params));
    },
  };
}
