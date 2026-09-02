import { AuthService } from '../../services/auth/auth.service.js';

export function requireMerchantAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];
  const decoded = AuthService.verifyMerchantToken(token);

  if (!decoded) {
    return res.status(401).json({ success: false, message: 'Invalid or expired authentication token' });
  }

  req.merchant = decoded;
  next();
}
