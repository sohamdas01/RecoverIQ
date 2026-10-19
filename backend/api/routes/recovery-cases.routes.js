/**
 * RecoverIQ Recovery Cases Admin Review Routes
 * Phase 5 - Step 5: Human-in-the-Loop Approval Workflow
 * Phase 7 - Step 3: Live Recovery Activity
 */

import { Router } from 'express';
import { requireMerchantAuth } from '../middleware/auth.middleware.js';
import { AuthService } from '../../services/auth/auth.service.js';
import { config } from '../../services/config/index.js';
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

// Dev-only, unauthenticated token generation for the local dashboard session.
// Disabled in production: it lets any caller mint an admin JWT.
router.post('/auth/token', (req, res) => {
  if (config.env === 'production') {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  const { merchantId = 'merchant_admin', role = 'admin' } = req.body || {};
  const token = AuthService.generateMerchantToken(merchantId, role);
  return res.status(200).json({ success: true, token, merchantId, role });
});

// All review & explainer endpoints require authenticated merchant access
router.use(requireMerchantAuth);

// POST /api/admin/recovery-cases/ask
router.post('/ask', askRecoverIQ);

// GET /api/admin/recovery-cases/activity
router.get('/activity', getRecoveryActivity);

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
