import { Router } from 'express';
import { listDecisions, listActivity, getDecision, reviewDecision } from '../controllers/decisions.controller.js';

const router = Router();

router.get('/activity', listActivity);
router.get('/', listDecisions);
router.get('/:id', getDecision);
router.post('/:id/review', reviewDecision);

export default router;
