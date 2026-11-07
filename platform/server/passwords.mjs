import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const cost = { N: 32768, r: 8, p: 3, maxmem: 40 * 1024 * 1024 };
const prefix = 'scrypt$32768$8$3$';
const encodedPattern = /^scrypt\$32768\$8\$3\$([a-f\d]{32})\$([a-f\d]{64})$/;
const dummySalt = randomBytes(16);
let running = 0;
const commonPasswords = new Set([
  'passwordpassword', 'passwordpassword1', 'passwordpassword123',
  '123456789012345', '1234567890123456', '12345678901234567890',
  'qwertyuiopasdfgh', 'qwertyuiopasdfghjkl', 'iloveyouiloveyou',
  'letmeinletmeinletmein', 'correcthorsebatterystaple',
]);

export function validNewPassword(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cs}]/u.test(value)) return false;
  const normalized = value.normalize('NFC');
  const length = [...normalized].length;
  return length >= 15 && length <= 128 && Buffer.byteLength(normalized) <= 512 &&
    !commonPasswords.has(normalized.toLowerCase());
}

function derive(password, salt) {
  if (running >= 2) return Promise.reject(new Error('Password service is busy'));
  running += 1;
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, 32, cost, (error, key) => {
      running -= 1;
      if (error) reject(new Error('Password derivation failed'));
      else resolve(key);
    });
  });
}

export async function hashPassword(password) {
  if (!validNewPassword(password)) throw new TypeError('Invalid new password');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${prefix}${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 512) return false;
  const stored = typeof encoded === 'string' && encoded.match(encodedPattern);
  const actual = await derive(password, stored ? Buffer.from(stored[1], 'hex') : dummySalt);
  const expected = stored ? Buffer.from(stored[2], 'hex') : Buffer.alloc(32);
  return timingSafeEqual(actual, expected) && Boolean(stored);
}
