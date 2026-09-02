import { Router } from 'express';
import { listTransactions, getTransaction } from '../controllers/transactions.controller.js';

const router = Router();

router.get('/', listTransactions);
router.get('/:id', getTransaction);

export default router;
