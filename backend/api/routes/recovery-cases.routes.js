/**
 * RecoverIQ Recovery Cases Admin Review Routes
 * Phase 5 - Step 5: Human-in-the-Loop Approval Workflow
 */

import { Router } from 'express';
import { requireMerchantAuth } from '../middleware/auth.middleware.js';
import {
  getCaseReview,
  getCaseExplanation,
  approveRecoveryCase,
  modifyRecoveryCase,
  rejectRecoveryCase,
} from '../controllers/recovery-cases.controller.js';

const router = Router();

// All review endpoints require authenticated merchant access
router.use(requireMerchantAuth);

// GET /api/admin/recovery-cases/:caseId/review
router.get('/:caseId/review', getCaseReview);

// GET /api/admin/recovery-cases/:caseId/explanation
router.get('/:caseId/explanation', getCaseExplanation);

// POST /api/admin/recovery-cases/:caseId/approve
router.post('/:caseId/approve', approveRecoveryCase);

// POST /api/admin/recovery-cases/:caseId/modify
router.post('/:caseId/modify', modifyRecoveryCase);

// POST /api/admin/recovery-cases/:caseId/reject
router.post('/:caseId/reject', rejectRecoveryCase);

export default router;
