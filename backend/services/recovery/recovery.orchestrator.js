/**
 * RecoverIQ Recovery Orchestrator
 * Phase 5 - Step 6: Decision Persistence, Audit & Observability
 *
 * Coordinates the full recovery decision lifecycle:
 * ML Prediction -> Agent 1 (Analyst) -> Agent 2 (Executor) -> Backend Validation -> Policy Engine (Authority) -> Execution Gate -> Persistence -> Outcome
 *
 * Lineage:
 * event -> ML prediction -> Agent 1 analysis -> Agent 2 proposal -> Policy evaluation -> Human review (if required) -> Execution -> Outcome
 */

import crypto from 'crypto';
import { RecoveryAnalystClient } from '../agents/recovery-analyst.client.js';
import { RecoveryExecutorClient } from '../agents/recovery-executor.client.js';
import { evaluatePolicy, POLICY_DECISIONS } from '../policy/index.js';
import { executeTool } from '../tools/index.js';
import { getMLPrediction } from '../ml/index.js';
import { ObservabilityService, AUDIT_EVENT_TYPES } from '../observability/index.js';
import { createDecision } from '../../db/queries/decisions.queries.js';
import { createAction, updateActionResult } from '../../db/queries/actions.queries.js';
import { EVENT_TYPES, OUTCOME_TYPES } from '../../kafka/schemas/events.schema.js';

export class RecoveryOrchestrator {
  /**
   * Orchestrates the complete end-to-end recovery pipeline for an authoritative transaction
   *
   * @param {Object} params Pipeline input parameters
   * @param {Object} params.transaction Authoritative PostgreSQL transaction record
   * @param {Object} params.customer Customer record
   * @param {Object} [params.customerStats] Historical customer stats
   * @param {string} [params.originalEventId] Ingestion event ID for tracing
   * @param {Object} [params.options] Execution options
   * @returns {Promise<Object>} Complete pipeline result with decision, execution, and outcome payload
   */
  static async orchestrateRecovery({
    transaction,
    customer,
    customerStats = {},
    eventId: directEventId = null,
    originalEventId = null,
    replayEventId: directReplayEventId = null,
    options = {},
  }) {
    const startTime = Date.now();
    const eventId = directEventId || options.eventId || crypto.randomUUID();
    const replayEventId = directReplayEventId || options.replayEventId || null;

    // Record Ingestion Audit Event
    await ObservabilityService.recordLifecycleEvent({
      transactionId: transaction.id,
      eventId,
      eventType: AUDIT_EVENT_TYPES.RECOVERY_RECEIVED,
      details: {
        amount: parseFloat(transaction.amount),
        currency: transaction.currency || 'INR',
        failureReason: transaction.failureReason,
        attemptCount: transaction.attemptCount || 1,
        paymentMethod: transaction.paymentMethod,
        originalEventId,
        replayEventId,
      },
    });

    // -------------------------------------------------------------
    // Step 1: ML Recovery Likelihood Inference (Phase 3 Integration)
    // -------------------------------------------------------------
    const mlPrediction = options.mlPrediction || await getMLPrediction({
      amount: parseFloat(transaction.amount),
      payment_method: transaction.paymentMethod,
      failure_reason: transaction.failureReason,
      attempt_count: transaction.attemptCount || 1,
      days_since_failure: 0.0,
      day_of_month: new Date().getDate(),
      hour_of_day: new Date().getHours(),
      previous_successes: customerStats.previousSuccesses || 0,
      previous_failures: customerStats.previousFailures || 0,
      previous_recovery_success: !!customerStats.previousRecoverySuccess,
      is_subscription: transaction.paymentMethod === 'subscription_mandate',
    });

    // -------------------------------------------------------------
    // Step 2: Agent 1 (Recovery Analyst) Strategic Analysis
    // -------------------------------------------------------------
    const agent1Analysis = options.agent1Analysis || await RecoveryAnalystClient.analyze({
      transaction,
      customer,
      customerStats,
      mlPrediction,
    }, options.agent1Options || {});

    // -------------------------------------------------------------
    // Step 3: Agent 2 (Recovery Executor / Action Planner) Proposal
    // -------------------------------------------------------------
    const agent2Proposal = options.agent2Proposal || await RecoveryExecutorClient.plan({
      transaction,
      customer,
      customerStats,
      mlPrediction,
      agent1Recommendation: agent1Analysis,
    }, options.agent2Options || {});

    // -------------------------------------------------------------
    // Step 4: Backend Sanitization & Policy Context Normalization
    // -------------------------------------------------------------
    const sanitizedParams = RecoveryExecutorClient.sanitizeParameters(
      agent2Proposal.proposedAction,
      agent2Proposal.parameters || {}
    );

    const normalizedPolicyContext = {
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
      customer: customer || (transaction.customerId ? { id: transaction.customerId } : null),
      subscription: transaction.paymentMethod === 'subscription_mandate',
      recoveryContext: customerStats,
      mlPrediction,
      agent1Recommendation: agent1Analysis,
      agent2Proposal,
      proposedAction: agent2Proposal.proposedAction,
      toolParams: sanitizedParams,
      metadata: transaction.metadata || {},
    };

    // -------------------------------------------------------------
    // Step 5: Policy Engine Evaluation (Sole Backend Authority)
    // -------------------------------------------------------------
    const policyResult = evaluatePolicy(normalizedPolicyContext);

    // Record Policy Evaluation Audit Event
    await ObservabilityService.recordLifecycleEvent({
      transactionId: transaction.id,
      eventId,
      eventType: AUDIT_EVENT_TYPES.POLICY_EVALUATED,
      details: {
        policyDecision: policyResult.decision,
        primaryRuleId: policyResult.ruleId,
        appliedRules: policyResult.appliedRules,
        reasons: policyResult.reasons,
        mlProbability: mlPrediction.probability,
        agent1Recommendation: agent1Analysis.recommendation,
        agent2ProposedAction: agent2Proposal.proposedAction,
      },
    });

    // -------------------------------------------------------------
    // Step 6: Atomic Decision Record Persistence with Lineage
    // -------------------------------------------------------------
    const decisionStatus = policyResult.decision === POLICY_DECISIONS.ALLOW
      ? 'executed'
      : policyResult.decision === POLICY_DECISIONS.REQUIRE_APPROVAL
      ? 'pending_review'
      : 'blocked';

    const decision = await createDecision({
      transactionId: transaction.id,
      agentAnalystResponse: {
        lineage: {
          transactionId: transaction.id,
          eventId,
          originalEventId: originalEventId || null,
          replayEventId: replayEventId || null,
        },
        ml: {
          modelName: 'recoveriq-xgboost',
          modelVersion: mlPrediction.model_version || 'v1.0.0',
          probability: mlPrediction.probability,
          reasonCodes: mlPrediction.reason_codes || [],
          attributions: mlPrediction.attributions || [],
          isFallback: mlPrediction.model_version?.includes('fallback') || false,
          predictedAt: new Date().toISOString(),
        },
        agent1: {
          agentName: agent1Analysis.agentName || 'RecoveryAnalyst',
          agentVersion: agent1Analysis.agentVersion || 'v1.0',
          recommendation: agent1Analysis.recommendation,
          confidence: agent1Analysis.confidence,
          rationale: agent1Analysis.rationale,
          reasonCodes: agent1Analysis.reasonCodes || [],
          suggestedParameters: ObservabilityService.sanitizeForAudit(agent1Analysis.suggestedParameters || {}),
          isFallback: agent1Analysis.isFallback || false,
          latencyMs: agent1Analysis.latencyMs || null,
          timestamp: new Date().toISOString(),
        },
        agent2: {
          agentName: agent2Proposal.agentName || 'RecoveryExecutor',
          agentVersion: agent2Proposal.agentVersion || 'v1.0',
          proposedAction: agent2Proposal.proposedAction,
          confidence: agent2Proposal.confidence,
          rationale: agent2Proposal.rationale,
          reasonCodes: agent2Proposal.reasonCodes || [],
          parameters: ObservabilityService.sanitizeForAudit(sanitizedParams),
          isFallback: agent2Proposal.isFallback || false,
          latencyMs: agent2Proposal.latencyMs || null,
          timestamp: new Date().toISOString(),
        },
        policy: {
          decision: policyResult.decision,
          policyVersion: policyResult.policyVersion,
          primaryRuleId: policyResult.ruleId,
          appliedRules: policyResult.appliedRules,
          reasons: policyResult.reasons,
          evaluatedAt: policyResult.evaluatedAt,
        },
        confidence: agent2Proposal.confidence,
        rawReasoning: agent2Proposal.rationale,
        suggestedTool: agent2Proposal.proposedAction,
        toolParams: sanitizedParams,
        reasonCodes: agent2Proposal.reasonCodes || [],
        isFallback: agent2Proposal.isFallback || false,
        latencyMs: Date.now() - startTime,
        appliedRules: policyResult.appliedRules,
        ruleId: policyResult.ruleId,
        reasons: policyResult.reasons,
        policyVersion: policyResult.policyVersion,
        evaluatedAt: policyResult.evaluatedAt,
        mlReasonCodes: mlPrediction.reason_codes || [],
        mlModelVersion: mlPrediction.model_version,
        mlAttributions: mlPrediction.attributions || [],
      },
      mlScore: mlPrediction.probability,
      recommendedAction: agent2Proposal.proposedAction,
      guardrailResult: policyResult.decision,
      finalAction: policyResult.decision === POLICY_DECISIONS.ALLOW ? agent2Proposal.proposedAction : undefined,
      reasoning: `${agent2Proposal.rationale} | Policy: ${policyResult.reason}`,
      status: decisionStatus,
    });

    // -------------------------------------------------------------
    // Step 7: Execution Gate (Strict Policy Authority Gate)
    // -------------------------------------------------------------
    let executionResult = null;
    let outcomeEventType = EVENT_TYPES.RECOVERY_COMPLETED;
    let outcomeStatus = OUTCOME_TYPES.RECOVERED;

    if (policyResult.decision === POLICY_DECISIONS.ALLOW) {
      const toolExecStartTime = Date.now();

      // Record pending action in DB
      const actionRecord = await createAction({
        decisionId: decision.id,
        toolName: agent2Proposal.proposedAction,
        toolParams: {
          ...sanitizedParams,
          transactionId: transaction.id,
          amount: parseFloat(transaction.amount),
          currency: transaction.currency,
        },
        status: 'pending',
      });

      // Execute bounded tool
      executionResult = await executeTool(agent2Proposal.proposedAction, {
        ...sanitizedParams,
        transactionId: transaction.id,
        amount: parseFloat(transaction.amount),
        currency: transaction.currency,
      });

      const execDurationMs = Date.now() - toolExecStartTime;

      // Update action record in DB
      if (actionRecord?.id) {
        await updateActionResult(
          actionRecord.id,
          executionResult.success ? 'success' : 'failed',
          ObservabilityService.sanitizeForAudit(executionResult.output || {})
        );
      }

      // Record Execution Audit Event
      await ObservabilityService.recordLifecycleEvent({
        transactionId: transaction.id,
        caseId: decision.id,
        eventId,
        eventType: AUDIT_EVENT_TYPES.ACTION_EXECUTED,
        details: {
          toolName: agent2Proposal.proposedAction,
          durationMs: execDurationMs,
          success: executionResult.success,
          output: ObservabilityService.sanitizeForAudit(executionResult.output || {}),
        },
      });

      // Determine outcome classification
      if (!executionResult.success) {
        outcomeEventType = EVENT_TYPES.RECOVERY_FAILED;
        outcomeStatus = OUTCOME_TYPES.FAILED;
      } else if (agent2Proposal.proposedAction === 'escalate_to_human') {
        outcomeEventType = EVENT_TYPES.RECOVERY_ESCALATED;
        outcomeStatus = OUTCOME_TYPES.ESCALATED;
      } else if (agent2Proposal.proposedAction === 'schedule_retry') {
        outcomeEventType = EVENT_TYPES.RECOVERY_SCHEDULED;
        outcomeStatus = OUTCOME_TYPES.SCHEDULED;
      } else {
        outcomeEventType = EVENT_TYPES.RECOVERY_COMPLETED;
        outcomeStatus = OUTCOME_TYPES.RECOVERED;
      }

    } else if (policyResult.decision === POLICY_DECISIONS.REQUIRE_APPROVAL) {
      outcomeEventType = EVENT_TYPES.RECOVERY_SCHEDULED;
      outcomeStatus = OUTCOME_TYPES.PENDING_REVIEW;
      executionResult = null;

      await ObservabilityService.recordLifecycleEvent({
        transactionId: transaction.id,
        caseId: decision.id,
        eventId,
        eventType: AUDIT_EVENT_TYPES.PENDING_REVIEW,
        details: {
          primaryRuleId: policyResult.ruleId,
          reasons: policyResult.reasons,
        },
      });

    } else {
      outcomeEventType = EVENT_TYPES.RECOVERY_FAILED;
      outcomeStatus = OUTCOME_TYPES.BLOCKED;
      executionResult = null;

      await ObservabilityService.recordLifecycleEvent({
        transactionId: transaction.id,
        caseId: decision.id,
        eventId,
        eventType: AUDIT_EVENT_TYPES.RECOVERY_BLOCKED,
        details: {
          primaryRuleId: policyResult.ruleId,
          reasons: policyResult.reasons,
        },
      });
    }

    // -------------------------------------------------------------
    // Step 8: Construct Complete Outcome Event Payload
    // -------------------------------------------------------------
    const outcomePayload = {
      eventId: crypto.randomUUID(),
      eventType: outcomeEventType,
      occurredAt: new Date().toISOString(),
      transactionId: transaction.id,
      caseId: decision.id,
      customerId: customer?.id || transaction.customerId,
      outcome: outcomeStatus,
      toolName: agent2Proposal.proposedAction,
      recoveredAmount: (outcomeStatus === OUTCOME_TYPES.RECOVERED && agent2Proposal.proposedAction === 'attempt_recovery')
        ? parseFloat(transaction.amount)
        : 0,
      currency: transaction.currency || 'INR',
      details: {
        originalEventId,
        guardrailDecision: policyResult.decision,
        guardrailReason: policyResult.reason,
        appliedRules: policyResult.appliedRules,
        ruleId: policyResult.ruleId,
        policyVersion: policyResult.policyVersion,
        agent1Recommendation: agent1Analysis.recommendation,
        agent2ProposedAction: agent2Proposal.proposedAction,
        agentConfidence: agent2Proposal.confidence,
        mlScore: mlPrediction.probability,
        mlReasonCodes: mlPrediction.reason_codes,
        toolExecutionSuccess: executionResult ? executionResult.success : null,
        toolOutput: ObservabilityService.sanitizeForAudit(executionResult?.output || {}),
      },
      version: 1,
    };

    return {
      transaction,
      customer,
      mlPrediction,
      agent1Analysis,
      agent2Proposal,
      policyResult,
      guardrailCheck: policyResult,
      policyCheck: policyResult,
      decision,
      executionResult,
      outcomeStatus,
      outcomeEventType,
      outcomePayload,
      durationMs: Date.now() - startTime,
    };
  }
}
