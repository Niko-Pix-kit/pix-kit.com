import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import locales from '../../data/i18n/locales.json' with { type: 'json' };
import messages from '../ui/email-messages.json' with { type: 'json' };
import { normalizeEmail } from './email-auth.mjs';

const logo = readFileSync(new URL('../../assets/pix-kit-logo-symbol.png', import.meta.url));
const byCode = new Map(locales.map(locale => [locale.code, locale]));
const base64 = (value) => Buffer.from(value).toString('base64').match(/.{1,76}/g).join('\r\n');
const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function encodedHeader(value) {
  const words = [];
  let chunk = '';
  for (const character of value) {
    if (Buffer.byteLength(chunk + character) > 36) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return words.join('\r\n ');
}

function verificationMessage({ from, email, verificationUrl, locale, purpose }) {
  const language = byCode.get(locale) ?? byCode.get('en');
  const copy = messages[language.code];
  const subject = purpose === 'reset' ? copy.resetSubject : copy.subject;
  const action = purpose === 'reset' ? copy.resetTitle : copy.title;
  const text = `${subject}\r\n\r\n${copy.instruction}\r\n\r\n${action}:\r\n${verificationUrl}\r\n\r\n${copy.expiry}\r\n\r\n${copy.ignore}\r\n`;
  const html = `<!doctype html>
<html lang="${language.tag}" dir="${language.dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f3f8fc;color:#101b2d;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#fff;border:1px solid #dce7ef;border-radius:20px">
<tr><td style="padding:28px 32px;border-bottom:4px solid #ff7100">
<img src="cid:pixkit-logo" alt="" width="44" height="44" style="vertical-align:middle;margin-inline-end:12px">
<span style="font-size:28px;font-weight:bold"><span style="color:#008acb">P</span>ix-<span style="color:#ff7100">k</span>it</span></td></tr>
<tr><td style="padding:28px 32px"><h1 style="font-size:24px;margin:0 0 20px">${escape(subject)}</h1>
<p>${escape(copy.instruction)}</p>
<p style="padding:12px 0"><a href="${escape(verificationUrl)}" style="display:inline-block;padding:16px 24px;background:#edf6fd;border:1px solid #008acb;border-radius:12px;color:#0067b1;font-size:17px;font-weight:bold;text-decoration:none">${escape(action)}</a></p>
<p style="color:#59687b">${escape(copy.expiry)}</p><p style="font-size:13px;color:#59687b">${escape(copy.ignore)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const id = randomBytes(16).toString('hex');
  const related = `pixkit-related-${id}`;
  const alternative = `pixkit-alternative-${id}`;
  return [
    `From: Pix-kit <${from}>`, `To: ${email}`,
    `Subject: ${encodedHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0', `Content-Type: multipart/related; boundary="${related}"`, '',
    `--${related}`, `Content-Type: multipart/alternative; boundary="${alternative}"`, '',
    `--${alternative}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(text),
    `--${alternative}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(html),
    `--${alternative}--`, '', `--${related}`, 'Content-Type: image/png', 'Content-Transfer-Encoding: base64',
    'Content-ID: <pixkit-logo>', 'Content-Disposition: inline; filename="pixkit.png"', '', base64(logo),
    `--${related}--`, '',
  ].join('\r\n');
}

function mailOrigin(origin) {
  let site;
  try {
    site = new URL(origin);
  } catch {
    throw new TypeError('Email delivery requires a valid HTTPS origin');
  }
  if (site.protocol !== 'https:' || site.origin !== origin || site.username || site.password) {
    throw new TypeError('Email delivery requires a valid HTTPS origin');
  }
  return site;
}

/** Build the same validated branded MIME message for local and authenticated transports. */
export function buildVerificationMessage({ from, origin = 'https://pix-kit.com', email, verificationUrl, locale, purpose = 'signup' }) {
  const sender = normalizeEmail(from);
  const recipient = normalizeEmail(email);
  const site = mailOrigin(origin);
  let link;
  try {
    link = new URL(verificationUrl);
  } catch {
    throw new TypeError('Invalid verification message');
  }
  const fragment = new URLSearchParams(link.hash.slice(1));
  const token = /^[A-Za-z0-9_-]{43}$/;
  if (!sender || !recipient || !['signup', 'reset'].includes(purpose) ||
      link.origin !== site.origin || link.username || link.password || link.search ||
      !/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?account\/email\/confirm\/$/.test(link.pathname) ||
      fragment.getAll('selector').length !== 1 || fragment.getAll('token').length !== 1 ||
      !token.test(fragment.get('selector') ?? '') || !token.test(fragment.get('token') ?? '') ||
      fragment.getAll('purpose').length !== 1 || fragment.get('purpose') !== purpose ||
      [...fragment.keys()].some(key => !['selector', 'token', 'purpose'].includes(key))) {
    throw new TypeError('Invalid verification message');
  }
  return verificationMessage({ from: sender, email: recipient, verificationUrl: link.href, locale, purpose });
}

export function createSendmailTransport({ executable, from, origin = 'https://pix-kit.com' }) {
  const sender = normalizeEmail(from);
  mailOrigin(origin);
  if (typeof executable !== 'string' || !isAbsolute(executable) || !sender) {
    throw new TypeError('Email delivery requires an absolute sendmail path and a sender address');
  }

  return function sendCode({ email, verificationUrl, locale, purpose = 'signup' }) {
    const message = buildVerificationMessage({ from: sender, origin, email, verificationUrl, locale, purpose });
    return new Promise((resolve, reject) => {
      let diagnostic = '';
      let inputError;
      const failure = (exitCode, transportCode) => {
        const error = new Error('Verification email could not be submitted');
        error.code = 'MAIL_SUBMISSION_FAILED';
        if (Number.isInteger(exitCode)) error.exitCode = exitCode;
        if (typeof transportCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(transportCode)) {
          error.transportCode = transportCode;
        }
        error.reason = /permission denied|operation not permitted/i.test(diagnostic) ? 'permission_denied'
          : /queue|qmail-inject|unable to chdir/i.test(diagnostic) ? 'queue_unavailable' : 'submission_failed';
        reject(error);
      };
      const delivery = spawn(executable, ['-i', '-t', '-f', sender], {
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
        stdio: ['pipe', 'ignore', 'pipe'],
        signal: AbortSignal.timeout(5000), killSignal: 'SIGKILL',
      });
      delivery.stderr.on('data', chunk => {
        // Retain only a bounded diagnostic in memory; expose fixed categories, never raw mail data.
        if (diagnostic.length < 4096) diagnostic += chunk.toString('utf8').slice(0, 4096 - diagnostic.length);
      });
      delivery.once('error', error => failure(undefined, error.code));
      delivery.stdin.once('error', error => { inputError = error; });
      delivery.once('close', exitCode => exitCode === 0 && !inputError ? resolve() : failure(exitCode, inputError?.code));
      delivery.stdin.end(message);
    });
  };
}
