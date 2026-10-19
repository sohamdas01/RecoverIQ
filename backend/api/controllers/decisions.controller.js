import { getRecentDecisions, getDecisionById, getPendingReviewDecisions } from '../../db/queries/decisions.queries.js';
import { ReviewService } from '../../services/review/index.js';
import { ObservabilityService } from '../../services/observability/index.js';
import { parseLimit, merchantScope } from '../utils/http.js';

export async function listDecisions(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit);
    const pendingOnly = req.query.pending === 'true';
    const scope = merchantScope(req);

    const decisions = pendingOnly
      ? await getPendingReviewDecisions(scope)
      : await getRecentDecisions(limit, scope);

    return res.status(200).json({
      success: true,
      count: decisions.length,
      data: decisions,
    });
  } catch (error) {
    next(error);
  }
}

export async function listActivity(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit);
    const activity = await ObservabilityService.getRecentActivity(limit, merchantScope(req));

    return res.status(200).json({
      success: true,
      count: activity.length,
      data: activity,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDecision(req, res, next) {
  try {
    const { id } = req.params;
    // Another merchant's case id reads as "not found" (no existence leak)
    const decision = await getDecisionById(id, merchantScope(req));
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
 * Requires reviewer/admin role; the case must belong to the caller's merchant.
 */
export async function reviewDecision(req, res, next) {
  try {
    const { id } = req.params;
    const { reviewAction, modifiedAction, modifiedParams, merchantReasoning } = req.body || {};
    const reviewerId = req.merchant.userId;
    const scope = merchantScope(req);

    if (reviewAction === 'reject') {
      const result = await ReviewService.rejectCase(id, {
        reviewerId,
        reasoning: merchantReasoning || 'Rejected by merchant',
        ...scope,
      });
      return res.status(200).json(result);
    }

    if (reviewAction === 'modify') {
      const result = await ReviewService.modifyCase(id, {
        reviewerId,
        modifiedAction,
        modifiedParams,
        reasoning: merchantReasoning || 'Modified parameters by merchant',
        ...scope,
      });
      return res.status(200).json(result);
    }

    // Default to approve
    const result = await ReviewService.approveCase(id, {
      reviewerId,
      reasoning: merchantReasoning || 'Approved by merchant',
      ...scope,
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
