import express from 'express';
import { requireMerchantAuth, requireRole, ROLE_GROUPS } from '../middleware/auth.middleware.js';
import {
  replayDlqEventHandler,
  getDlqEventHandler,
} from '../controllers/admin-events.controller.js';
import { askRecoverIQ } from '../controllers/recovery-cases.controller.js';

const router = express.Router();

/**
 * @route   POST /api/admin/ask
 * @desc    Ask RecoverIQ Grounded Explainer QA (scoped to the caller's merchant)
 * @access  Private (any merchant role)
 */
router.post('/ask', requireMerchantAuth, requireRole(...ROLE_GROUPS.READ), askRecoverIQ);

/**
 * @route   GET /api/admin/events/dlq/:dlqEventId
 * @desc    Inspect dead-letter event details (cross-tenant infrastructure data)
 * @access  Private (platform operators only)
 */
router.get('/events/dlq/:dlqEventId', requireMerchantAuth, requireRole(...ROLE_GROUPS.PLATFORM), getDlqEventHandler);

/**
 * @route   POST /api/admin/events/:dlqEventId/replay
 * @desc    Replay dead-letter event back into its target Kafka processing topic
 * @access  Private (platform operators only)
 */
router.post('/events/:dlqEventId/replay', requireMerchantAuth, requireRole(...ROLE_GROUPS.PLATFORM), replayDlqEventHandler);

export default router;
