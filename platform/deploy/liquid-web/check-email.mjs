import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { emailConfiguration } from '../../server/email-configuration.mjs';
import { createSmtpTransport } from '../../server/smtp.mjs';

try {
  if (process.argv.length !== 3) throw new Error('Invalid private configuration path');
  const directory = realpathSync(process.argv[2]);
  const parent = lstatSync(directory);
  const file = `${directory}/pixkit-mariadb.env`;
  const stat = lstatSync(file);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700 ||
      !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('Invalid private configuration permissions');
  }
  const env = parseEnv(readFileSync(file, 'utf8'));
  const settings = emailConfiguration(env);
  if (settings?.transport === 'smtp') {
    if (env.PIXKIT_ORIGIN !== 'https://pix-kit.com') throw new Error('Invalid production origin');
    await createSmtpTransport({ ...settings, origin: env.PIXKIT_ORIGIN }).verify();
    console.log('SMTP TLS and authentication OK. No message was sent.');
  } else {
    console.log(settings ? 'Local mail submission configured; recipient delivery is not verified.' : 'Email delivery is disabled.');
  }
} catch (error) {
  const reasons = new Set(['authentication_failed', 'tls_failed', 'timeout', 'connection_failed', 'submission_failed']);
  const reason = reasons.has(error?.reason) ? error.reason : 'configuration_or_transport_failed';
  console.error(`Email preflight failed: ${reason}. Private credentials were not displayed.`);
  process.exitCode = 1;
}
