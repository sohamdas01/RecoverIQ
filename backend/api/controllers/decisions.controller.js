import { getRecentDecisions, getDecisionById, getPendingReviewDecisions } from '../../db/queries/decisions.queries.js';
import { ReviewService } from '../../services/review/index.js';

export async function listDecisions(req, res, next) {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const pendingOnly = req.query.pending === 'true';

    const decisions = pendingOnly
      ? await getPendingReviewDecisions()
      : await getRecentDecisions(limit);

    return res.status(200).json({
      success: true,
      count: decisions.length,
      data: decisions,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDecision(req, res, next) {
  try {
    const { id } = req.params;
    const decision = await getDecisionById(id);
    if (!decision) {
      return res.status(404).json({ success: false, message: 'Decision not found' });
    }
    return res.status(200).json({ success: true, data: decision });
  } catch (error) {
    next(error);
  }
}

/**
 * Human-in-the-loop Review: Approve, Modify, or Reject a queued decision
 * Delegates to centralized ReviewService for Policy re-evaluation and safe Execution Gate.
 */
export async function reviewDecision(req, res, next) {
  try {
    const { id } = req.params;
    const { reviewAction, modifiedAction, modifiedParams, merchantReasoning } = req.body;
    const reviewerId = req.merchant?.merchantId || req.merchant?.userId || 'merchant_admin';

    if (reviewAction === 'reject') {
      const result = await ReviewService.rejectCase(id, {
        reviewerId,
        reasoning: merchantReasoning || 'Rejected by merchant',
      });
      return res.status(200).json(result);
    }

    if (reviewAction === 'modify') {
      const result = await ReviewService.modifyCase(id, {
        reviewerId,
        modifiedAction,
        modifiedParams,
        reasoning: merchantReasoning || 'Modified parameters by merchant',
      });
      return res.status(200).json(result);
    }

    // Default to approve
    const result = await ReviewService.approveCase(id, {
      reviewerId,
      reasoning: merchantReasoning || 'Approved by merchant',
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    next(error);
  }
}
