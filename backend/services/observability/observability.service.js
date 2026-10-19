/**
 * RecoverIQ Observability & Audit Service
 * Phase 5 - Step 6: Decision Persistence, Audit & Observability
 * Phase 7 - Step 3: Live Recovery Activity Feed
 *
 * Provides centralized audit logging, secret scrubbing, full decision lineage reconstruction,
 * and sanitized live recovery activity streaming.
 */

import { getDecisionById, getRecentDecisions } from '../../db/queries/decisions.queries.js';
import { getActionsByDecisionId } from '../../db/queries/actions.queries.js';
import { getOverridesByDecisionId } from '../../db/queries/overrides.queries.js';
import { createMessage, getMessagesByTransactionId, getRecentMessages } from '../../db/queries/messages.queries.js';
import { logger } from '../logger/index.js';
import { resolveScope } from '../auth/tenant-scope.js';

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

const SENSITIVE_KEY_PATTERN = /^(password|secret|token|apiKey|api_key|key|authorization|cvv|pan|card_number|auth_token|authToken|bearer|privateKey|jwt)$/i;

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
   * Retrieves recent recovery lifecycle activity events for the merchant dashboard live feed.
   * Returns only sanitized, safe fields:
   * - caseId
   * - transactionId
   * - eventType (payment_received, analysis_completed, agent_recommended, policy_evaluated, pending_review, action_executed, recovery_completed, recovery_blocked, recovery_failed)
   * - status ('processing' | 'success' | 'review' | 'blocked' | 'failed')
   * - action
   * - policyDecision ('ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK' | 'N/A')
   * - timestamp (ISO string)
   * - summary (human-readable title/description)
   */
  static async getRecentActivity(limit = 50, { merchantId, system } = {}) {
    const scope = resolveScope({ merchantId, system });
    const rawLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    // 1. Fetch recent messages & recent decisions
    const [recentMsgs, recentDecisions] = await Promise.all([
      getRecentMessages(rawLimit * 2, scope).catch(() => []),
      getRecentDecisions(rawLimit, scope).catch(() => []),
    ]);

    // Build map of decisions for fast metadata enrichment
    const decisionMap = new Map();
    const txnToDecMap = new Map();
    for (const item of recentDecisions) {
      if (item.decision) {
        decisionMap.set(item.decision.id, item);
        txnToDecMap.set(item.decision.transactionId, item);
      }
    }

    const activityList = [];
    const seenEventKeys = new Set();

    // Helper to map event type to normalized safe schema
    const formatActivityEvent = (rawEvent) => {
      const {
        caseId,
        transactionId,
        rawType,
        timestamp,
        details = {},
        decisionItem = null,
      } = rawEvent;

      const dec = decisionItem?.decision || {};
      const action = details.action || details.recommendedAction || details.proposedAction || dec.finalAction || dec.recommendedAction || 'attempt_recovery';
      const policyDecision = details.policyDecision || details.guardrailResult || dec.guardrailResult || 'ALLOW';

      let eventType = 'processing';
      let status = 'processing';
      let summary = 'Processing recovery case';

      switch (rawType) {
        case 'recovery_received':
        case 'payment_received':
          eventType = 'payment_received';
          status = 'processing';
          summary = `Transaction failure recorded (${details.failureReason || 'Declined'}). Initiating recovery evaluation.`;
          break;

        case 'ml_predicted':
          eventType = 'ml_predicted';
          status = 'processing';
          summary = `ML model predicted ${Math.round((details.probability || details.score || dec.mlScore || 0.75) * 100)}% recovery probability.`;
          break;

        case 'agent1_completed':
        case 'analysis_completed':
          eventType = 'analysis_completed';
          status = 'processing';
          summary = `Recovery Analyst completed playbook diagnosis for action '${action}'.`;
          break;

        case 'agent2_completed':
        case 'agent_recommended':
          eventType = 'agent_recommended';
          status = 'processing';
          summary = `Recovery Executor formulated execution plan for '${action}'.`;
          break;

        case 'policy_evaluated':
          eventType = 'policy_evaluated';
          if (policyDecision === 'BLOCK') {
            status = 'blocked';
            summary = 'Policy Engine BLOCKED proposed recovery action.';
          } else if (policyDecision === 'REQUIRE_APPROVAL') {
            status = 'review';
            summary = 'Policy Engine gated action: REQUIRE_APPROVAL by merchant.';
          } else {
            status = 'processing';
            summary = 'Policy Engine evaluated: ALLOW.';
          }
          break;

        case 'pending_review':
        case 'escalated':
          eventType = 'pending_review';
          status = 'review';
          summary = 'Awaiting merchant review in Human-in-the-Loop queue.';
          break;

        case 'human_approved':
          eventType = 'human_approved';
          status = 'processing';
          summary = 'Merchant approved recovery action for dispatch.';
          break;

        case 'human_modified':
          eventType = 'human_modified';
          status = 'processing';
          summary = `Merchant modified recovery action to '${action}'.`;
          break;

        case 'human_rejected':
          eventType = 'human_rejected';
          status = 'blocked';
          summary = 'Merchant rejected recovery action.';
          break;

        case 'action_executed':
        case 'recovery_link_sent':
        case 'retry_scheduled':
          eventType = 'action_executed';
          status = 'success';
          summary = `Recovery tool '${details.toolName || action}' executed successfully.`;
          break;

        case 'recovery_completed':
        case 'resolved':
          eventType = 'recovery_completed';
          status = 'success';
          summary = 'Payment successfully recovered and settled.';
          break;

        case 'recovery_blocked':
          eventType = 'recovery_blocked';
          status = 'blocked';
          summary = 'Case blocked by safety guardrail or fraud rule.';
          break;

        case 'recovery_failed':
          eventType = 'recovery_failed';
          status = 'failed';
          summary = 'Recovery attempt failed or exhausted.';
          break;

        default:
          eventType = rawType || 'processing';
          status = 'processing';
          summary = `Recovery lifecycle event: ${rawType}`;
      }

      return {
        caseId: caseId || dec.id || transactionId,
        transactionId,
        eventType,
        status,
        action,
        policyDecision,
        timestamp: timestamp instanceof Date ? timestamp.toISOString() : (timestamp || new Date().toISOString()),
        summary,
      };
    };

    // Process messages table entries
    for (const msg of recentMsgs) {
      const details = msg.details || {};
      const decItem = txnToDecMap.get(msg.transactionId) || (details.caseId ? decisionMap.get(details.caseId) : null);
      const caseId = details.caseId || decItem?.decision?.id || msg.transactionId;
      const key = `${caseId}_${msg.eventTaken}_${msg.createdAt?.valueOf?.() || msg.createdAt}`;

      if (!seenEventKeys.has(key)) {
        seenEventKeys.add(key);
        activityList.push(
          formatActivityEvent({
            caseId,
            transactionId: msg.transactionId,
            rawType: msg.eventTaken,
            timestamp: msg.createdAt,
            details,
            decisionItem: decItem,
          })
        );
      }
    }

    // Process decisions to ensure recent decisions with or without messages show up
    for (const item of recentDecisions) {
      const { decision: dec, transaction: txn } = item;
      if (!dec) continue;

      let currentType = 'analysis_completed';
      if (dec.status === 'pending_review' || dec.guardrailResult === 'REQUIRE_APPROVAL') {
        currentType = 'pending_review';
      } else if (dec.status === 'executed' || dec.status === 'recovered') {
        currentType = dec.status === 'recovered' ? 'recovery_completed' : 'action_executed';
      } else if (dec.status === 'blocked' || dec.guardrailResult === 'BLOCK') {
        currentType = 'recovery_blocked';
      } else if (dec.status === 'failed') {
        currentType = 'recovery_failed';
      }

      const key = `${dec.id}_${currentType}_${dec.createdAt?.valueOf?.() || dec.createdAt}`;
      if (!seenEventKeys.has(key)) {
        seenEventKeys.add(key);
        activityList.push(
          formatActivityEvent({
            caseId: dec.id,
            transactionId: dec.transactionId,
            rawType: currentType,
            timestamp: dec.createdAt,
            details: {
              action: dec.finalAction || dec.recommendedAction,
              policyDecision: dec.guardrailResult,
              failureReason: txn?.failureReason,
            },
            decisionItem: item,
          })
        );
      }
    }

    // Sort descending by timestamp
    activityList.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return activityList.slice(0, rawLimit);
  }

  /**
   * Get recent decisions with safe error handling
   */
  static async getRecentDecisions(limit = 50, { merchantId, system } = {}) {
    const scope = resolveScope({ merchantId, system });
    try {
      return await getRecentDecisions(limit, scope);
    } catch (err) {
      return [];
    }
  }

  /**
   * Full Decision Lineage Reconstructability Query
   * Used for Ask RecoverIQ, merchant explainability, audit investigations.
   *
   * @param {string} caseId Decision ID
   * @returns {Promise<Object|null>} Complete decision lineage and evidence explanation
   */
  static async getDecisionExplanation(caseId, { merchantId, system } = {}) {
    const scope = resolveScope({ merchantId, system });
    try {
      const record = await getDecisionById(caseId, scope);
      if (!record) return null;

      const { decision, transaction, customer } = record;
      const analystData = decision.agentAnalystResponse || {};
      const actions = await getActionsByDecisionId(caseId).catch(() => []);
      const overrides = await getOverridesByDecisionId(caseId).catch(() => []);
      const messages = await getMessagesByTransactionId(transaction.id).catch(() => []);

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
      agent1: {
        agentName: analystData.agent1?.agentName || 'RecoveryAnalyst',
        recommendation: analystData.agent1?.recommendation || decision.recommendedAction,
        confidence: analystData.agent1?.confidence || analystData.confidence || 0.8,
        rationale: analystData.agent1?.rationale || decision.reasoning,
        reasonCodes: analystData.agent1?.reasonCodes || analystData.reasonCodes || [],
        playbookSources: analystData.agent1?.playbookSources || analystData.playbookSources || [],
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
  } catch (err) {
    logger.warn('get_decision_explanation_error', { caseId, error: err.message });
    return null;
  }
}
}
