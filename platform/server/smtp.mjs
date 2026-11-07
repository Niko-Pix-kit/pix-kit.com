import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { normalizeEmail } from './email-auth.mjs';
import { buildVerificationMessage } from './sendmail.mjs';

const reservedDomains = new Set(['localhost', 'local', 'localdomain', 'internal', 'invalid', 'example', 'test', 'onion', 'home', 'lan']);
const errorReasons = new Map([
  ['EAUTH', 'authentication_failed'],
  ['ENOAUTH', 'authentication_failed'],
  ['ETIMEDOUT', 'timeout'],
  ['ECONNECTION', 'connection_failed'],
  ['ECONNREFUSED', 'connection_failed'],
  ['ECONNRESET', 'connection_failed'],
  ['ESOCKET', 'connection_failed'],
  ['EDNS', 'connection_failed'],
  ['ENOTFOUND', 'connection_failed'],
  ['ETLS', 'tls_failed'],
  ['EREQUIRETLS', 'tls_failed'],
  ['CERT_HAS_EXPIRED', 'tls_failed'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_failed'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_failed'],
  ['EENVELOPE', 'recipient_rejected'],
  ['EMESSAGE', 'submission_failed'],
]);

function smtpHost(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.trim() || isIP(value)) return null;
  const host = value.toLowerCase();
  const labels = host.split('.');
  if (labels.length < 2 || !/^[a-z]{2,63}$/.test(labels.at(-1)) ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      reservedDomains.has(labels.at(-1))) return null;
  return host;
}

function submissionFailure(error) {
  const failure = new Error('Verification email could not be submitted');
  failure.code = 'MAIL_SUBMISSION_FAILED';
  const code = errorReasons.has(error?.code) ? error.code : null;
  if (code) failure.transportCode = code;
  failure.reason = errorReasons.get(code) ?? 'submission_failed';
  return failure;
}

/** SMTP configuration is server-owned; request data can only supply a validated verification message. */
export function createSmtpTransport({ host, port, secure, user, password, from, origin = 'https://pix-kit.com' },
  { transportFactory = nodemailer.createTransport } = {}) {
  const hostname = smtpHost(host);
  const sender = normalizeEmail(from);
  let site;
  try {
    site = new URL(origin);
  } catch {
    throw new TypeError('SMTP delivery requires a valid HTTPS origin');
  }
  if (!hostname || !sender || !Number.isInteger(port) ||
      !((port === 465 && secure === true) || (port === 587 && secure === false)) ||
      site.protocol !== 'https:' || site.origin !== origin || site.username || site.password ||
      typeof user !== 'string' || !user || user !== user.trim() || Buffer.byteLength(user) > 1024 ||
      typeof password !== 'string' || !password.trim() || Buffer.byteLength(password) > 4096 ||
      /[\u0000-\u001f\u007f]/.test(user) || /[\u0000-\u001f\u007f]/.test(password) ||
      typeof transportFactory !== 'function') {
    throw new TypeError('SMTP delivery requires an authenticated public host and TLS port 465 or 587');
  }

  let transport;
  try {
    transport = transportFactory({
      host: hostname, port, secure,
      auth: { user, pass: password },
      forceAuth: true,
      requireTLS: port === 587,
      ignoreTLS: false,
      opportunisticTLS: false,
      tls: { servername: hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10_000,
      dnsTimeout: 5000,
      pool: false,
      logger: false,
      debug: false,
      transactionLog: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } catch {
    throw new TypeError('SMTP transport could not be configured');
  }
  if (!transport || typeof transport.sendMail !== 'function' || typeof transport.verify !== 'function') {
    throw new TypeError('SMTP transport could not be configured');
  }

  function sendCode({ email, verificationUrl, locale, purpose = 'signup' }) {
    const recipient = normalizeEmail(email);
    const raw = buildVerificationMessage({ from: sender, origin, email, verificationUrl, locale, purpose });
    return Promise.resolve().then(() => transport.sendMail({
      envelope: { from: sender, to: [recipient] },
      raw,
      disableFileAccess: true,
      disableUrlAccess: true,
    })).then(info => {
      if (!Array.isArray(info?.accepted) || info.accepted.length !== 1 ||
          normalizeEmail(info.accepted[0]) !== recipient ||
          (Array.isArray(info.rejected) && info.rejected.length > 0)) {
        throw submissionFailure({ code: 'EENVELOPE' });
      }
    }, error => {
      throw submissionFailure(error);
    });
  }

  /** Verify the connection, certificate and authentication without submitting a message. */
  sendCode.verify = async () => {
    try {
      if (await transport.verify() !== true) throw submissionFailure();
      return true;
    } catch (error) {
      throw submissionFailure(error);
    }
  };
  return sendCode;
}
