import crypto from 'crypto';
import { config } from '../config/index.js';
import { AuthService } from './auth.service.js';
import { verifyPassword, verifyAgainstDummyHash, MAX_PASSWORD_LENGTH } from './password.js';
import {
  findUserWithMerchantByEmail,
  recordSuccessfulLogin,
  normalizeEmail,
} from '../../db/queries/merchants.queries.js';
import { checkRateLimit, peekRateLimit, clearRateLimit } from '../../redis/redis.client.js';

const MAX_EMAIL_LENGTH = 254;

export class AuthError extends Error {
  constructor(statusCode, code, message, extra = {}) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.code = code;
    Object.assign(this, extra);
  }
}

function emailKey(email) {
  return `login:fail:${crypto.createHash('sha256').update(email).digest('hex')}`;
}

export function toPublicUser(user, merchant) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    merchant: { id: merchant.id, name: merchant.name },
  };
}

export class MerchantAuthService {
  /**
   * Authenticate a merchant dashboard user.
   * - Bounded input (limits scrypt work), generic failure message (no account enumeration)
   * - Per-IP attempt limit and per-email failed-attempt lockout
   * - Constant-time work for unknown accounts
   * - Disabled users / suspended merchants cannot obtain a token
   *
   * @returns {Promise<{ token: string, expiresIn: string, user: Object }>}
   */
  static async login({ email, password, ip = 'unknown' } = {}) {
    if (
      typeof email !== 'string' || typeof password !== 'string' ||
      email.length === 0 || email.length > MAX_EMAIL_LENGTH || !email.includes('@') ||
      password.length === 0 || password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new AuthError(400, 'INVALID_INPUT', 'A valid email and password are required');
    }

    const normalizedEmail = normalizeEmail(email);
    const { maxFailuresPerEmail, maxAttemptsPerIp, windowSeconds } = config.loginRateLimit;

    const ipAllowed = await checkRateLimit(`login:ip:${ip}`, maxAttemptsPerIp, windowSeconds);
    if (!ipAllowed) {
      throw new AuthError(429, 'TOO_MANY_ATTEMPTS', 'Too many login attempts. Try again later.', { retryAfterSeconds: windowSeconds });
    }

    const failKey = emailKey(normalizedEmail);
    const failures = await peekRateLimit(failKey, windowSeconds);
    if (failures >= maxFailuresPerEmail) {
      throw new AuthError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed login attempts. Try again later.', { retryAfterSeconds: windowSeconds });
    }

    const row = await findUserWithMerchantByEmail(normalizedEmail);
    const passwordOk = row
      ? await verifyPassword(password, row.user.passwordHash)
      : await verifyAgainstDummyHash(password);

    if (!row || !passwordOk) {
      await checkRateLimit(failKey, Number.MAX_SAFE_INTEGER, windowSeconds); // record the failure
      throw new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Correct credentials but the account cannot sign in
    if (row.user.status !== 'active' || row.merchant.status !== 'active') {
      throw new AuthError(403, 'ACCOUNT_DISABLED', 'This account is disabled. Contact your administrator.');
    }

    await clearRateLimit(failKey);
    await recordSuccessfulLogin(row.user.id);

    const token = AuthService.issueMerchantToken({
      userId: row.user.id,
      merchantId: row.merchant.id,
      role: row.user.role,
    });

    return {
      token,
      expiresIn: config.jwtExpiresIn,
      user: toPublicUser(row.user, row.merchant),
    };
  }
}
