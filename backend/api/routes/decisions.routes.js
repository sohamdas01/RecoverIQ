import { Router } from 'express';
import { listDecisions, getDecision, reviewDecision } from '../controllers/decisions.controller.js';

const router = Router();

router.get('/', listDecisions);
router.get('/:id', getDecision);
router.post('/:id/review', reviewDecision);

export default router;
