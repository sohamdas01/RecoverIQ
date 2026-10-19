import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/index.js';

export class AuthService {
  /**
   * Generate a signed, short-lived recovery token for customer payment link
   */
  static generateRecoveryToken(payload) {
    const expiresInSeconds = config.recoveryLinkExpiryHours * 3600;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const nonce = crypto.randomBytes(8).toString('hex');

    const token = jwt.sign(
      {
        ...payload,
        nonce,
      },
      config.recoveryLinkSecret,
      {
        expiresIn: `${config.recoveryLinkExpiryHours}h`,
      }
    );

    return { token, expiresAt };
  }

  /**
   * Verify a recovery token
   */
  static verifyRecoveryToken(token) {
    try {
      const decoded = jwt.verify(token, config.recoveryLinkSecret, { algorithms: ['HS256'] });
      return decoded;
    } catch (err) {
      return null;
    }
  }

  /**
   * Issue a signed access token for a merchant dashboard session.
   * Identity is `sub` (user id) + `mid` (merchant id). Authorization data (role, status)
   * is always re-read from the database by the auth middleware, not trusted from the token.
   */
  static issueMerchantToken({ userId, merchantId, role }) {
    if (!userId || !merchantId) {
      throw new Error('userId and merchantId are required to issue a merchant token');
    }
    return jwt.sign(
      { sub: userId, mid: merchantId, role },
      config.jwtSecret,
      {
        algorithm: 'HS256',
        expiresIn: config.jwtExpiresIn,
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      }
    );
  }

  /**
   * Verify a merchant access token. Pins the algorithm (rejects `none` / unexpected algs),
   * issuer and audience. Returns the claims, or null if invalid/expired.
   */
  static verifyMerchantToken(token) {
    try {
      const decoded = jwt.verify(token, config.jwtSecret, {
        algorithms: ['HS256'],
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      });
      if (!decoded || typeof decoded.sub !== 'string' || typeof decoded.mid !== 'string') {
        return null;
      }
      return decoded;
    } catch (err) {
      return null;
    }
  }
}
