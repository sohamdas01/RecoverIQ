import { Router } from 'express';
import { listTransactions, getTransaction } from '../controllers/transactions.controller.js';
import { requireMerchantAuth, requireRole, ROLE_GROUPS } from '../middleware/auth.middleware.js';

const router = Router();

router.use(requireMerchantAuth, requireRole(...ROLE_GROUPS.READ));

router.get('/', listTransactions);
router.get('/:id', getTransaction);

export default router;
