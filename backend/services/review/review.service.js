/**
 * RecoverIQ Human-in-the-Loop Review Service
 * Phase 5 - Step 5: Human-in-the-Loop Approval Workflow
 *
 * Provides safe, auditable, and deterministic review lifecycle:
 * PENDING_REVIEW -> Merchant Review (APPROVE / MODIFY / REJECT) -> Policy Re-evaluation -> Execution Gate -> Persistence & Kafka Outcome
 *
 * CORE ARCHITECTURAL INVARIANTS:
 * 1. APPROVE and MODIFY always trigger fresh Policy Engine evaluation.
 * 2. Only a final ALLOW reaches the Execution Gate.
 * 3. BLOCK and REQUIRE_APPROVAL never execute tools.
 * 4. Human actions are idempotent, concurrency-safe (Redis locks), and fully audited.
 * 5. Historical Agent 1, Agent 2, and initial policy evaluations are strictly preserved.
 */

import crypto from 'crypto';
import { getDecisionById, updateDecisionStatus } from '../../db/queries/decisions.queries.js';
import { getTransactionById, updateTransactionStatus } from '../../db/queries/transactions.queries.js';
import { createOverride, getOverridesByDecisionId } from '../../db/queries/overrides.queries.js';
import { createAction, updateActionResult, getActionsByDecisionId } from '../../db/queries/actions.queries.js';
import { evaluatePolicy, POLICY_DECISIONS, SUPPORTED_ACTIONS } from '../policy/index.js';
import { RecoveryExecutorClient } from '../agents/recovery-executor.client.js';
import { executeTool } from '../tools/index.js';
import { acquireLock, releaseLock } from '../../redis/redis.client.js';
import { publishOutcomeEvent } from '../../kafka/producer.js';
import { EVENT_TYPES, OUTCOME_TYPES } from '../../kafka/schemas/events.schema.js';
import { ObservabilityService, AUDIT_EVENT_TYPES, withSpan } from '../observability/index.js';
import { db } from '../../db/index.js';
import { decisions } from '../../../drizzle/schema.js';
import { eq } from 'drizzle-orm';
import { logger, updateCorrelationContext } from '../logger/index.js';
import { metrics } from '../metrics/index.js';

const reviewLogger = logger.withComponent('review_service');

export const REVIEW_STATUSES = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  MODIFIED: 'MODIFIED',
  REJECTED: 'REJECTED',
};

export class ReviewService {
  /**
   * Retrieves complete review context and audit history for a pending recovery case
   *
   * @param {string} caseId Decision ID
   * @returns {Promise<Object|null>} Structured review details
   */
  static async getCaseForReview(caseId) {
    const record = await getDecisionById(caseId);
    if (!record) {
      return null;
    }

    const { decision, transaction, customer } = record;
    const agentAnalyst = decision.agentAnalystResponse || {};
    const overrides = await getOverridesByDecisionId(caseId);
    const actions = await getActionsByDecisionId(caseId);

    return {
      caseId: decision.id,
      transactionId: transaction.id,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      },
      transaction: {
        id: transaction.id,
        amount: parseFloat(transaction.amount),
        currency: transaction.currency,
        status: transaction.status,
        failureReason: transaction.failureReason,
        attemptCount: transaction.attemptCount,
        paymentMethod: transaction.paymentMethod,
        metadata: transaction.metadata || {},
        createdAt: transaction.createdAt,
      },
      status: decision.status,
      reviewStatus: decision.status === 'pending_review'
        ? REVIEW_STATUSES.PENDING_REVIEW
        : decision.status === 'executed'
        ? REVIEW_STATUSES.APPROVED
        : decision.status === 'modified'
        ? REVIEW_STATUSES.MODIFIED
        : decision.status === 'rejected'
        ? REVIEW_STATUSES.REJECTED
        : decision.status.toUpperCase(),
      recommendedAction: decision.recommendedAction,
      finalAction: decision.finalAction,
      guardrailResult: decision.guardrailResult,
      reasoning: decision.reasoning,
      agent1: agentAnalyst.agent1 || null,
      agent2: agentAnalyst.agent2 || null,
      proposedAction: decision.recommendedAction,
      proposedParameters: agentAnalyst.agent2?.parameters || agentAnalyst.toolParams || {},
      policyDecision: decision.guardrailResult,
      policyVersion: agentAnalyst.policyVersion || 'v1',
      ruleIds: agentAnalyst.appliedRules || (agentAnalyst.ruleId ? [agentAnalyst.ruleId] : []),
      reasons: agentAnalyst.reasons || [decision.reasoning],
      mlResult: {
        mlScore: decision.mlScore,
        reasonCodes: agentAnalyst.mlReasonCodes || [],
        modelVersion: agentAnalyst.mlModelVersion,
        attributions: agentAnalyst.mlAttributions || [],
      },
      humanReview: agentAnalyst.humanReview || null,
      overrides,
      actions,
      createdAt: decision.createdAt,
    };
  }

  /**
   * Merchant APPROVE flow
   * Re-evaluates policy fresh with merchant approval, executes tool on ALLOW, and records audit trail.
   */
  static async approveCase(caseId, { reviewerId = 'merchant_admin', reasoning = 'Approved by merchant' } = {}) {
    return withSpan('hitl.review', {
      attributes: {
        'case.id': caseId,
        'hitl.action': 'APPROVE',
        'reviewer.id': reviewerId,
      },
    }, async (reviewSpan) => {
      const lockKey = `lock:review:${caseId}`;
      const acquired = await acquireLock(lockKey, 10);
      if (!acquired) {
        const err = new Error('A concurrent review action is currently in progress for this recovery case');
        err.statusCode = 409;
        err.code = 'CONCURRENT_REVIEW_CONFLICT';
        throw err;
      }

      try {
        // 1. Fetch fresh authoritative state
        const record = await getDecisionById(caseId);
        if (!record) {
          const err = new Error(`Recovery case '${caseId}' not found`);
          err.statusCode = 404;
          err.code = 'CASE_NOT_FOUND';
          throw err;
        }

      const { decision, transaction, customer } = record;

      // 2. State Invariants Check
      if (decision.status !== 'pending_review') {
        const err = new Error(`Recovery case is already in '${decision.status}' status and cannot be approved.`);
        err.statusCode = 400;
        err.code = 'INVALID_CASE_STATUS';
        throw err;
      }

      if (transaction.status === 'recovered' || transaction.status === 'abandoned') {
        const err = new Error(`Transaction has already reached terminal status '${transaction.status}'. Approval blocked.`);
        err.statusCode = 400;
        err.code = 'TERMINAL_TRANSACTION_STATE';
        throw err;
      }

      const actionToExecute = decision.recommendedAction;
      const toolParams = decision.agentAnalystResponse?.agent2?.parameters || decision.agentAnalystResponse?.toolParams || {};

      // 3. Fresh Policy Engine Re-Evaluation with Human Approval Context
      const policyResult = evaluatePolicy({
        transaction: {
          id: transaction.id,
          amount: parseFloat(transaction.amount),
          currency: transaction.currency || 'INR',
          status: transaction.status,
          failureReason: transaction.failureReason,
          attemptCount: transaction.attemptCount || 1,
          paymentMethod: transaction.paymentMethod,
          metadata: transaction.metadata || {},
        },
        customer,
        proposedAction: actionToExecute,
        toolParams,
        mlPrediction: {
          probability: decision.mlScore,
          reason_codes: decision.agentAnalystResponse?.mlReasonCodes || [],
        },
        humanApproval: true,
        merchantApproved: true,
        metadata: transaction.metadata || {},
      });

      // 4. Branch on Policy Decision
      let executionResult = null;
      let reviewStatus = REVIEW_STATUSES.APPROVED;
      let finalStatus = 'executed';
      let outcomeEventType = EVENT_TYPES.RECOVERY_COMPLETED;
      let outcomeStatus = OUTCOME_TYPES.RECOVERED;

      if (policyResult.decision === POLICY_DECISIONS.ALLOW) {
        // Execute bounded tool
        const actionRecord = await createAction({
          decisionId: decision.id,
          toolName: actionToExecute,
          toolParams: {
            ...toolParams,
            transactionId: transaction.id,
            amount: parseFloat(transaction.amount),
            currency: transaction.currency,
          },
          status: 'pending',
        });

        executionResult = await executeTool(actionToExecute, {
          ...toolParams,
          transactionId: transaction.id,
          amount: parseFloat(transaction.amount),
          currency: transaction.currency,
        });

        await updateActionResult(
          actionRecord.id,
          executionResult.success ? 'success' : 'failed',
          executionResult.output || {}
        );

        if (!executionResult.success) {
          outcomeEventType = EVENT_TYPES.RECOVERY_FAILED;
          outcomeStatus = OUTCOME_TYPES.FAILED;
        } else if (actionToExecute === 'escalate_to_human') {
          outcomeEventType = EVENT_TYPES.RECOVERY_ESCALATED;
          outcomeStatus = OUTCOME_TYPES.ESCALATED;
        } else if (actionToExecute === 'schedule_retry') {
          outcomeEventType = EVENT_TYPES.RECOVERY_SCHEDULED;
          outcomeStatus = OUTCOME_TYPES.SCHEDULED;
        } else {
          outcomeEventType = EVENT_TYPES.RECOVERY_COMPLETED;
          outcomeStatus = OUTCOME_TYPES.RECOVERED;
        }
      } else if (policyResult.decision === POLICY_DECISIONS.REQUIRE_APPROVAL) {
        // Still requires higher sign-off or unresolvable approval
        finalStatus = 'pending_review';
        reviewStatus = REVIEW_STATUSES.PENDING_REVIEW;
        outcomeEventType = EVENT_TYPES.RECOVERY_SCHEDULED;
        outcomeStatus = OUTCOME_TYPES.PENDING_REVIEW;
      } else {
        // Policy returned BLOCK
        finalStatus = 'blocked';
        reviewStatus = 'BLOCKED';
        outcomeEventType = EVENT_TYPES.RECOVERY_FAILED;
        outcomeStatus = OUTCOME_TYPES.BLOCKED;
      }

      // 5. Audit & Override Persistence
      await createOverride({
        decisionId: decision.id,
        merchantAction: 'APPROVE',
        merchantReasoning: reasoning,
      });

      const updatedAgentAnalyst = {
        ...decision.agentAnalystResponse,
        humanReview: {
          reviewerId,
          reviewAction: 'APPROVE',
          reasoning,
          reviewedAt: new Date().toISOString(),
          policyBefore: decision.guardrailResult,
          policyAfter: policyResult.decision,
          appliedRulesBefore: decision.agentAnalystResponse?.appliedRules || [],
          appliedRulesAfter: policyResult.appliedRules,
          ruleIdAfter: policyResult.ruleId,
          reasonsAfter: policyResult.reasons,
          actionExecuted: policyResult.decision === POLICY_DECISIONS.ALLOW ? actionToExecute : null,
          executionResult,
        },
      };

      await db
        .update(decisions)
        .set({
          status: finalStatus,
          finalAction: policyResult.decision === POLICY_DECISIONS.ALLOW ? actionToExecute : undefined,
          agentAnalystResponse: updatedAgentAnalyst,
        })
        .where(eq(decisions.id, decision.id));

      // 6. Publish Outcome Event to Kafka
      const outcomePayload = {
        eventId: crypto.randomUUID(),
        eventType: outcomeEventType,
        occurredAt: new Date().toISOString(),
        transactionId: transaction.id,
        caseId: decision.id,
        customerId: customer.id,
        outcome: outcomeStatus,
        toolName: actionToExecute,
        recoveredAmount: (outcomeStatus === OUTCOME_TYPES.RECOVERED && actionToExecute === 'attempt_recovery')
          ? parseFloat(transaction.amount)
          : 0,
        currency: transaction.currency || 'INR',
        details: {
          humanReview: true,
          reviewerId,
          reviewAction: 'APPROVE',
          guardrailDecision: policyResult.decision,
          guardrailReason: policyResult.reason,
          appliedRules: policyResult.appliedRules,
          ruleId: policyResult.ruleId,
          policyVersion: policyResult.policyVersion,
          toolExecutionSuccess: executionResult ? executionResult.success : null,
          toolOutput: executionResult?.output || {},
        },
        version: 1,
      };

      await ObservabilityService.recordLifecycleEvent({
        transactionId: transaction.id,
        caseId: decision.id,
        eventType: AUDIT_EVENT_TYPES.HUMAN_APPROVED,
        details: {
          reviewerId,
          reasoning,
          policyBefore: decision.guardrailResult,
          policyAfter: policyResult.decision,
          ruleIdAfter: policyResult.ruleId,
          appliedRulesAfter: policyResult.appliedRules,
          executionResult: executionResult ? { success: executionResult.success } : null,
        },
      });

      await publishOutcomeEvent(outcomePayload);

      metrics.recordHitlReview('approve', executionResult ? executionResult.success : true);

      reviewLogger.info('review_case_approved', {
        event: 'review_case_approved',
        caseId: decision.id,
        transactionId: transaction.id,
        reviewerId,
        policyDecision: policyResult.decision,
        executed: policyResult.decision === POLICY_DECISIONS.ALLOW,
        action: actionToExecute,
      });

      reviewSpan.setAttribute('policy.decision', policyResult.decision);
      reviewSpan.setAttribute('recovery.outcome', outcomeStatus);

      return {
        success: true,
        caseId: decision.id,
        reviewStatus,
        policyDecision: policyResult.decision,
        execution: {
          executed: policyResult.decision === POLICY_DECISIONS.ALLOW,
          action: actionToExecute,
          success: executionResult?.success ?? false,
          output: executionResult?.output ?? {},
        },
        message: policyResult.decision === POLICY_DECISIONS.ALLOW
          ? 'Recovery case approved and executed successfully'
          : `Recovery case approved by merchant but policy resulted in ${policyResult.decision}`,
      };
    } finally {
      await releaseLock(lockKey);
    }
    });
  }

  /**
   * Merchant MODIFY flow
   * Validates parameter modifications, re-evaluates policy fresh, executes tool on ALLOW.
   */
  static async modifyCase(caseId, {
    reviewerId = 'merchant_admin',
    modifiedAction,
    modifiedParams = {},
    reasoning = 'Modified parameters by merchant',
  } = {}) {
    return withSpan('hitl.review', {
      attributes: {
        'case.id': caseId,
        'hitl.action': 'MODIFY',
        'reviewer.id': reviewerId,
        'target.action': modifiedAction || 'recommended',
      },
    }, async (reviewSpan) => {
      const lockKey = `lock:review:${caseId}`;
      const acquired = await acquireLock(lockKey, 10);
      if (!acquired) {
        const err = new Error('A concurrent review action is currently in progress for this recovery case');
        err.statusCode = 409;
        err.code = 'CONCURRENT_REVIEW_CONFLICT';
        throw err;
      }

      try {
        // 1. Fetch fresh authoritative state
        const record = await getDecisionById(caseId);
        if (!record) {
          const err = new Error(`Recovery case '${caseId}' not found`);
          err.statusCode = 404;
          err.code = 'CASE_NOT_FOUND';
          throw err;
        }

      const { decision, transaction, customer } = record;

      // 2. State Invariants Check
      if (decision.status !== 'pending_review') {
        const err = new Error(`Recovery case is already in '${decision.status}' status and cannot be modified.`);
        err.statusCode = 400;
        err.code = 'INVALID_CASE_STATUS';
        throw err;
      }

      if (transaction.status === 'recovered' || transaction.status === 'abandoned') {
        const err = new Error(`Transaction has already reached terminal status '${transaction.status}'. Modification blocked.`);
        err.statusCode = 400;
        err.code = 'TERMINAL_TRANSACTION_STATE';
        throw err;
      }

      const targetAction = modifiedAction || decision.recommendedAction;
      if (!SUPPORTED_ACTIONS.includes(targetAction)) {
        const err = new Error(`Unsupported recovery action '${targetAction}'. Supported actions: ${SUPPORTED_ACTIONS.join(', ')}`);
        err.statusCode = 400;
        err.code = 'UNSUPPORTED_ACTION';
        throw err;
      }

      // 3. Parameter Validation & Sanitization
      ReviewService.validateModifiedParameters(targetAction, modifiedParams);
      const sanitizedParams = RecoveryExecutorClient.sanitizeParameters(targetAction, modifiedParams);

      // 4. Fresh Policy Engine Re-Evaluation with Modified Parameters & Human Approval
      const policyResult = evaluatePolicy({
        transaction: {
          id: transaction.id,
          amount: parseFloat(transaction.amount),
          currency: transaction.currency || 'INR',
          status: transaction.status,
          failureReason: transaction.failureReason,
          attemptCount: transaction.attemptCount || 1,
          paymentMethod: transaction.paymentMethod,
          metadata: transaction.metadata || {},
        },
        customer,
        proposedAction: targetAction,
        toolParams: sanitizedParams,
        mlPrediction: {
          probability: decision.mlScore,
          reason_codes: decision.agentAnalystResponse?.mlReasonCodes || [],
        },
        humanApproval: true,
        merchantApproved: true,
        metadata: transaction.metadata || {},
      });

      // 5. Branch on Policy Decision
      let executionResult = null;
      let reviewStatus = REVIEW_STATUSES.MODIFIED;
      let finalStatus = 'modified';
      let outcomeEventType = EVENT_TYPES.RECOVERY_COMPLETED;
      let outcomeStatus = OUTCOME_TYPES.RECOVERED;

      if (policyResult.decision === POLICY_DECISIONS.ALLOW) {
        // Execute bounded tool
        const actionRecord = await createAction({
          decisionId: decision.id,
          toolName: targetAction,
          toolParams: {
            ...sanitizedParams,
            transactionId: transaction.id,
            amount: parseFloat(transaction.amount),
            currency: transaction.currency,
          },
          status: 'pending',
        });

        executionResult = await executeTool(targetAction, {
          ...sanitizedParams,
          transactionId: transaction.id,
          amount: parseFloat(transaction.amount),
          currency: transaction.currency,
        });

        await updateActionResult(
          actionRecord.id,
          executionResult.success ? 'success' : 'failed',
          executionResult.output || {}
        );

        if (!executionResult.success) {
          outcomeEventType = EVENT_TYPES.RECOVERY_FAILED;
          outcomeStatus = OUTCOME_TYPES.FAILED;
        } else if (targetAction === 'escalate_to_human') {
          outcomeEventType = EVENT_TYPES.RECOVERY_ESCALATED;
          outcomeStatus = OUTCOME_TYPES.ESCALATED;
        } else if (targetAction === 'schedule_retry') {
          outcomeEventType = EVENT_TYPES.RECOVERY_SCHEDULED;
          outcomeStatus = OUTCOME_TYPES.SCHEDULED;
        } else {
          outcomeEventType = EVENT_TYPES.RECOVERY_COMPLETED;
          outcomeStatus = OUTCOME_TYPES.RECOVERED;
        }
      } else if (policyResult.decision === POLICY_DECISIONS.REQUIRE_APPROVAL) {
        finalStatus = 'pending_review';
        reviewStatus = REVIEW_STATUSES.PENDING_REVIEW;
        outcomeEventType = EVENT_TYPES.RECOVERY_SCHEDULED;
        outcomeStatus = OUTCOME_TYPES.PENDING_REVIEW;
      } else {
        finalStatus = 'blocked';
        reviewStatus = 'BLOCKED';
        outcomeEventType = EVENT_TYPES.RECOVERY_FAILED;
        outcomeStatus = OUTCOME_TYPES.BLOCKED;
      }

      // 6. Audit & Override Persistence
      await createOverride({
        decisionId: decision.id,
        merchantAction: targetAction,
        merchantReasoning: reasoning,
      });

      const updatedAgentAnalyst = {
        ...decision.agentAnalystResponse,
        humanReview: {
          reviewerId,
          reviewAction: 'MODIFY',
          reasoning,
          reviewedAt: new Date().toISOString(),
          previousAction: decision.recommendedAction,
          modifiedAction: targetAction,
          previousParams: decision.agentAnalystResponse?.agent2?.parameters || decision.agentAnalystResponse?.toolParams || {},
          modifiedParams: sanitizedParams,
          policyBefore: decision.guardrailResult,
          policyAfter: policyResult.decision,
          appliedRulesBefore: decision.agentAnalystResponse?.appliedRules || [],
          appliedRulesAfter: policyResult.appliedRules,
          ruleIdAfter: policyResult.ruleId,
          reasonsAfter: policyResult.reasons,
          actionExecuted: policyResult.decision === POLICY_DECISIONS.ALLOW ? targetAction : null,
          executionResult,
        },
      };

      await db
        .update(decisions)
        .set({
          status: finalStatus,
          finalAction: policyResult.decision === POLICY_DECISIONS.ALLOW ? targetAction : undefined,
          agentAnalystResponse: updatedAgentAnalyst,
        })
        .where(eq(decisions.id, decision.id));

      // 7. Publish Outcome Event to Kafka
      const outcomePayload = {
        eventId: crypto.randomUUID(),
        eventType: outcomeEventType,
        occurredAt: new Date().toISOString(),
        transactionId: transaction.id,
        caseId: decision.id,
        customerId: customer.id,
        outcome: outcomeStatus,
        toolName: targetAction,
        recoveredAmount: (outcomeStatus === OUTCOME_TYPES.RECOVERED && targetAction === 'attempt_recovery')
          ? parseFloat(transaction.amount)
          : 0,
        currency: transaction.currency || 'INR',
        details: {
          humanReview: true,
          reviewerId,
          reviewAction: 'MODIFY',
          modifiedAction: targetAction,
          guardrailDecision: policyResult.decision,
          guardrailReason: policyResult.reason,
          appliedRules: policyResult.appliedRules,
          ruleId: policyResult.ruleId,
          policyVersion: policyResult.policyVersion,
          toolExecutionSuccess: executionResult ? executionResult.success : null,
          toolOutput: executionResult?.output || {},
        },
        version: 1,
      };

      await ObservabilityService.recordLifecycleEvent({
        transactionId: transaction.id,
        caseId: decision.id,
        eventType: AUDIT_EVENT_TYPES.HUMAN_MODIFIED,
        details: {
          reviewerId,
          reasoning,
          previousAction: decision.recommendedAction,
          modifiedAction: targetAction,
          previousParams: decision.agentAnalystResponse?.agent2?.parameters || decision.agentAnalystResponse?.toolParams || {},
          modifiedParams: sanitizedParams,
          policyBefore: decision.guardrailResult,
          policyAfter: policyResult.decision,
          ruleIdAfter: policyResult.ruleId,
          appliedRulesAfter: policyResult.appliedRules,
          executionResult: executionResult ? { success: executionResult.success } : null,
        },
      });

      await publishOutcomeEvent(outcomePayload);

      metrics.recordHitlReview('modify', executionResult ? executionResult.success : true);

      reviewLogger.info('review_case_modified', {
        event: 'review_case_modified',
        caseId: decision.id,
        transactionId: transaction.id,
        reviewerId,
        modifiedAction: targetAction,
        policyDecision: policyResult.decision,
        executed: policyResult.decision === POLICY_DECISIONS.ALLOW,
        action: targetAction,
      });

      reviewSpan.setAttribute('policy.decision', policyResult.decision);
      reviewSpan.setAttribute('recovery.outcome', outcomeStatus);

      return {
        success: true,
        caseId: decision.id,
        reviewStatus,
        policyDecision: policyResult.decision,
        execution: {
          executed: policyResult.decision === POLICY_DECISIONS.ALLOW,
          action: targetAction,
          success: executionResult?.success ?? false,
          output: executionResult?.output ?? {},
        },
        message: policyResult.decision === POLICY_DECISIONS.ALLOW
          ? 'Recovery case modified and executed successfully'
          : `Recovery case modified by merchant but policy resulted in ${policyResult.decision}`,
      };
    } finally {
      await releaseLock(lockKey);
    }
    });
  }

  /**
   * Merchant REJECT flow
   * Rejects recovery case without tool execution and creates permanent audit record.
   */
  static async rejectCase(caseId, {
    reviewerId = 'merchant_admin',
    reasoning = 'Rejected by merchant',
  } = {}) {
    return withSpan('hitl.review', {
      attributes: {
        'case.id': caseId,
        'hitl.action': 'REJECT',
        'reviewer.id': reviewerId,
      },
    }, async (reviewSpan) => {
      const lockKey = `lock:review:${caseId}`;
      const acquired = await acquireLock(lockKey, 10);
      if (!acquired) {
        const err = new Error('A concurrent review action is currently in progress for this recovery case');
        err.statusCode = 409;
        err.code = 'CONCURRENT_REVIEW_CONFLICT';
        throw err;
      }

      try {
        const record = await getDecisionById(caseId);
        if (!record) {
          const err = new Error(`Recovery case '${caseId}' not found`);
          err.statusCode = 404;
          err.code = 'CASE_NOT_FOUND';
          throw err;
        }

      const { decision, transaction, customer } = record;

      if (decision.status !== 'pending_review') {
        const err = new Error(`Recovery case is already in '${decision.status}' status and cannot be rejected.`);
        err.statusCode = 400;
        err.code = 'INVALID_CASE_STATUS';
        throw err;
      }

      if (transaction.status === 'recovered' || transaction.status === 'abandoned') {
        const err = new Error(`Transaction has already reached terminal status '${transaction.status}'. Rejection blocked.`);
        err.statusCode = 400;
        err.code = 'TERMINAL_TRANSACTION_STATE';
        throw err;
      }

      // Record Override
      await createOverride({
        decisionId: decision.id,
        merchantAction: 'REJECT',
        merchantReasoning: reasoning,
      });

      const updatedAgentAnalyst = {
        ...decision.agentAnalystResponse,
        humanReview: {
          reviewerId,
          reviewAction: 'REJECT',
          reasoning,
          reviewedAt: new Date().toISOString(),
          policyBefore: decision.guardrailResult,
          policyAfter: decision.guardrailResult,
          actionExecuted: null,
          executionResult: { success: false, skipped: true, reason: 'rejected_by_merchant' },
        },
      };

      await db
        .update(decisions)
        .set({
          status: 'rejected',
          agentAnalystResponse: updatedAgentAnalyst,
        })
        .where(eq(decisions.id, decision.id));

      // Publish Outcome Event
      const outcomePayload = {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.RECOVERY_FAILED,
        occurredAt: new Date().toISOString(),
        transactionId: transaction.id,
        caseId: decision.id,
        customerId: customer.id,
        outcome: OUTCOME_TYPES.BLOCKED,
        toolName: decision.recommendedAction,
        recoveredAmount: 0,
        currency: transaction.currency || 'INR',
        details: {
          humanReview: true,
          reviewerId,
          reviewAction: 'REJECT',
          rejectionReason: reasoning,
          guardrailDecision: decision.guardrailResult,
        },
        version: 1,
      };

      await ObservabilityService.recordLifecycleEvent({
        transactionId: transaction.id,
        caseId: decision.id,
        eventType: AUDIT_EVENT_TYPES.HUMAN_REJECTED,
        details: {
          reviewerId,
          reasoning,
          policyBefore: decision.guardrailResult,
          policyAfter: decision.guardrailResult,
          action: decision.recommendedAction,
        },
      });

      await publishOutcomeEvent(outcomePayload);

      metrics.recordHitlReview('reject', true);

      reviewLogger.info('review_case_rejected', {
        event: 'review_case_rejected',
        caseId: decision.id,
        transactionId: transaction.id,
        reviewerId,
        rejectionReason: reasoning,
        action: decision.recommendedAction,
      });

      reviewSpan.setAttribute('policy.decision', decision.guardrailResult);
      reviewSpan.setAttribute('recovery.outcome', OUTCOME_TYPES.BLOCKED);

      return {
        success: true,
        caseId: decision.id,
        reviewStatus: REVIEW_STATUSES.REJECTED,
        policyDecision: decision.guardrailResult,
        execution: {
          executed: false,
          action: decision.recommendedAction,
        },
        message: 'Recovery case rejected by merchant. No recovery action executed.',
      };
    } finally {
      await releaseLock(lockKey);
    }
    });
  }

  /**
   * Action parameter validation helper
   */
  static validateModifiedParameters(action, params) {
    if (action === 'send_recovery_message') {
      if (params.channel && !['email', 'sms', 'whatsapp'].includes(params.channel)) {
        const err = new Error(`Invalid channel '${params.channel}'. Allowed channels: email, sms, whatsapp`);
        err.statusCode = 400;
        err.code = 'INVALID_PARAMETER';
        throw err;
      }
    }

    if (action === 'schedule_retry') {
      if (params.delayHours !== undefined && (typeof params.delayHours !== 'number' || params.delayHours <= 0 || params.delayHours > 168)) {
        const err = new Error(`Invalid delayHours '${params.delayHours}'. Must be a positive number up to 168 (1 week).`);
        err.statusCode = 400;
        err.code = 'INVALID_PARAMETER';
        throw err;
      }
    }
  }
}
