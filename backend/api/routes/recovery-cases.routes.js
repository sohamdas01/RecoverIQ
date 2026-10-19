/**
 * RecoverIQ Recovery Cases Admin Review Routes
 * Phase 5 - Step 5: Human-in-the-Loop Approval Workflow
 * Phase 7 - Step 3: Live Recovery Activity
 * Phase 8: merchant authentication + role-based authorization
 */

import { Router } from 'express';
import { requireMerchantAuth, requireRole, ROLE_GROUPS } from '../middleware/auth.middleware.js';
import {
  getRecoveryActivity,
  getCaseReview,
  getCaseExplanation,
  approveRecoveryCase,
  modifyRecoveryCase,
  rejectRecoveryCase,
  askRecoverIQ,
} from '../controllers/recovery-cases.controller.js';

const router = Router();

// All review & explainer endpoints require an authenticated merchant user.
// (The former unauthenticated dev token endpoint was removed: use POST /api/auth/login.)
router.use(requireMerchantAuth);

// POST /api/admin/recovery-cases/ask
router.post('/ask', requireRole(...ROLE_GROUPS.READ), askRecoverIQ);

// GET /api/admin/recovery-cases/activity
router.get('/activity', requireRole(...ROLE_GROUPS.READ), getRecoveryActivity);

// GET /api/admin/recovery-cases/:caseId/review
router.get('/:caseId/review', requireRole(...ROLE_GROUPS.READ), getCaseReview);

// GET /api/admin/recovery-cases/:caseId/explanation
router.get('/:caseId/explanation', requireRole(...ROLE_GROUPS.READ), getCaseExplanation);

// Human-in-the-loop actions require reviewer/admin
// POST /api/admin/recovery-cases/:caseId/approve
router.post('/:caseId/approve', requireRole(...ROLE_GROUPS.REVIEW), approveRecoveryCase);

// POST /api/admin/recovery-cases/:caseId/modify
router.post('/:caseId/modify', requireRole(...ROLE_GROUPS.REVIEW), modifyRecoveryCase);

// POST /api/admin/recovery-cases/:caseId/reject
router.post('/:caseId/reject', requireRole(...ROLE_GROUPS.REVIEW), rejectRecoveryCase);

export default router;
