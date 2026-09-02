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
      const decoded = jwt.verify(token, config.recoveryLinkSecret);
      return decoded;
    } catch (err) {
      return null;
    }
  }

  /**
   * Generate JWT for merchant dashboard session
   */
  static generateMerchantToken(merchantId, role = 'admin') {
    return jwt.sign(
      { merchantId, role },
      config.jwtSecret,
      { expiresIn: '7d' }
    );
  }

  /**
   * Verify merchant JWT
   */
  static verifyMerchantToken(token) {
    try {
      return jwt.verify(token, config.jwtSecret);
    } catch (err) {
      return null;
    }
  }
}
