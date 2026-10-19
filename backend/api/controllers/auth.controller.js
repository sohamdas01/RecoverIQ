import { MerchantAuthService, AuthError, toPublicUser } from '../../services/auth/merchant-auth.service.js';

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const result = await MerchantAuthService.login({ email, password, ip: req.ip });

    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      success: true,
      token: result.token,
      tokenType: 'Bearer',
      expiresIn: result.expiresIn,
      user: result.user,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.retryAfterSeconds) {
        res.set('Retry-After', String(error.retryAfterSeconds));
      }
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    return next(error);
  }
}

/**
 * GET /api/auth/me
 * Returns the authenticated principal (requireMerchantAuth has already validated it against the database).
 */
export async function me(req, res) {
  const { userId, email, role, merchantId, merchantName } = req.merchant;
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({
    success: true,
    user: toPublicUser(
      { id: userId, email, role },
      { id: merchantId, name: merchantName }
    ),
  });
}
