/**
 * RecoverIQ Observability & Audit Service
 * Phase 5 - Step 6: Decision Persistence, Audit & Observability
 *
 * Provides centralized audit logging, secret scrubbing, and full decision lineage reconstruction.
 */

import { getDecisionById } from '../../db/queries/decisions.queries.js';
import { getActionsByDecisionId } from '../../db/queries/actions.queries.js';
import { getOverridesByDecisionId } from '../../db/queries/overrides.queries.js';
import { createMessage, getMessagesByTransactionId } from '../../db/queries/messages.queries.js';

export const AUDIT_EVENT_TYPES = {
  RECOVERY_RECEIVED: 'recovery_received',
  ML_PREDICTED: 'ml_predicted',
  AGENT1_COMPLETED: 'agent1_completed',
  AGENT2_COMPLETED: 'agent2_completed',
  POLICY_EVALUATED: 'policy_evaluated',
  PENDING_REVIEW: 'pending_review',
  HUMAN_APPROVED: 'human_approved',
  HUMAN_MODIFIED: 'human_modified',
  HUMAN_REJECTED: 'human_rejected',
  ACTION_EXECUTED: 'action_executed',
  RECOVERY_COMPLETED: 'recovery_completed',
  RECOVERY_BLOCKED: 'recovery_blocked',
  RECOVERY_FAILED: 'recovery_failed',
  EVENT_REPLAYED: 'event_replayed',
};

const SENSITIVE_KEY_PATTERN = /^(password|secret|token|apiKey|key|authorization|cvv|pan|card_number|auth_token|jwt)$/i;

export class ObservabilityService {
  /**
   * Deeply sanitizes an object, stripping or masking sensitive keys/values
   *
   * @param {any} obj Payload to sanitize
   * @returns {any} Clean sanitized object
   */
  static sanitizeForAudit(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (obj instanceof Date) return obj.toISOString();

    if (Array.isArray(obj)) {
      return obj.map((item) => ObservabilityService.sanitizeForAudit(item));
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        cleaned[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        cleaned[key] = ObservabilityService.sanitizeForAudit(value);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  /**
   * Logs a structured JSON observability event to stdout and optionally persists to messages table
   */
  static async recordLifecycleEvent({
    transactionId,
    caseId = null,
    eventId = null,
    eventType,
    level = 'INFO',
    details = {},
    persistToDb = true,
  }) {
    const timestamp = new Date().toISOString();
    const sanitizedDetails = ObservabilityService.sanitizeForAudit(details);

    const logRecord = {
      timestamp,
      level,
      event: eventType,
      caseId,
      transactionId,
      eventId,
      details: sanitizedDetails,
    };

    // Structured JSON log output
    console.log(JSON.stringify(logRecord));

    // Durable DB message record if transactionId provided
    if (persistToDb && transactionId) {
      try {
        await createMessage({
          transactionId,
          eventTaken: eventType,
          channel: details.channel || 'system',
          details: {
            caseId,
            eventId,
            timestamp,
            ...sanitizedDetails,
          },
        });
      } catch (err) {
        console.warn(`[Observability] Failed to persist audit message record: ${err.message}`);
      }
    }

    return logRecord;
  }

  /**
   * Full Decision Lineage Reconstructability Query
   * Used for Ask RecoverIQ, merchant explainability, audit investigations.
   *
   * @param {string} caseId Decision ID
   * @returns {Promise<Object|null>} Complete decision lineage and evidence explanation
   */
  static async getDecisionExplanation(caseId) {
    const record = await getDecisionById(caseId);
    if (!record) return null;

    const { decision, transaction, customer } = record;
    const analystData = decision.agentAnalystResponse || {};
    const actions = await getActionsByDecisionId(caseId);
    const overrides = await getOverridesByDecisionId(caseId);
    const messages = await getMessagesByTransactionId(transaction.id);

    const lineage = analystData.lineage || {
      caseId: decision.id,
      transactionId: transaction.id,
      originalEventId: analystData.originalEventId || null,
      replayEventId: analystData.replayEventId || null,
    };

    // Construct structured explanation
    return {
      caseId: decision.id,
      transactionId: transaction.id,
      lineage,
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
        metadata: ObservabilityService.sanitizeForAudit(transaction.metadata || {}),
        createdAt: transaction.createdAt,
      },
      status: decision.status,
      finalAction: decision.finalAction || decision.recommendedAction,
      ml: {
        score: decision.mlScore,
        probability: decision.mlScore,
        modelVersion: analystData.mlModelVersion || analystData.ml?.modelVersion || 'v1.0.0',
        reasonCodes: analystData.mlReasonCodes || analystData.ml?.reasonCodes || [],
        attributions: analystData.mlAttributions || analystData.ml?.attributions || [],
        isFallback: analystData.ml?.isFallback || false,
      },
      agent1: analystData.agent1 || {
        agentName: 'RecoveryAnalyst',
        recommendation: decision.recommendedAction,
        confidence: analystData.confidence || 0.8,
        rationale: decision.reasoning,
        reasonCodes: analystData.reasonCodes || [],
      },
      agent2: analystData.agent2 || {
        agentName: 'RecoveryExecutor',
        proposedAction: decision.recommendedAction,
        confidence: analystData.confidence || 0.8,
        rationale: decision.reasoning,
        parameters: analystData.toolParams || {},
      },
      policy: {
        decision: decision.guardrailResult,
        policyVersion: analystData.policyVersion || 'v1',
        primaryRuleId: analystData.ruleId,
        appliedRules: analystData.appliedRules || [analystData.ruleId],
        reasons: analystData.reasons || [decision.reasoning],
        evaluatedAt: analystData.evaluatedAt,
      },
      humanReview: analystData.humanReview || null,
      execution: analystData.execution || (actions.length > 0 ? {
        toolName: actions[0].toolName,
        status: actions[0].status,
        success: actions[0].status === 'success',
        result: ObservabilityService.sanitizeForAudit(actions[0].result || {}),
        executedAt: actions[0].executedAt,
      } : null),
      actions: actions.map((a) => ({
        id: a.id,
        toolName: a.toolName,
        status: a.status,
        params: ObservabilityService.sanitizeForAudit(a.toolParams || {}),
        result: ObservabilityService.sanitizeForAudit(a.result || {}),
        executedAt: a.executedAt,
      })),
      overrides: overrides.map((o) => ({
        id: o.id,
        merchantAction: o.merchantAction,
        merchantReasoning: o.merchantReasoning,
        createdAt: o.createdAt,
      })),
      timeline: messages.map((m) => ({
        id: m.id,
        eventType: m.eventTaken,
        channel: m.channel,
        details: ObservabilityService.sanitizeForAudit(m.details || {}),
        timestamp: m.createdAt,
      })),
      isReplay: !!(lineage.replayEventId || analystData.isReplay),
      createdAt: decision.createdAt,
    };
  }
}
