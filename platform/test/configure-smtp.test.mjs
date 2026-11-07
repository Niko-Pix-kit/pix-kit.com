import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
import { configureSmtp } from '../deploy/liquid-web/configure-smtp.mjs';

const secret = 'a'.repeat(64);
const original = `# Existing private settings\nPIXKIT_ORIGIN=https://pix-kit.com\nPIXKIT_DB_PASSWORD='private # value"\\'\nPIXKIT_OTHER='first line\nPIXKIT_SMTP_USER=part of an unrelated secret\nlast line'\nPIXKIT_EMAIL_FROM=info@pix-kit.com\nPIXKIT_EMAIL_OTP_SECRET=${secret}\nPIXKIT_EMAIL_SENDMAIL=/usr/sbin/sendmail\n`;
const values = ['smtp.gmail.com', '465', 'primary@example.com', '', 'abcd efgh ijkl mnop'];

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pixkit-smtp-setup-'));
  await chmod(directory, 0o700);
  const file = join(directory, 'pixkit-mariadb.env');
  await writeFile(file, original, { mode: 0o600 });
  try { await run(directory, file); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('SMTP setup preserves existing raw secrets, verifies first and saves private settings atomically', async () => {
  await fixture(async (directory, file) => {
    const { backup } = await configureSmtp({ privateDirectory: directory, values,
      verify: async sender => {
        assert.equal(typeof sender.verify, 'function');
        assert.equal(await readFile(file, 'utf8'), original);
        return true;
      } });
    const content = await readFile(file, 'utf8');
    const configured = parseEnv(content);
    assert.ok(content.includes("PIXKIT_DB_PASSWORD='private # value\"\\'\n"));
    assert.ok(content.includes("PIXKIT_OTHER='first line\nPIXKIT_SMTP_USER=part of an unrelated secret\nlast line'\n"));
    assert.equal(configured.PIXKIT_EMAIL_OTP_SECRET, secret);
    assert.equal(configured.PIXKIT_EMAIL_FROM, 'info@pix-kit.com');
    assert.equal(configured.PIXKIT_SMTP_PASSWORD, 'abcdefghijklmnop');
    assert.equal(configured.PIXKIT_SMTP_USER, 'primary@example.com');
    assert.equal(configured.PIXKIT_EMAIL_TRANSPORT, 'smtp');
    assert.equal(await readFile(backup, 'utf8'), original);
    assert.equal((await lstat(backup)).mode & 0o777, 0o600);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  });
});

test('failed SMTP authentication never changes or backs up the configuration and sanitizes errors', async () => {
  await fixture(async (directory, file) => {
    await assert.rejects(configureSmtp({ privateDirectory: directory, values,
      verify: async () => { throw Object.assign(new Error('sensitive password and server response'), { reason: 'authentication_failed' }); } }),
    error => error.reason === 'authentication_failed' && !error.message.includes('sensitive'));
    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual(await readdir(directory), ['pixkit-mariadb.env']);
  });
});

test('non-Google passwords retain spaces, quote characters, hashes and backslashes without dotenv corruption', async () => {
  await fixture(async (directory, file) => {
    const password = ` keep # \\" and ' characters `;
    await configureSmtp({ privateDirectory: directory, values: ['smtp.mailprovider.com', '587', 'primary@example.com', 'info@pix-kit.com', password], verify: async () => true });
    assert.equal(parseEnv(await readFile(file, 'utf8')).PIXKIT_SMTP_PASSWORD, password);
  });
});

test('SMTP setup refuses unsafe permissions and symlinked configuration without changing files', async () => {
  await fixture(async (directory, file) => {
    await chmod(file, 0o644);
    await assert.rejects(configureSmtp({ privateDirectory: directory, values, verify: async () => true }));
    await chmod(file, 0o600);
    const target = join(directory, 'original');
    await writeFile(target, original, { mode: 0o600 });
    await rm(file);
    await symlink(target, file);
    await assert.rejects(configureSmtp({ privateDirectory: directory, values, verify: async () => true }));
    assert.equal(await readFile(target, 'utf8'), original);
  });
});

test('concurrent configuration changes are retained instead of silently overwritten after verification', async () => {
  await fixture(async (directory, file) => {
    const changed = `${original}PIXKIT_NEW_SETTING=preserve-me\n`;
    await assert.rejects(configureSmtp({ privateDirectory: directory, values,
      verify: async () => { await writeFile(file, changed, { mode: 0o600 }); return true; } }));
    assert.equal(await readFile(file, 'utf8'), changed);
  });
});

test('a missing OTP secret is generated privately and unsupported dotenv password encodings leave the file unchanged', async () => {
  await fixture(async (directory, file) => {
    const missing = original.replace(`PIXKIT_EMAIL_OTP_SECRET=${secret}\n`, '');
    await writeFile(file, missing, { mode: 0o600 });
    await configureSmtp({ privateDirectory: directory, values, verify: async () => true });
    const configured = parseEnv(await readFile(file, 'utf8'));
    assert.match(configured.PIXKIT_EMAIL_OTP_SECRET, /^[a-f0-9]{64}$/);
    assert.notEqual(configured.PIXKIT_EMAIL_OTP_SECRET, secret);

    const saved = await readFile(file, 'utf8');
    await assert.rejects(configureSmtp({ privateDirectory: directory,
      values: ['smtp.mailprovider.com', '465', 'primary@example.com', '', ' contains \'"` # all delimiters '],
      verify: async () => { throw new Error('Unsafe encoding must be rejected before authentication'); } }));
    assert.equal(await readFile(file, 'utf8'), saved);
  });
});

test('a symlinked or broadly accessible private directory is refused', async () => {
  await fixture(async (directory, file) => {
    const alias = join(directory, 'alias');
    await symlink(directory, alias);
    await assert.rejects(configureSmtp({ privateDirectory: alias, values, verify: async () => true }));
    await chmod(directory, 0o755);
    await assert.rejects(configureSmtp({ privateDirectory: directory, values, verify: async () => true }));
    await chmod(directory, 0o700);
    assert.equal(await readFile(file, 'utf8'), original);
  });
});
