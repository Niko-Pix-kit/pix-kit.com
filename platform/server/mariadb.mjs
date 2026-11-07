import { randomInt, randomUUID } from 'node:crypto';
import { normalizeNickname, presetAvatarUrl, publicProfile } from '../profile.mjs';

const USER_FIELDS = `
  u.id, u.email, u.display_name, u.avatar_url, u.is_admin,
  u.given_name, u.family_name, u.country_code, u.preferred_locale,
  u.nickname, u.avatar_preset, u.public_given_name, u.public_family_name, u.public_country, u.public_language,
  DATE_FORMAT(u.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
  DATE_FORMAT(u.last_sign_in_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS last_sign_in_at`;
const RETRYABLE_LOCK_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

function userRecord(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: presetAvatarUrl(row.avatar_preset) ?? row.avatar_url,
    nickname: row.nickname ?? null,
    avatarPreset: row.avatar_preset ?? null,
    publicGivenName: Number(row.public_given_name) === 1,
    publicFamilyName: Number(row.public_family_name) === 1,
    publicCountry: Number(row.public_country) === 1,
    publicLanguage: Number(row.public_language) === 1,
    givenName: row.given_name,
    familyName: row.family_name,
    countryCode: row.country_code,
    preferredLocale: row.preferred_locale,
    isAdmin: Number(row.is_admin) === 1,
    createdAt: new Date(row.created_at).toISOString(),
    lastSignInAt: new Date(row.last_sign_in_at).toISOString(),
  };
}

function safeAvatar(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\p{C}\s]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048) return url.href;
  } catch {
    // The profile can be used without an avatar.
  }
  return null;
}

function providerName(value) {
  const name = typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cs}]/gu, '').trim() : '';
  return [...name].slice(0, 60).join('') || null;
}

function googleIdentity(identity) {
  const { subject, email, displayName, avatarUrl } = identity ?? {};
  if (typeof subject !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(subject) ||
      typeof email !== 'string' || email.length > 254 || !/^[^\p{C}\s@]+@[^\p{C}\s@]+$/u.test(email)) {
    throw new TypeError('Invalid Google identity');
  }
  const name = typeof displayName === 'string' ? displayName.replace(/[\p{Cc}\p{Cs}]/gu, '').trim() : '';
  return {
    subject: Buffer.from(subject, 'ascii'),
    email,
    displayName: [...name].slice(0, 120).join('') || 'PixKit member',
    avatarUrl: safeAvatar(avatarUrl),
    givenName: providerName(identity.givenName),
    familyName: providerName(identity.familyName),
  };
}

function tokenHash(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  if (typeof value === 'string' && /^[a-f\d]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  throw new TypeError('Invalid session token hash');
}

function utcDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf()) ||
      value.getUTCFullYear() < 1000 || value.getUTCFullYear() > 9999) {
    throw new TypeError('Invalid session expiry');
  }
  return value.toISOString().slice(0, -1).replace('T', ' ');
}

function databaseError(error) {
  // Connector errors can embed bound values, including emails and session hashes.
  const safe = new Error('MariaDB operation failed');
  if (typeof error?.code === 'string' && /^ER_[A-Z0-9_]+$/.test(error.code)) safe.code = error.code;
  return safe;
}

export function createMariaStore({ pool }) {
  async function query(sql, params = []) {
    try {
      return await pool.query(sql, params);
    } catch (error) {
      throw databaseError(error);
    }
  }

  async function signInTransaction(write) {
    for (let retry = 0; ; retry += 1) {
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const user = await write(connection);
        await connection.commit();
        return user;
      } catch (error) {
        if (connection) {
          try {
            await connection.rollback();
          } catch {
            // Preserve the original operation error.
          }
        }
        if (retry >= 2 || !RETRYABLE_LOCK_ERRORS.has(error?.code)) throw databaseError(error);
      } finally {
        if (connection) {
          try {
            await connection.release();
          } catch {
            // The transaction has already completed or failed.
          }
        }
      }
    }
  }

  async function suggestNicknames(nickname) {
    const base = nickname.slice(0, 18);
    const suffixes = Array.from({ length: 12 }, (_, index) => index < 8 ? index + 2 : randomInt(10, 100000));
    const candidates = [...new Set(suffixes.map(suffix => `${base}_${suffix}`))];
    const occupied = await query(`
      SELECT nickname FROM pixkit_users WHERE nickname IN (${candidates.map(() => '?').join(', ')})
    `, candidates);
    const taken = new Set(occupied.map(row => row.nickname.toLowerCase()));
    return candidates.filter(candidate => !taken.has(candidate.toLowerCase())).slice(0, 3);
  }

  return {
    async signIn(identity, sessionTokenHash, expiresAt, { replaceSessionHash } = {}) {
      const profile = googleIdentity(identity);
      const hash = tokenHash(sessionTokenHash);
      const oldHash = replaceSessionHash === undefined ? null : tokenHash(replaceSessionHash);
      if (oldHash?.equals(hash)) throw new TypeError('Invalid session token replacement');
      const expiry = utcDate(expiresAt);
      return signInTransaction(async (connection) => {
        await connection.query(`
          INSERT INTO pixkit_users
            (id, google_subject, email, display_name, avatar_url, given_name, family_name, created_at, last_sign_in_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE
            email = VALUES(email),
            avatar_url = VALUES(avatar_url),
            given_name = IF(preferred_locale IS NULL, COALESCE(given_name, VALUES(given_name)), given_name),
            family_name = IF(preferred_locale IS NULL, COALESCE(family_name, VALUES(family_name)), family_name),
            last_sign_in_at = GREATEST(last_sign_in_at, VALUES(last_sign_in_at))
        `, [randomUUID(), profile.subject, profile.email, profile.displayName, profile.avatarUrl,
          profile.givenName, profile.familyName]);
        const [row] = await connection.query(`
          SELECT ${USER_FIELDS}
          FROM pixkit_users AS u WHERE u.google_subject = ?
        `, [profile.subject]);
        const user = userRecord(row);
        await connection.query(`
          INSERT INTO pixkit_sessions (token_hash, user_id, created_at, expires_at)
          VALUES (?, ?, UTC_TIMESTAMP(3), ?)
        `, [hash, user.id, expiry]);
        if (oldHash) await connection.query('DELETE FROM pixkit_sessions WHERE token_hash = ?', [oldHash]);
        return user;
      });
    },

    async session(sessionTokenHash) {
      const [row] = await query(`
        SELECT ${USER_FIELDS}
        FROM pixkit_sessions AS s
        JOIN pixkit_users AS u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3)
      `, [tokenHash(sessionTokenHash)]);
      return row ? userRecord(row) : null;
    },

    async nicknameAvailability(value, excludingUserId = null) {
      const nickname = normalizeNickname(value);
      if (!nickname) return { available: false, suggestions: [] };
      if (excludingUserId !== null && (typeof excludingUserId !== 'string' || excludingUserId.length > 36)) {
        throw new TypeError('Invalid account identifier');
      }
      const [existing] = await query(`
        SELECT 1 FROM pixkit_users WHERE nickname = ? AND (? IS NULL OR id <> ?) LIMIT 1
      `, [nickname, excludingUserId, excludingUserId]);
      return existing ? { available: false, suggestions: await suggestNicknames(nickname) }
        : { available: true, suggestions: [] };
    },

    async publicProfile(value) {
      const nickname = normalizeNickname(value);
      if (!nickname) return null;
      const [row] = await query(`
        SELECT nickname, avatar_preset, given_name, family_name, country_code, preferred_locale,
               public_given_name, public_family_name, public_country, public_language
        FROM pixkit_users WHERE nickname = ? LIMIT 1
      `, [nickname]);
      return row ? publicProfile({
        nickname: row.nickname, avatarPreset: row.avatar_preset,
        givenName: row.given_name, familyName: row.family_name,
        countryCode: row.country_code, preferredLocale: row.preferred_locale,
        publicGivenName: Number(row.public_given_name) === 1,
        publicFamilyName: Number(row.public_family_name) === 1,
        publicCountry: Number(row.public_country) === 1,
        publicLanguage: Number(row.public_language) === 1,
      }) : null;
    },

    async updateProfile(sessionTokenHash, profile) {
      const { givenName, familyName, countryCode, preferredLocale } = profile;
      const hasNickname = Object.hasOwn(profile, 'nickname');
      const nickname = hasNickname ? normalizeNickname(profile.nickname) : null;
      if (hasNickname && !nickname) throw new TypeError('Invalid nickname');
      const hasAvatar = Object.hasOwn(profile, 'avatarPreset');
      const avatar = profile.avatarPreset || null;
      if (hasAvatar && avatar !== null && !presetAvatarUrl(avatar)) throw new TypeError('Invalid avatar preset');
      const flags = ['publicGivenName', 'publicFamilyName', 'publicCountry', 'publicLanguage'];
      if (flags.some(flag => Object.hasOwn(profile, flag) && typeof profile[flag] !== 'boolean')) {
        throw new TypeError('Invalid profile visibility');
      }
      const hash = tokenHash(sessionTokenHash);
      try {
        const result = await query(`
          UPDATE pixkit_users AS u
          JOIN pixkit_sessions AS s ON s.user_id = u.id
          SET u.given_name = ?, u.family_name = ?, u.country_code = ?, u.preferred_locale = ?,
              u.display_name = COALESCE(NULLIF(LEFT(CONCAT_WS(' ', ?, ?), 120), ''), u.display_name),
              u.nickname = IF(?, ?, u.nickname), u.avatar_preset = IF(?, ?, u.avatar_preset),
              u.public_given_name = IF(?, ?, u.public_given_name),
              u.public_family_name = IF(?, ?, u.public_family_name),
              u.public_country = IF(?, ?, u.public_country),
              u.public_language = IF(?, ?, u.public_language)
          WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3)
        `, [givenName, familyName, countryCode, preferredLocale,
          givenName, familyName, hasNickname, nickname, hasAvatar, avatar,
          ...flags.flatMap(flag => [Object.hasOwn(profile, flag), profile[flag] === true]), hash]);
        if (result.affectedRows) return { status: 'ok' };
        const [active] = await query(`
          SELECT 1 FROM pixkit_sessions WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP(3)
        `, [hash]);
        return { status: active ? 'ok' : 'expired' };
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY' || !nickname) throw error;
        return { status: 'nickname_taken', suggestions: await suggestNicknames(nickname) };
      }
    },

    async revokeSession(sessionTokenHash) {
      const result = await query('DELETE FROM pixkit_sessions WHERE token_hash = ?', [tokenHash(sessionTokenHash)]);
      return result.affectedRows > 0;
    },

    async deleteAccount(sessionTokenHash) {
      const result = await query(`
        DELETE FROM pixkit_users
        WHERE id = (
          SELECT user_id FROM pixkit_sessions
          WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP(3)
        )
      `, [tokenHash(sessionTokenHash)]);
      return result.affectedRows > 0;
    },

    async listUsers({ limit = 50, offset = 0 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
          !Number.isSafeInteger(offset) || offset < 0) {
        throw new RangeError('Invalid account page');
      }
      const rows = await query(`
        SELECT tally.total, page.*
        FROM (SELECT COUNT(*) AS total FROM pixkit_users) AS tally
        LEFT JOIN (
          SELECT ${USER_FIELDS}
          FROM pixkit_users AS u
          ORDER BY u.created_at DESC, u.id DESC
          LIMIT ? OFFSET ?
        ) AS page ON TRUE
        ORDER BY page.created_at DESC, page.id DESC
      `, [limit, offset]);
      return {
        total: Number(rows[0].total),
        users: rows[0].id ? rows.map(userRecord) : [],
      };
    },

    async pruneExpiredSessions({ limit = 500 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
        throw new RangeError('Invalid expired session cleanup limit');
      }
      const result = await query(`
        DELETE FROM pixkit_sessions WHERE expires_at <= UTC_TIMESTAMP(3)
        ORDER BY expires_at LIMIT ?
      `, [limit]);
      return Number(result.affectedRows);
    },
  };
}
