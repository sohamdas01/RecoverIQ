import { Router } from 'express';
import { simulatePurchaseFailure, simulateBatchFailures } from '../controllers/simulate.controller.js';
import { requireMerchantAuth, requireRole, ROLE_GROUPS } from '../middleware/auth.middleware.js';
import { isSimulationEnabled } from '../../services/config/index.js';

const router = Router();

// Simulation injects synthetic payment failures into the live recovery pipeline:
// off by default in production, and otherwise limited to authenticated merchant admins.
router.use((req, res, next) => {
  if (!isSimulationEnabled()) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  return next();
});
router.use(requireMerchantAuth, requireRole(...ROLE_GROUPS.ADMIN));

router.post('/purchase', simulatePurchaseFailure);
router.post('/batch', simulateBatchFailures);

export default router;
