/**
 * RecoverIQ Recovery Cases Admin Review Controller
 * Phase 5 - Step 5: Human-in-the-Loop Approval Workflow
 * Phase 7 - Step 3: Live Recovery Activity Feed
 *
 * Every handler runs behind requireMerchantAuth and acts only on the caller's merchant:
 * the tenant comes from the authenticated principal (req.merchant), never from the request.
 */

import { ReviewService } from '../../services/review/index.js';
import { ObservabilityService } from '../../services/observability/index.js';
import { AskRecoverIQService } from '../../services/ask/ask.service.js';
import { parseLimit, merchantScope } from '../utils/http.js';

function sendServiceError(error, res, next) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }
  return next(error);
}

/**
 * GET /api/admin/recovery-cases/activity
 * Returns recent sanitized recovery lifecycle events
 */
export async function getRecoveryActivity(req, res, next) {
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

/**
 * GET /api/admin/recovery-cases/:caseId/review
 */
export async function getCaseReview(req, res, next) {
  try {
    const { caseId } = req.params;
    const reviewData = await ReviewService.getCaseForReview(caseId, merchantScope(req));

    if (!reviewData) {
      return res.status(404).json({
        success: false,
        message: `Recovery case '${caseId}' not found`,
      });
    }

    return res.status(200).json({
      success: true,
      data: reviewData,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/admin/recovery-cases/:caseId/explanation
 * Retrieves full lineage, agent reasoning, policy rationale, and timeline
 */
export async function getCaseExplanation(req, res, next) {
  try {
    const { caseId } = req.params;
    const explanation = await ObservabilityService.getDecisionExplanation(caseId, merchantScope(req));

    if (!explanation) {
      return res.status(404).json({
        success: false,
        message: `Recovery case '${caseId}' not found`,
      });
    }

    return res.status(200).json({
      success: true,
      data: explanation,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/admin/recovery-cases/:caseId/approve
 */
export async function approveRecoveryCase(req, res, next) {
  try {
    const { caseId } = req.params;
    const { reasoning } = req.body || {};

    const result = await ReviewService.approveCase(caseId, {
      reviewerId: req.merchant.userId,
      reasoning: reasoning || 'Approved by merchant reviewer',
      ...merchantScope(req),
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendServiceError(error, res, next);
  }
}

/**
 * POST /api/admin/recovery-cases/:caseId/modify
 */
export async function modifyRecoveryCase(req, res, next) {
  try {
    const { caseId } = req.params;
    const { modifiedAction, modifiedParams, reasoning } = req.body || {};

    const result = await ReviewService.modifyCase(caseId, {
      reviewerId: req.merchant.userId,
      modifiedAction,
      modifiedParams,
      reasoning: reasoning || 'Modified parameters and approved by merchant reviewer',
      ...merchantScope(req),
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendServiceError(error, res, next);
  }
}

/**
 * POST /api/admin/recovery-cases/:caseId/reject
 */
export async function rejectRecoveryCase(req, res, next) {
  try {
    const { caseId } = req.params;
    const { reasoning } = req.body || {};

    const result = await ReviewService.rejectCase(caseId, {
      reviewerId: req.merchant.userId,
      reasoning: reasoning || 'Rejected by merchant reviewer',
      ...merchantScope(req),
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendServiceError(error, res, next);
  }
}

/**
 * POST /api/admin/ask or /api/admin/recovery-cases/ask
 * Ask RecoverIQ Grounded Explainer QA
 */
export async function askRecoverIQ(req, res, next) {
  try {
    const { question, caseId } = req.body || {};
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Question is required and must be a non-empty string.',
      });
    }

    const result = await AskRecoverIQService.ask({
      question: question.trim(),
      caseId: caseId ? String(caseId).trim() : undefined,
      ...merchantScope(req),
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
