/**
 * RecoverIQ Recovery Cases Admin Review Controller
 * Phase 5 - Step 5: Human-in-the-Loop Approval Workflow
 */

import { ReviewService } from '../../services/review/index.js';
import { ObservabilityService } from '../../services/observability/index.js';

/**
 * GET /api/admin/recovery-cases/:caseId/review
 */
export async function getCaseReview(req, res, next) {
  try {
    const { caseId } = req.params;
    const reviewData = await ReviewService.getCaseForReview(caseId);

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
    const explanation = await ObservabilityService.getDecisionExplanation(caseId);

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
    const reviewerId = req.merchant?.merchantId || req.merchant?.userId || 'merchant_admin';

    const result = await ReviewService.approveCase(caseId, {
      reviewerId,
      reasoning: reasoning || 'Approved by merchant reviewer',
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

/**
 * POST /api/admin/recovery-cases/:caseId/modify
 */
export async function modifyRecoveryCase(req, res, next) {
  try {
    const { caseId } = req.params;
    const { modifiedAction, modifiedParams, reasoning } = req.body || {};
    const reviewerId = req.merchant?.merchantId || req.merchant?.userId || 'merchant_admin';

    const result = await ReviewService.modifyCase(caseId, {
      reviewerId,
      modifiedAction,
      modifiedParams,
      reasoning: reasoning || 'Modified parameters and approved by merchant reviewer',
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

/**
 * POST /api/admin/recovery-cases/:caseId/reject
 */
export async function rejectRecoveryCase(req, res, next) {
  try {
    const { caseId } = req.params;
    const { reasoning } = req.body || {};
    const reviewerId = req.merchant?.merchantId || req.merchant?.userId || 'merchant_admin';

    const result = await ReviewService.rejectCase(caseId, {
      reviewerId,
      reasoning: reasoning || 'Rejected by merchant reviewer',
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
