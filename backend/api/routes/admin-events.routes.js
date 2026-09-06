import express from 'express';
import { requireMerchantAuth } from '../middleware/auth.middleware.js';
import {
  replayDlqEventHandler,
  getDlqEventHandler,
} from '../controllers/admin-events.controller.js';

const router = express.Router();

/**
 * @route   GET /api/admin/events/dlq/:dlqEventId
 * @desc    Inspect dead-letter event details
 * @access  Private (Admin / Merchant Auth required)
 */
router.get('/events/dlq/:dlqEventId', requireMerchantAuth, getDlqEventHandler);

/**
 * @route   POST /api/admin/events/:dlqEventId/replay
 * @desc    Replay dead-letter event back into its target Kafka processing topic
 * @access  Private (Admin / Merchant Auth required)
 */
router.post('/events/:dlqEventId/replay', requireMerchantAuth, replayDlqEventHandler);

export default router;
