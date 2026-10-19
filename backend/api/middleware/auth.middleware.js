import { AuthService } from '../../services/auth/auth.service.js';
import { findAuthContextByUserId } from '../../db/queries/merchants.queries.js';

/**
 * Role groups. Tenant roles are cumulative (viewer < reviewer < admin); `platform_admin`
 * is an operator role for cross-tenant infrastructure endpoints (DLQ) and is deliberately
 * NOT included in any tenant group, so it gets no implicit access to merchant data routes.
 */
export const ROLE_GROUPS = Object.freeze({
  READ: ['viewer', 'reviewer', 'admin'],
  REVIEW: ['reviewer', 'admin'],
  ADMIN: ['admin'],
  PLATFORM: ['platform_admin'],
});

/**
 * Authenticate a merchant dashboard request.
 * The token proves identity (`sub`, `mid`); role and account/merchant status are re-read from
 * the database every request so disabling a user or suspending a merchant is immediate.
 * Fails closed: any lookup error denies the request.
 */
export async function requireMerchantAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const claims = AuthService.verifyMerchantToken(token);
  if (!claims) {
    return res.status(401).json({ success: false, message: 'Invalid or expired authentication token' });
  }

  let context;
  try {
    context = await findAuthContextByUserId(claims.sub);
  } catch (err) {
    console.error('[Auth] Identity lookup failed, denying request:', err.message);
    return res.status(503).json({ success: false, code: 'AUTH_UNAVAILABLE', message: 'Authentication service unavailable' });
  }

  const { user, merchant } = context || {};
  if (
    !user || !merchant ||
    user.status !== 'active' || merchant.status !== 'active' ||
    user.merchantId !== claims.mid
  ) {
    return res.status(401).json({ success: false, message: 'Invalid or expired authentication token' });
  }

  req.merchant = {
    userId: user.id,
    merchantId: merchant.id,
    merchantName: merchant.name,
    email: user.email,
    role: user.role,
  };
  return next();
}

/**
 * Require one of the given roles. Must run after requireMerchantAuth.
 * Usage: router.post('/x', requireMerchantAuth, requireRole(...ROLE_GROUPS.REVIEW), handler)
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.merchant) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.merchant.role)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'You do not have permission to perform this action' });
    }
    return next();
  };
}
