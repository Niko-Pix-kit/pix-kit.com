import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const appOrigin = 'https://app.pix-kit.com';
const apexOrigin = 'https://pix-kit.com';
const phpCliAvailable = spawnSync('php', ['-r', 'exit(0);']).status === 0;
const phpAvailable = spawnSync('php', ['-r', 'exit(defined("CURLOPT_UNIX_SOCKET_PATH") ? 0 : 1);']).status === 0;
const socketAvailable = spawnSync(process.execPath, ['-e', `
  const fs = require('node:fs');
  const directory = fs.mkdtempSync(require('node:os').tmpdir() + '/pixkit-capability-');
  const server = require('node:net').createServer();
  server.on('error', () => {
    fs.rmdirSync(directory);
    process.exitCode = 1;
  });
  server.listen(directory + '/probe.sock', () => server.close(() => fs.rmdirSync(directory)));
`]).status === 0;

if (process.env.PIXKIT_REQUIRE_GATEWAY_TESTS === '1') {
  assert.ok(phpAvailable && socketAvailable, 'PHP cURL and Unix sockets are required');
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pixkit-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function gateway(t) {
  const directory = await workspace(t);
  const privateDirectory = join(directory, 'private');
  const documentRoot = join(directory, 'public_html');
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(documentRoot);
  await copyFile(new URL('../deploy/liquid-web/index.php', import.meta.url), join(documentRoot, 'index.php'));
  await writeFile(join(directory, 'router.php'), "<?php $_SERVER['HTTPS'] = 'on'; require __DIR__ . '/public_html/index.php';");
  const [, port] = await processReady(t, 'php', ['-S', '127.0.0.1:0', 'router.php'], {
    cwd: directory,
  }, /Development Server \(http:\/\/127\.0\.0\.1:(\d+)\) started/, 'stderr');
  return {
    privateDirectory,
    relay: (path, options = {}, body) => send({
      port, host: '127.0.0.1', path, ...options, headers: { Host: 'app.pix-kit.com', ...options.headers },
    }, body),
  };
}

function processReady(t, executable, args, options, message, stream = 'stdout') {
  const child = spawn(executable, args, options);
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
  });

  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    if (stream !== 'stderr') child.stderr.on('data', (chunk) => { errors += chunk; });
    child[stream].on('data', (chunk) => {
      output += chunk;
      const match = message.exec(output);
      if (match) resolve(match);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Process exited before readiness: ${code} ${output}${errors}`)));
  });
}

function send(options, body) {
  return new Promise((resolve, reject) => {
    const call = request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString(),
      }));
      response.on('error', reject);
    });
    call.on('error', reject);
    call.end(body);
  });
}

test('Node serves member pages through a private Unix socket', {
  skip: !socketAvailable, timeout: 10000,
}, async (t) => {
  const directory = await workspace(t);
  const socket = join(directory, 'pixkit.sock');
  const entry = new URL('../server/node.mjs', import.meta.url);
  await processReady(t, process.execPath, [entry.pathname], {
    env: { ...process.env, PIXKIT_SOCKET: socket, PIXKIT_ORIGIN: appOrigin,
      SUPABASE_URL: 'https://example.invalid', SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key' },
  }, /PixKit member platform listening/);

  assert.equal((await stat(socket)).mode & 0o077, 0);
  const page = await send({ socketPath: socket, path: '/fr/account/' });
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'private, no-store');
  const about = await send({ socketPath: socket, path: '/about/' });
  assert.equal(about.status, 200);
  assert.match(about.body, /<main[^>]*>/);
  assert.match(about.body, /About us/);
  assert.equal((await send({ socketPath: socket, path: '/fr/about/' })).status, 200);
  assert.equal((await send({ socketPath: socket, path: '//other.invalid/account/' })).status, 400);
});

test('PHP gateway restricts host aliases and redirects without leaking query data', {
  skip: !phpCliAvailable, timeout: 10000,
}, async (t) => {
  const { privateDirectory, relay } = await gateway(t);
  const originFile = join(privateDirectory, 'pixkit-gateway-origin');
  const apexHeaders = { Host: 'pix-kit.com' };
  assert.equal((await relay('/account/', { headers: apexHeaders })).status, 421);
  await writeFile(originFile, `${apexOrigin}\n`, { mode: 0o600 });
  assert.equal((await relay('/account/logout/', { method: 'POST' })).status, 421);
  assert.equal((await relay('/learn/?tracking=fixture')).headers.location, `${apexOrigin}/learn/`);
  const previousCallback = await relay('/auth/callback?code=fixture&state=fixture');
  assert.equal(previousCallback.status, 302);
  assert.equal(previousCallback.headers.location, `${apexOrigin}/account/`);
  const www = await relay('/account/', { method: 'HEAD', headers: { Host: 'www.pix-kit.com' } });
  assert.equal(www.status, 302);
  assert.equal(www.headers.location, `${apexOrigin}/account/`);
  assert.equal((await relay('/account/', { headers: { Host: 'other.invalid' } })).status, 421);
  await writeFile(originFile, 'https://other.invalid\n');
  assert.equal((await relay('/account/', { headers: apexHeaders })).status, 503);
});

test('PHP gateway preserves OAuth cookies, redirects and same-origin POST data', {
  skip: !phpAvailable || !socketAvailable, timeout: 10000,
}, async (t) => {
  const { privateDirectory, relay } = await gateway(t);
  const socket = join(privateDirectory, 'pixkit.sock');

  const upstream = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    if (['/assets/site.css', '/assets/unsafe.css', '/account/'].includes(incoming.url)) {
      outgoing.setHeader('Cache-Control', 'public, max-age=3600');
    }
    if (incoming.url === '/assets/unsafe.css') {
      outgoing.setHeader('Set-Cookie', 'pixkit_access=fixture; Secure; HttpOnly');
    }
    outgoing.setHeader('Server-Timing', 'app;dur=12');
    if (incoming.url.startsWith('/auth/callback')) {
      outgoing.writeHead(303, {
        Location: '/account/',
        'Set-Cookie': ['pixkit_access=fixture; Secure; HttpOnly', 'pixkit_refresh=fixture; Secure; HttpOnly'],
        'Referrer-Policy': 'no-referrer',
      }).end();
      return;
    }
    outgoing.setHeader('Content-Type', 'application/json');
    outgoing.end(JSON.stringify({
      url: incoming.url, method: incoming.method, origin: incoming.headers.origin,
      clientAddress: incoming.headers['x-pixkit-client-ip'],
      cookie: incoming.headers.cookie, account: incoming.headers['x-pixkit-account'],
      body: Buffer.concat(chunks).toString(),
    }));
  });
  upstream.listen(socket);
  await once(upstream, 'listening');
  await chmod(socket, 0o600);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const callback = await relay('/auth/callback?code=fixture');
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.location, '/account/');
  assert.equal(callback.headers['set-cookie'].length, 2);
  assert.equal(callback.headers['cache-control'], 'private, no-store');
  assert.equal(callback.headers['server-timing'], 'app;dur=12');
  assert.equal((await relay('/assets/site.css')).headers['cache-control'], 'public, max-age=3600');
  assert.equal((await relay('/assets/unsafe.css')).headers['cache-control'], 'private, no-store');
  assert.equal((await relay('/account/')).headers['cache-control'], 'private, no-store');

  const payload = '{"token":"123456"}';
  const path = '/api/account/verify?value=a%2Bb';
  const result = await relay(path, { method: 'POST', headers: {
    Origin: appOrigin, Cookie: 'pixkit_access=fixture', 'X-PixKit-Account': 'fixture',
    'Content-Type': 'application/json',
  } }, payload);
  assert.deepEqual(JSON.parse(result.body), {
    url: path, method: 'POST', origin: appOrigin, cookie: 'pixkit_access=fixture',
    account: 'fixture', body: payload, clientAddress: '127.0.0.1',
  });
  assert.equal((await relay('/account/', { method: 'HEAD' })).body, '');
  assert.equal((await relay('/account/', { method: 'PUT' })).status, 405);
  assert.equal((await relay('/account/', { headers: { Host: 'other.invalid' } })).status, 421);
  assert.equal((await relay('/api/account/verify', { method: 'POST' }, 'x'.repeat(65537))).status, 413);

  const originFile = join(privateDirectory, 'pixkit-gateway-origin');
  const apexHeaders = { Host: 'pix-kit.com', Origin: apexOrigin, 'X-PixKit-Client-IP': '198.51.100.1' };
  await writeFile(originFile, `${apexOrigin}\n`, { mode: 0o600 });

  const apex = await relay('/account/logout/', { method: 'POST', headers: apexHeaders });
  assert.equal(apex.status, 200);
  assert.equal(JSON.parse(apex.body).origin, apexOrigin);
  assert.equal(JSON.parse(apex.body).clientAddress, '127.0.0.1');
  await new Promise((resolve) => upstream.close(resolve));
  assert.equal((await relay('/account/', { headers: apexHeaders })).status, 503);
});
