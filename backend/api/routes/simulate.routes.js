import { Router } from 'express';
import { simulatePurchaseFailure, simulateBatchFailures } from '../controllers/simulate.controller.js';

const router = Router();

router.post('/purchase', simulatePurchaseFailure);
router.post('/batch', simulateBatchFailures);

export default router;
