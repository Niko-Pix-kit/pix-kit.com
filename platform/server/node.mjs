import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import locales from '../../data/i18n/locales.json' with { type: 'json' };
import { createPlatform } from './app.mjs';
import { createBackend, HttpError } from './backend.mjs';
import { createLocalAccounts } from './local-accounts.mjs';
import { renderMemberPage } from '../ui/index.mjs';
import { applySiteChrome } from '../ui/shell.mjs';
import { renderCommunityPage } from '../community-ui/index.mjs';
import { renderPolicyPage } from '../policy/index.mjs';

const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const localeCodes = new Set(locales.map(({ code }) => code));
const publicSections = new Set(['about', 'apps', 'contact', 'cookie-policy', 'privacy', 'terms-of-use', 'platform-privacy']);
const membersAssets = resolve(repository, 'platform/ui');
const communityAssets = resolve(repository, 'platform/community-ui');
const port = Number(process.env.PORT || 4173);
const socket = process.env.PIXKIT_SOCKET;
const origin = process.env.PIXKIT_ORIGIN || `http://127.0.0.1:${port}`;
const production = origin === 'https://pix-kit.com';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
};

function allowedPath(path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0') ||
      decoded.split('/').some((segment) => segment.startsWith('.'))) return null;
  const parts = decoded.slice(1).split('/');
  if (parts[0] === '_platform' && parts.length === 3) {
    const [area, name] = parts.slice(1);
    if (area === 'member' && ['member.css', 'member.js'].includes(name)) return resolve(membersAssets, name);
    if (area === 'community' && ['community.css', 'community.mjs'].includes(name)) {
      return resolve(communityAssets, name);
    }
    return null;
  }
  if (parts[0] === 'assets') return resolve(repository, ...parts);
  const first = localeCodes.has(parts[0]) && parts[0] !== 'en' ? parts[1] || '' : parts[0];
  if (decoded.endsWith('/') && (!first || publicSections.has(first))) {
    return resolve(repository, ...parts, 'index.html');
  }
  if (publicSections.has(first) || ['', 'index.html', '404.html', 'robots.txt', 'sitemap.xml'].includes(first)) {
    if (!first && parts.length > 1) return null;
    return resolve(repository, ...parts);
  }
  return null;
}

async function staticResponse(path, status = 200, profile = null) {
  const file = allowedPath(path);
  const type = file && types[extname(file).toLowerCase()];
  if (!type) return null;
  try {
    const physical = await realpath(file);
    if (physical !== file || !physical.startsWith(repository + sep)) return null;
    const bytes = await readFile(physical);
    const isPage = type.startsWith('text/html');
    const first = path.split('/')[1];
    const locale = localeCodes.has(first) ? first : 'en';
    const route = locale === 'en' ? path : path.slice(first.length + 1) || '/';
    let content = isPage ? applySiteChrome(bytes.toString('utf8'), { locale, path: route, profile }) : bytes;
    if (isPage && useMariaDb && /\/platform-privacy\/(?:index\.html)?$/.test(path)) {
      content = content.replaceAll('Supabase', 'Liquid Web');
    }
    const cacheable = !isPage && status === 200 && (path.startsWith('/assets/') || path.startsWith('/_platform/'));
    return new Response(content, {
      status,
      headers: {
        'Content-Type': type,
        'Cache-Control': cacheable ? 'public, max-age=3600' : 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

async function readPublic(path, profile) {
  const existing = await staticResponse(path, 200, profile);
  if (existing) return existing;
  if (!path.endsWith('/') && !extname(path) && await staticResponse(path + '/', 200, profile)) {
    return new Response(null, { status: 308, headers: { Location: path + '/' } });
  }
  const locale = path.split('/')[1];
  const localized = localeCodes.has(locale) && locale !== 'en' ? '/' + locale : '';
  return await staticResponse(localized + '/404.html', 404, profile) || await staticResponse('/404.html', 404, profile);
}

const previewBackend = {
  async rpc(name) {
    if (name === 'pixkit_forum_settings') return { writing_open: false };
    if (['pixkit_catalog', 'pixkit_forum_categories', 'pixkit_forum_topics'].includes(name)) return [];
    if (name === 'pixkit_forum_thread') return null;
    throw new HttpError(503, 'service_unavailable');
  },
};

const authBackend = process.env.PIXKIT_AUTH_BACKEND;
if (authBackend && authBackend !== 'mariadb' && authBackend !== 'supabase') {
  throw new Error('PIXKIT_AUTH_BACKEND must be mariadb or supabase');
}
const useMariaDb = authBackend === 'mariadb';
const url = useMariaDb ? undefined : process.env.SUPABASE_URL;
const publicKey = useMariaDb ? undefined : process.env.SUPABASE_PUBLISHABLE_KEY;
if (Boolean(url) !== Boolean(publicKey)) {
  throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be configured together');
}
if (!useMariaDb && !url && new URL(origin).protocol === 'https:') {
  throw new Error('Hosted PixKit instances require a configured Supabase project');
}
const backend = url ? createBackend({
  url, publicKey, secretKey: process.env.SUPABASE_SECRET_KEY,
}) : previewBackend;
const authOptions = Object.fromEntries(['google', 'apple', 'email'].map((provider) => [
  provider,
  Boolean(url) && process.env[`PIXKIT_AUTH_${provider.toUpperCase()}`] === '1',
]));

const publicHandler = createPlatform({
  origin, backend, authOptions, languages: localeCodes, readPublic,
  renderMember: renderMemberPage, renderCommunity: renderCommunityPage,
  renderPolicy: (data) => useMariaDb && data.path === '/platform-privacy/' ? null : renderPolicyPage(data),
});

async function localHandler() {
  const { default: mariadb } = await import('mariadb');
  const { createMariaStore } = await import('./mariadb.mjs');
  const { createGoogleOidc } = await import('./google-oidc.mjs');
  const { createEmailAuth } = await import('./email-auth.mjs');
  const { createSendmailTransport } = await import('./sendmail.mjs');
  const { createSmtpTransport } = await import('./smtp.mjs');
  const { emailConfiguration } = await import('./email-configuration.mjs');
  const { PIXKIT_DB_NAME, PIXKIT_DB_USER, PIXKIT_DB_PASSWORD, PIXKIT_DB_SOCKET,
    PIXKIT_GOOGLE_CLIENT_ID, PIXKIT_GOOGLE_CLIENT_SECRET } = process.env;
  if (![PIXKIT_DB_NAME, PIXKIT_DB_USER, PIXKIT_DB_PASSWORD, PIXKIT_GOOGLE_CLIENT_ID,
    PIXKIT_GOOGLE_CLIENT_SECRET].every(Boolean)) {
    throw new Error('MariaDB mode requires the database and Google configuration');
  }
  if (PIXKIT_DB_SOCKET && !isAbsolute(PIXKIT_DB_SOCKET)) {
    throw new Error('PIXKIT_DB_SOCKET must be an absolute path');
  }
  const google = createGoogleOidc({
    origin, clientId: PIXKIT_GOOGLE_CLIENT_ID, clientSecret: PIXKIT_GOOGLE_CLIENT_SECRET,
  });
  const pool = mariadb.createPool({
    ...(PIXKIT_DB_SOCKET ? { socketPath: PIXKIT_DB_SOCKET } : { host: '127.0.0.1' }),
    user: PIXKIT_DB_USER, password: PIXKIT_DB_PASSWORD, database: PIXKIT_DB_NAME,
    connectionLimit: 4, acquireTimeout: 4000, queryTimeout: 5000, logger: { error: () => {} },
  });
  const email = emailConfiguration(process.env);
  const sendCode = email && (email.transport === 'smtp'
    ? createSmtpTransport({ ...email, origin }) : createSendmailTransport({ ...email, origin }));
  const emailAuth = email ? createEmailAuth({
    pool, secret: email.secret, origin, languages: localeCodes, sendCode,
    onSubmissionFailure: diagnostic => console.error(JSON.stringify(diagnostic)),
  }) : undefined;
  return createLocalAccounts({
    origin, store: createMariaStore({ pool }), google, emailAuth, languages: localeCodes, publicHandler,
    trustedProxy: Boolean(socket),
  });
}

const handle = useMariaDb ? await localHandler() : publicHandler;

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, origin);
    if (!incoming.url.startsWith('/') || url.origin !== origin) {
      outgoing.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid request');
      return;
    }
    const init = { method: incoming.method, headers: incoming.headers };
    if (!['GET', 'HEAD'].includes(incoming.method)) {
      init.body = Readable.toWeb(incoming);
      init.duplex = 'half';
    }
    const start = performance.now();
    const response = await handle(new Request(url, init));
    if (/^\/(?:[^/]+\/)?(?:account|auth)(?:\/|$)/.test(url.pathname)) {
      outgoing.setHeader('Server-Timing', `pixkit;dur=${(performance.now() - start).toFixed(1)}`);
    }
    outgoing.statusCode = response.status;
    if (!production) outgoing.setHeader('X-Robots-Tag', 'noindex, nofollow');
    for (const [name, value] of response.headers) {
      if (name !== 'set-cookie') outgoing.setHeader(name, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
    if (incoming.method === 'HEAD' || !response.body) outgoing.end();
    else Readable.fromWeb(response.body).on('error', () => outgoing.destroy()).pipe(outgoing);
  } catch {
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid request');
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
if (socket) {
  if (!isAbsolute(socket)) throw new Error('PIXKIT_SOCKET must be an absolute path');
  const directory = await stat(dirname(socket));
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
    throw new Error('PIXKIT_SOCKET must be in a private directory owned by the runtime user');
  }
  process.umask(0o077);
}
const address = socket ? { path: socket } : { port, host: process.env.PIXKIT_BIND || '127.0.0.1' };
server.listen(address, () => {
  console.log(`PixKit member platform listening at ${origin}`);
});
