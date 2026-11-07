import { normalizeEmail } from './email-auth.mjs';

/** Resolve private email configuration without exposing credential values in errors. */
export function emailConfiguration(env) {
  const base = ['PIXKIT_EMAIL_FROM', 'PIXKIT_EMAIL_OTP_SECRET', 'PIXKIT_EMAIL_SENDMAIL', 'PIXKIT_EMAIL_TRANSPORT'];
  const smtp = ['PIXKIT_SMTP_HOST', 'PIXKIT_SMTP_PORT', 'PIXKIT_SMTP_USER', 'PIXKIT_SMTP_PASSWORD'];
  if (![...base, ...smtp].some(name => Boolean(env[name]))) return null;
  const from = normalizeEmail(env.PIXKIT_EMAIL_FROM);
  const secret = env.PIXKIT_EMAIL_OTP_SECRET;
  if (!from || typeof secret !== 'string' || !/^[a-f\d]{64}$/i.test(secret)) {
    throw new TypeError('Email delivery requires a valid sender and a 32-byte hexadecimal secret');
  }
  const transport = env.PIXKIT_EMAIL_TRANSPORT || 'sendmail';
  if (transport === 'sendmail') {
    if (smtp.some(name => Boolean(env[name])) || typeof env.PIXKIT_EMAIL_SENDMAIL !== 'string' ||
        !env.PIXKIT_EMAIL_SENDMAIL.startsWith('/') || /[\0\r\n]/.test(env.PIXKIT_EMAIL_SENDMAIL)) {
      throw new TypeError('Sendmail requires an absolute executable path; SMTP settings require the SMTP transport');
    }
    return { transport, from, secret, executable: env.PIXKIT_EMAIL_SENDMAIL };
  }
  if (transport !== 'smtp' || smtp.some(name => !env[name]) ||
      !['465', '587'].includes(env.PIXKIT_SMTP_PORT)) {
    throw new TypeError('SMTP requires a host, port 465 or 587, username and password');
  }
  return {
    transport, from, secret, host: env.PIXKIT_SMTP_HOST,
    port: Number(env.PIXKIT_SMTP_PORT), secure: env.PIXKIT_SMTP_PORT === '465',
    user: env.PIXKIT_SMTP_USER, password: env.PIXKIT_SMTP_PASSWORD,
  };
}
