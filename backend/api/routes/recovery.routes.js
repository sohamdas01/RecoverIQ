import { Router } from 'express';
import { getRecoveryDetails, completeRecoveryPayment } from '../controllers/recovery.controller.js';

const router = Router();

router.get('/:token', getRecoveryDetails);
router.post('/:token/pay', completeRecoveryPayment);

export default router;
