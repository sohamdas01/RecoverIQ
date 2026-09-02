import { getRecentDecisions, getDecisionById, getPendingReviewDecisions, updateDecisionStatus } from '../../db/queries/decisions.queries.js';
import { createOverride } from '../../db/queries/overrides.queries.js';
import { createAction, updateActionResult } from '../../db/queries/actions.queries.js';
import { executeTool } from '../../services/tools/index.js';

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
 */
export async function reviewDecision(req, res, next) {
  try {
    const { id } = req.params;
    const { reviewAction, modifiedAction, modifiedParams, merchantReasoning } = req.body;
    // reviewAction: 'approve' | 'modify' | 'reject'

    const decisionRecord = await getDecisionById(id);
    if (!decisionRecord) {
      return res.status(404).json({ success: false, message: 'Decision not found' });
    }

    const { decision, transaction } = decisionRecord;

    if (decision.status !== 'pending_review') {
      return res.status(400).json({
        success: false,
        message: `Decision is already in '${decision.status}' status and cannot be reviewed again.`,
      });
    }

    if (reviewAction === 'reject') {
      await updateDecisionStatus(id, 'rejected');
      if (merchantReasoning) {
        await createOverride({
          decisionId: id,
          merchantAction: 'REJECT',
          merchantReasoning,
        });
      }
      return res.status(200).json({
        success: true,
        status: 'rejected',
        message: 'Decision rejected by merchant. No recovery tool was executed.',
      });
    }

    const actionToExecute = reviewAction === 'modify' && modifiedAction
      ? modifiedAction
      : decision.recommendedAction;

    const toolParamsToUse = reviewAction === 'modify' && modifiedParams
      ? modifiedParams
      : (decision.agentAnalystResponse?.toolParams || {});

    // Save override reason if modified
    if (reviewAction === 'modify' || merchantReasoning) {
      await createOverride({
        decisionId: id,
        merchantAction: actionToExecute,
        merchantReasoning: merchantReasoning || `Modified from ${decision.recommendedAction} to ${actionToExecute}`,
      });
    }

    // Execute the approved/modified action
    const actionRecord = await createAction({
      decisionId: id,
      toolName: actionToExecute,
      toolParams: {
        ...toolParamsToUse,
        transactionId: transaction.id,
        amount: parseFloat(transaction.amount),
        currency: transaction.currency,
      },
      status: 'pending',
    });

    const executionResult = await executeTool(actionToExecute, {
      ...toolParamsToUse,
      transactionId: transaction.id,
      amount: parseFloat(transaction.amount),
      currency: transaction.currency,
    });

    await updateActionResult(
      actionRecord.id,
      executionResult.success ? 'success' : 'failed',
      executionResult.output || {}
    );

    const finalStatus = reviewAction === 'modify' ? 'modified' : 'executed';
    await updateDecisionStatus(id, finalStatus, actionToExecute);

    return res.status(200).json({
      success: true,
      status: finalStatus,
      message: `Decision ${reviewAction === 'modify' ? 'modified and executed' : 'approved and executed'} successfully`,
      executionResult,
    });
  } catch (error) {
    next(error);
  }
}
