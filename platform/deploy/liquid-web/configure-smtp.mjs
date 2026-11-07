import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { emailConfiguration } from '../../server/email-configuration.mjs';
import { createSmtpTransport } from '../../server/smtp.mjs';

const transportReasons = new Set(['authentication_failed', 'tls_failed', 'timeout', 'connection_failed', 'submission_failed']);
function failure(reason = 'configuration_or_transport_failed') {
  const error = new Error('SMTP setup failed; private credentials were not displayed.');
  error.reason = transportReasons.has(reason) ? reason : 'configuration_or_transport_failed';
  return error;
}

function privateConfiguration(directory) {
  if (!isAbsolute(directory)) throw failure();
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) throw failure();
  const canonical = realpathSync(directory);
  const file = join(canonical, 'pixkit-mariadb.env');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw failure();
  return { directory: canonical, file, original: readFileSync(file, 'utf8'), stat };
}

function encode(value) {
  for (const quote of ["'", '"', '`', '']) {
    const encoded = `${quote}${value}${quote}`;
    const parsed = parseEnv(`VALUE=${encoded}\n`);
    if (Object.keys(parsed).length === 1 && parsed.VALUE === value) return encoded;
  }
  throw failure();
}

function updatedConfiguration(original, settings) {
  const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let next = '';
  for (let index = 0; index < lines.length; index += 1) {
    let entry = lines[index];
    const assignment = entry.match(/^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=[\t ]*/);
    if (assignment) {
      let value = entry.slice(assignment[0].length);
      if (["'", '"', '`'].includes(value[0])) {
        const quote = value[0];
        while (!value.slice(1).includes(quote) && index + 1 < lines.length) {
          const continuation = lines[++index];
          entry += continuation;
          value += continuation;
        }
      }
    }
    if (!assignment || !Object.hasOwn(settings, assignment[1])) next += entry;
  }
  if (next && !next.endsWith('\n')) next += '\n';
  for (const [key, value] of Object.entries(settings)) next += `${key}=${encode(value)}\n`;
  const expected = { ...parseEnv(original), ...settings };
  const actual = parseEnv(next);
  if (Object.keys(actual).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)) throw failure();
  return next;
}

function durableFile(file, value) {
  const descriptor = openSync(file, 'wx', 0o600);
  try { writeFileSync(descriptor, value); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Validate and authenticate before atomically changing only private mail settings. */
export async function configureSmtp({ privateDirectory, values, verify = sender => sender.verify() }) {
  const initial = privateConfiguration(privateDirectory);
  if (!Array.isArray(values) || values.length !== 5 || values.some(value => typeof value !== 'string')) throw failure();
  const existing = parseEnv(initial.original);
  const [host, port, user, from, password] = values;
  const hostname = host.trim().toLowerCase();
  const settings = {
    PIXKIT_EMAIL_TRANSPORT: 'smtp',
    PIXKIT_EMAIL_FROM: from.trim() || existing.PIXKIT_EMAIL_FROM || 'info@pix-kit.com',
    PIXKIT_EMAIL_OTP_SECRET: existing.PIXKIT_EMAIL_OTP_SECRET || randomBytes(32).toString('hex'),
    PIXKIT_SMTP_HOST: hostname,
    PIXKIT_SMTP_PORT: port.trim(),
    PIXKIT_SMTP_USER: user.trim(),
    PIXKIT_SMTP_PASSWORD: hostname === 'smtp.gmail.com' ? password.replace(/[ \t]/g, '') : password,
  };
  if (existing.PIXKIT_ORIGIN !== 'https://pix-kit.com') throw failure();
  const configuration = emailConfiguration({ ...existing, ...settings });
  const sender = createSmtpTransport({ ...configuration, origin: existing.PIXKIT_ORIGIN });
  const next = updatedConfiguration(initial.original, settings);
  try { if (await verify(sender) !== true) throw failure(); } catch (error) { throw failure(error?.reason); }
  const current = privateConfiguration(privateDirectory);
  if (current.directory !== initial.directory || current.stat.dev !== initial.stat.dev ||
      current.stat.ino !== initial.stat.ino || current.original !== initial.original) throw failure();

  const suffix = randomBytes(12).toString('hex');
  const backup = join(initial.directory, `pixkit-smtp-backup.${suffix}`);
  const temporary = join(initial.directory, `pixkit-smtp-update.${suffix}`);
  try {
    durableFile(backup, initial.original);
    durableFile(temporary, next);
    renameSync(temporary, initial.file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { backup };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    if (process.argv.length !== 3) throw failure();
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 12_288) throw failure();
      chunks.push(chunk);
    }
    const fields = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).split('\0');
    if (fields.pop() !== '' || fields.length !== 5) throw failure();
    const { backup } = await configureSmtp({ privateDirectory: process.argv[2], values: fields });
    console.log('SMTP TLS and authentication OK. Private configuration saved. No email was sent.');
    console.log(`Backup: ${backup}`);
  } catch (error) {
    console.error(`SMTP setup failed: ${transportReasons.has(error?.reason) ? error.reason : 'configuration_or_transport_failed'}. Private credentials were not displayed.`);
    process.exitCode = 1;
  }
}
