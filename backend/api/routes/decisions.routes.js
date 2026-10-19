import { Router } from 'express';
import { listDecisions, listActivity, getDecision, reviewDecision } from '../controllers/decisions.controller.js';
import { requireMerchantAuth, requireRole, ROLE_GROUPS } from '../middleware/auth.middleware.js';

const router = Router();

// Every decision/case endpoint is merchant-authenticated and tenant-scoped.
router.use(requireMerchantAuth);

router.get('/activity', requireRole(...ROLE_GROUPS.READ), listActivity);
router.get('/', requireRole(...ROLE_GROUPS.READ), listDecisions);
router.get('/:id', requireRole(...ROLE_GROUPS.READ), getDecision);
router.post('/:id/review', requireRole(...ROLE_GROUPS.REVIEW), reviewDecision);

export default router;
