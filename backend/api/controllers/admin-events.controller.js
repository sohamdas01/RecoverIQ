import { replayDlqEvent, findDlqEvent } from '../../kafka/replay.service.js';

/**
 * Replay an unprocessable / DLQ event back into Kafka
 * POST /api/admin/events/:dlqEventId/replay
 */
export async function replayDlqEventHandler(req, res) {
  try {
    const { dlqEventId } = req.params;
    const { dryRun, force } = req.body || {};
    const replayedBy = req.merchant?.merchantId || req.merchant?.email || req.body?.replayedBy || 'admin';

    const result = await replayDlqEvent(dlqEventId, {
      replayedBy,
      dryRun,
      force,
    });

    return res.status(200).json(result);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message,
      validationErrors: error.validationErrors || undefined,
      previousReplay: error.previousReplay || undefined,
    });
  }
}

/**
 * Retrieve DLQ event details for inspection
 * GET /api/admin/events/dlq/:dlqEventId
 */
export async function getDlqEventHandler(req, res) {
  try {
    const { dlqEventId } = req.params;
    const event = await findDlqEvent(dlqEventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        error: `DLQ event not found: ${dlqEventId}`,
      });
    }
    return res.status(200).json({
      success: true,
      event,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
