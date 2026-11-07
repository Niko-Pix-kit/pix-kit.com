import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeCountryCode, normalizeNickname } from '../profile.mjs';
import { hashPassword, validNewPassword, verifyPassword } from './passwords.mjs';
import { mailDiagnostic } from './mail-diagnostic.mjs';

export { validNewPassword } from './passwords.mjs';

export const EMAIL_FLOW_SECONDS = 1800;
const windowMs = 60 * 60 * 1000;
const resendMs = 60 * 1000;
const mailboxLimit = 5;
const siteLimit = 120;
const flowPattern = /^[A-Za-z0-9_-]{43}$/;
const retryable = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

export function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const address = value.trim();
  if (address.length > 254) return '';
  const [local, domain, extra] = address.split('@');
  if (extra !== undefined || local.length > 64 ||
      !/^[a-z\d!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z\d!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local) ||
      !domain || !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(domain)) {
    return '';
  }
  return `${local}@${domain.toLowerCase()}`;
}

function profileName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim().normalize('NFC');
  return name && [...name].length <= 60 && !/[\p{Cc}\p{Cs}]/u.test(name) ? name : '';
}

export function normalizeSignupProfile(profile, languages) {
  if (!profile) return null;
  const givenName = profileName(profile.givenName);
  const familyName = profileName(profile.familyName);
  const countryCode = normalizeCountryCode(profile.countryCode);
  const { preferredLocale } = profile;
  const nickname = normalizeNickname(profile.nickname);
  if (!nickname || !givenName || !familyName || !countryCode || !languages.has(preferredLocale)) return null;
  return { nickname, givenName, familyName, countryCode, preferredLocale };
}

function sessionHash(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  if (typeof value === 'string' && /^[a-f\d]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  throw new TypeError('Invalid session token hash');
}

function digestMatches(actual, expected) {
  return Buffer.isBuffer(actual) && actual.length === expected.length && timingSafeEqual(actual, expected);
}

function windowState(row, now) {
  const start = Number(row?.window_start ?? 0);
  return start <= now && now - start < windowMs
    ? { start, count: Number(row?.issued_count ?? 0) }
    : { start: now, count: 0 };
}

async function transact(pool, write) {
  for (let retry = 0; ; retry += 1) {
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const result = await write(connection);
      await connection.commit();
      return result;
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      if (error?.code === 'ER_DUP_ENTRY') return false;
      if (retry >= 2 || !retryable.has(error?.code)) throw new Error('Email account database operation failed');
    } finally {
      if (connection) await connection.release().catch(() => {});
    }
  }
}

export function createEmailAuth({ pool, sendCode, secret, languages, origin, now = Date.now, onSubmissionFailure = () => {} }) {
  if (typeof secret !== 'string' || !/^[a-f\d]{64}$/i.test(secret) || typeof sendCode !== 'function') {
    throw new TypeError('Email links require a 32-byte hexadecimal secret and a mail transport');
  }
  const publicOrigin = new URL(origin);
  if (publicOrigin.origin !== origin || publicOrigin.protocol !== 'https:') {
    throw new TypeError('Email links require the canonical HTTPS origin');
  }
  const key = Buffer.from(secret, 'hex');
  const supported = new Set(languages);
  const hmac = (purpose, value) => createHmac('sha256', key).update(`${purpose}\0${value}`).digest();
  const hashFlow = (flowToken) => createHash('sha256').update(flowToken).digest();

  async function requestLink({ email, profile = null, locale, password, purpose = 'signup', source }) {
    const address = normalizeEmail(email);
    const signup = normalizeSignupProfile(profile, supported);
    if (!['signup', 'reset'].includes(purpose) || !address ||
        (purpose === 'signup' && (!signup || !validNewPassword(password)))) {
      throw new TypeError('Invalid email signup details');
    }

    const emailKey = hmac('email', address);
    const flowToken = randomBytes(32).toString('base64url');
    const verificationToken = randomBytes(32).toString('base64url');
    const current = now();
    const reserved = await transact(pool, async (connection) => {
      const [site] = await connection.query(`
        SELECT window_start, issued_count FROM pixkit_email_send_limit WHERE scope_id = 1 FOR UPDATE
      `);
      if (!site) throw new Error('Missing email rate limit');
      const global = windowState(site, current);
      if (global.count >= siteLimit) return false;

      const budgets = [];
      for (const [purpose, subject, limit, resend] of [
        ...(typeof source === 'string' && source.length > 0 && source.length <= 128 ? [['mail-source', source, 20, false]] : []),
        ['mail-delivery', address.toLowerCase(), mailboxLimit, true],
      ]) {
        const subjectKey = hmac(purpose, subject);
        await connection.query(`
          INSERT IGNORE INTO pixkit_email_delivery_limits
            (subject_key, window_start, issued_count, issued_at) VALUES (?, ?, 0, 0)
        `, [subjectKey, current]);
        const [row] = await connection.query(`
          SELECT window_start, issued_count, issued_at
          FROM pixkit_email_delivery_limits WHERE subject_key = ? FOR UPDATE
        `, [subjectKey]);
        const state = windowState(row, current);
        if (state.count >= limit || (resend && Number(row.issued_at) && current - Number(row.issued_at) < resendMs)) return false;
        budgets.push({ subjectKey, ...state });
      }
      for (const budget of budgets) {
        await connection.query(`
          UPDATE pixkit_email_delivery_limits SET window_start = ?, issued_count = ?, issued_at = ? WHERE subject_key = ?
        `, [budget.start, budget.count + 1, current, budget.subjectKey]);
      }
      const recipient = budgets.at(-1);
      await connection.query(`
        DELETE FROM pixkit_email_delivery_limits WHERE window_start < ? ORDER BY window_start LIMIT 100
      `, [current - windowMs]);

      await connection.query(`
        UPDATE pixkit_email_send_limit SET window_start = ?, issued_count = ? WHERE scope_id = 1
      `, [global.start, global.count + 1]);
      await connection.query(`
        INSERT INTO pixkit_email_challenges
          (email_key, flow_hash, code_hash, signup_profile, attempts_left, issued_at, expires_at,
           window_start, issued_count, purpose, password_hash, email_address, verification_hash)
        VALUES (?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON DUPLICATE KEY UPDATE
          flow_hash = VALUES(flow_hash), code_hash = NULL, signup_profile = VALUES(signup_profile),
          attempts_left = VALUES(attempts_left), issued_at = VALUES(issued_at), expires_at = VALUES(expires_at),
          window_start = VALUES(window_start), issued_count = VALUES(issued_count),
          purpose = VALUES(purpose), password_hash = NULL, email_address = VALUES(email_address),
          verification_hash = VALUES(verification_hash)
      `, [emailKey, hashFlow(flowToken), signup ? JSON.stringify(signup) : null,
        current, current + EMAIL_FLOW_SECONDS * 1000, recipient.start, recipient.count + 1, purpose,
        Buffer.from(address, 'ascii'), hmac('verification', verificationToken)]);
      await connection.query(`
        DELETE FROM pixkit_email_challenges WHERE window_start <= ? AND expires_at <= ?
        ORDER BY window_start LIMIT 100
      `, [current - windowMs, current]);
      await connection.query(`
        UPDATE pixkit_email_challenges SET flow_hash = NULL, code_hash = NULL, signup_profile = NULL,
          password_hash = NULL, email_address = NULL, verification_hash = NULL, attempts_left = 0
        WHERE expires_at <= ? AND flow_hash IS NOT NULL ORDER BY expires_at LIMIT 100
      `, [current]);
      return true;
    });
    if (!reserved) return null;
    const passwordHash = purpose === 'signup' ? await hashPassword(password) : null;
    const [identity] = await pool.query(
      'SELECT password_hash FROM pixkit_email_identities WHERE email = ?', [Buffer.from(address, 'ascii')],
    ).catch(() => { throw new Error('Email account database operation failed'); });
    // Keep responses indistinguishable without leaving an activatable challenge for an unknown reset or existing account.
    if ((purpose === 'reset' && !identity) || (purpose === 'signup' && identity?.password_hash)) {
      await pool.query(`
        UPDATE pixkit_email_challenges SET flow_hash = NULL, verification_hash = NULL,
          email_address = NULL, signup_profile = NULL, password_hash = NULL, attempts_left = 0
        WHERE email_key = ? AND flow_hash = ?
      `, [emailKey, hashFlow(flowToken)]).catch(() => { throw new Error('Email account database operation failed'); });
      return flowToken;
    }
    const pending = await pool.query(`
      UPDATE pixkit_email_challenges SET password_hash = ?, attempts_left = 5
      WHERE email_key = ? AND flow_hash = ? AND expires_at > ?
    `, [passwordHash, emailKey, hashFlow(flowToken), now()])
      .catch(() => { throw new Error('Email account database operation failed'); });
    if (!pending.affectedRows) return null;
    const messageLocale = supported.has(signup?.preferredLocale ?? locale) ? signup?.preferredLocale ?? locale : 'en';
    const verificationUrl = new URL(`${messageLocale === 'en' ? '' : '/' + messageLocale}/account/email/confirm/`, publicOrigin);
    verificationUrl.hash = new URLSearchParams({ selector: emailKey.toString('base64url'), token: verificationToken, purpose }).toString();
    try {
      await sendCode({ email: address, verificationUrl: verificationUrl.href, locale: messageLocale, purpose });
    } catch (error) {
      await pool.query(`
        UPDATE pixkit_email_challenges
        SET flow_hash = NULL, code_hash = NULL, signup_profile = NULL, password_hash = NULL,
          email_address = NULL, verification_hash = NULL, attempts_left = 0
        WHERE email_key = ? AND flow_hash = ?
      `, [emailKey, hashFlow(flowToken)]).catch(() => {});
      try { onSubmissionFailure(mailDiagnostic(error)); } catch { /* Logging must not change account behavior. */ }
      throw new Error('Verification email could not be submitted');
    }
    return flowToken;
  }

  async function reservePasswordAttempt(address, source) {
    const current = now();
    const window = 15 * 60 * 1000;
    return transact(pool, async connection => {
      // Source and mailbox counters have independent namespaces and a stable lock order.
      for (const [purpose, subject, limit] of [
        ...(typeof source === 'string' && source.length > 0 && source.length <= 128 ? [['password-source', source, 60]] : []),
        ['password-mailbox', address, 20],
      ]) {
        const subjectKey = hmac(purpose, subject);
        await connection.query(`
          INSERT IGNORE INTO pixkit_password_limits (subject_key, window_start, attempts) VALUES (?, ?, 0)
        `, [subjectKey, current]);
        const [row] = await connection.query(`
          SELECT window_start, attempts FROM pixkit_password_limits WHERE subject_key = ? FOR UPDATE
        `, [subjectKey]);
        const active = Number(row.window_start) <= current && current - Number(row.window_start) < window;
        const count = active ? Number(row.attempts) : 0;
        if (count >= limit) return false;
        await connection.query(`
          UPDATE pixkit_password_limits SET window_start = ?, attempts = ? WHERE subject_key = ?
        `, [active ? Number(row.window_start) : current, count + 1, subjectKey]);
      }
      await connection.query(`
        DELETE FROM pixkit_password_limits WHERE window_start < ? ORDER BY window_start LIMIT 100
      `, [current - window]);
      return true;
    });
  }

  return {
    requestLink,
    requestPasswordReset(input) { return requestLink({ ...input, profile: null, purpose: 'reset' }); },

    async signIn({ email, password, sessionTokenHash, expiresAt, replaceSessionHash, source }) {
      const address = normalizeEmail(email);
      if (!address || typeof password !== 'string' || Buffer.byteLength(password) > 512) return false;
      const hash = sessionHash(sessionTokenHash);
      const oldHash = replaceSessionHash === undefined ? null : sessionHash(replaceSessionHash);
      if (oldHash?.equals(hash)) throw new TypeError('Invalid session token replacement');
      if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.valueOf()) || expiresAt.valueOf() <= now()) {
        throw new TypeError('Invalid session expiry');
      }
      if (!await reservePasswordAttempt(address, source)) return false;
      const [identity] = await pool.query(`
        SELECT user_id, password_hash FROM pixkit_email_identities WHERE email = ? AND verified_at IS NOT NULL
      `, [Buffer.from(address, 'ascii')]).catch(() => { throw new Error('Email account database operation failed'); });
      if (!await verifyPassword(password, identity?.password_hash)) return false;
      return transact(pool, async connection => {
        const [current] = await connection.query(`
          SELECT user_id, password_hash FROM pixkit_email_identities WHERE email = ? AND verified_at IS NOT NULL FOR UPDATE
        `, [Buffer.from(address, 'ascii')]);
        if (!current || current.password_hash !== identity.password_hash) return false;
        await connection.query(`
          UPDATE pixkit_users SET last_sign_in_at = GREATEST(last_sign_in_at, UTC_TIMESTAMP(3)) WHERE id = ?
        `, [current.user_id]);
        await connection.query(`
          INSERT INTO pixkit_sessions (token_hash, user_id, created_at, expires_at)
          VALUES (?, ?, UTC_TIMESTAMP(3), ?)
        `, [hash, current.user_id, expiresAt.toISOString().slice(0, -1).replace('T', ' ')]);
        if (oldHash) await connection.query('DELETE FROM pixkit_sessions WHERE token_hash = ?', [oldHash]);
        await connection.query('DELETE FROM pixkit_password_limits WHERE subject_key = ?', [hmac('password-mailbox', address)]);
        return true;
      });
    },

    async verifyLink({ selector, verificationToken, password, sessionTokenHash, expiresAt, replaceSessionHash }) {
      if (typeof selector !== 'string' || !flowPattern.test(selector) ||
          typeof verificationToken !== 'string' || !flowPattern.test(verificationToken) ||
          typeof password !== 'string' || Buffer.byteLength(password) > 512) return false;
      const current = now();
      if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.valueOf()) || expiresAt.valueOf() <= current) {
        throw new TypeError('Invalid session expiry');
      }
      const expiry = expiresAt.toISOString().slice(0, -1).replace('T', ' ');
      const hash = sessionHash(sessionTokenHash);
      const oldHash = replaceSessionHash === undefined ? null : sessionHash(replaceSessionHash);
      if (oldHash?.equals(hash)) throw new TypeError('Invalid session token replacement');
      const emailKey = Buffer.from(selector, 'base64url');
      const verificationHash = hmac('verification', verificationToken);

      return transact(pool, async (connection) => {
        const [challenge] = await connection.query(`
          SELECT email_address, verification_hash, signup_profile, password_hash, purpose, attempts_left, expires_at
          FROM pixkit_email_challenges WHERE email_key = ? FOR UPDATE
        `, [emailKey]);
        if (!challenge || !digestMatches(challenge.verification_hash, verificationHash) ||
            Number(challenge.expires_at) <= current || !Number(challenge.attempts_left)) return false;
        const address = normalizeEmail(challenge.email_address?.toString('ascii'));
        if (!address || !digestMatches(hmac('email', address), emailKey)) return false;
        if (challenge.purpose === 'signup') {
          if (!await verifyPassword(password, challenge.password_hash)) {
            await connection.query('UPDATE pixkit_email_challenges SET attempts_left = attempts_left - 1 WHERE email_key = ?', [emailKey]);
            return false;
          }
        } else if (challenge.purpose === 'reset' && validNewPassword(password)) {
          challenge.password_hash = await hashPassword(password);
        } else {
          return false;
        }
        if (Number(challenge.expires_at) <= now()) return false;
        await connection.query(`
          UPDATE pixkit_email_challenges SET flow_hash = NULL, code_hash = NULL, signup_profile = NULL,
            password_hash = NULL, email_address = NULL, verification_hash = NULL, attempts_left = 0
          WHERE email_key = ?
        `, [emailKey]);

        const [identity] = await connection.query(`
          SELECT user_id, password_hash FROM pixkit_email_identities WHERE email = ? FOR UPDATE
        `, [Buffer.from(address, 'ascii')]);
        let userId = identity?.user_id;
        if (userId) {
          if (challenge.purpose === 'signup' && identity.password_hash) return false;
          await connection.query(`
            UPDATE pixkit_email_identities SET password_hash = ?, verified_at = UTC_TIMESTAMP(3) WHERE email = ?
          `, [challenge.password_hash, Buffer.from(address, 'ascii')]);
          // Password setup and recovery invalidate earlier sessions on every device.
          await connection.query('DELETE FROM pixkit_sessions WHERE user_id = ?', [userId]);
          await connection.query(`
            UPDATE pixkit_users SET last_sign_in_at = GREATEST(last_sign_in_at, UTC_TIMESTAMP(3)) WHERE id = ?
          `, [userId]);
        } else if (challenge.purpose === 'signup' && challenge.signup_profile) {
          const signup = typeof challenge.signup_profile === 'string'
            ? JSON.parse(challenge.signup_profile) : challenge.signup_profile;
          const { nickname, givenName, familyName, countryCode, preferredLocale } = signup;
          userId = randomUUID();
          await connection.query(`
            INSERT INTO pixkit_users
              (id, email, display_name, nickname, given_name, family_name, country_code, preferred_locale,
               created_at, last_sign_in_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
          `, [userId, address, [...`${givenName} ${familyName}`].slice(0, 120).join(''), nickname,
            givenName, familyName, countryCode, preferredLocale]);
          await connection.query(`
            INSERT INTO pixkit_email_identities (email, user_id, password_hash, verified_at)
            VALUES (?, ?, ?, UTC_TIMESTAMP(3))
          `, [Buffer.from(address, 'ascii'), userId, challenge.password_hash]);
        } else {
          return false;
        }
        // Recovery confirms only a password change. A separate login prevents reset-link login CSRF.
        if (challenge.purpose === 'signup') {
          await connection.query(`
            INSERT INTO pixkit_sessions (token_hash, user_id, created_at, expires_at)
            VALUES (?, ?, UTC_TIMESTAMP(3), ?)
          `, [hash, userId, expiry]);
        }
        if (oldHash) await connection.query('DELETE FROM pixkit_sessions WHERE token_hash = ?', [oldHash]);
        await connection.query('DELETE FROM pixkit_password_limits WHERE subject_key = ?', [hmac('password-mailbox', address)]);
        return { verified: true, purpose: challenge.purpose };
      });
    },
  };
}
