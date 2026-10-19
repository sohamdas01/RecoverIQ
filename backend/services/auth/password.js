import crypto from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(crypto.scrypt);

// scrypt parameters (OWASP-recommended minimum: N=2^15 w/ r=8 is stronger; 2^14 keeps login latency low on small hosts)
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128; // bounds scrypt work for oversized inputs

/**
 * Hash a password as `scrypt$N$r$p$<salt b64>$<hash b64>`.
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Constant-time password verification. Returns false (never throws) for malformed hashes.
 */
export async function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;

    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length === 0) return false;

    const derived = await scrypt(password, salt, expected.length, { N, r, p });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

let dummyHashPromise = null;

/**
 * Burn the same CPU as a real verification when the account does not exist,
 * so response timing does not reveal which emails are registered.
 */
export async function verifyAgainstDummyHash(password) {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(18).toString('base64'));
  }
  await verifyPassword(password, await dummyHashPromise);
  return false;
}
