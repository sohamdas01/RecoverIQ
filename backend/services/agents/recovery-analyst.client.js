/**
 * RecoverIQ Backend - Agent 1 (Recovery Analyst) Client
 * Phase 5 - Step 2: Agent 1 Recovery Analyst
 *
 * Communicates with the Python GenAI service over internal API.
 * Validates responses strictly before passing to the Policy Engine.
 * Provides safe deterministic fallback when the GenAI service is unreachable.
 */

import axios from 'axios';
import { config } from '../config/index.js';
import { SUPPORTED_ACTIONS } from '../policy/policy.types.js';

export class RecoveryAnalystClient {
  /**
   * Request structured recovery analysis and recommendation from Agent 1.
   *
   * @param {Object} params Context parameters
   * @param {Object} params.transaction Authoritative transaction object from PostgreSQL
   * @param {Object} params.customer Customer record
   * @param {Object} params.customerStats Historical stats
   * @param {Object} params.mlPrediction ML prediction from LightGBM model
   * @param {Object} options Optional client options (e.g. timeout)
   * @returns {Promise<Object>} Validated Agent 1 recommendation
   */
  static async analyze({ transaction, customer, customerStats, mlPrediction }, options = {}) {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || 3500;

    // 1. Prepare Sanitized Input Context (NO unnecessary PII)
    const payload = {
      transaction: {
        id: transaction.id,
        amount: parseFloat(transaction.amount),
        currency: transaction.currency || 'INR',
        paymentMethod: transaction.paymentMethod,
        failureReason: transaction.failureReason,
        attemptCount: transaction.attemptCount || 1,
        metadata: transaction.metadata || {},
      },
      customerHistory: {
        customerId: customer?.id,
        previousSuccesses: customerStats?.previousSuccesses || 0,
        previousFailures: customerStats?.previousFailures || 0,
        previousRecoverySuccess: !!customerStats?.previousRecoverySuccess,
      },
      subscription: transaction.paymentMethod === 'subscription_mandate',
      mlPrediction: mlPrediction ? {
        probability: mlPrediction.probability,
        reason_codes: mlPrediction.reason_codes || [],
        model_version: mlPrediction.model_version || 'v1.0.0',
      } : null,
      failureReason: transaction.failureReason,
      attemptCount: transaction.attemptCount || 1,
    };

    try {
      // 2. Call Internal Agent 1 API
      const endpoint = `${config.genaiServiceUrl}/internal/recovery/analyze`;
      const response = await axios.post(endpoint, payload, { timeout: timeoutMs });
      const latencyMs = Date.now() - startTime;

      const data = response.data;

      // 3. Strict Machine Validation of Agent 1 Response
      const validated = RecoveryAnalystClient.validateResponse(data);
      if (validated.isValid) {
        const result = {
          agentName: validated.data.metadata?.agentName || 'RecoveryAnalyst',
          agentVersion: validated.data.metadata?.agentVersion || 'v1.0',
          recommendation: validated.data.recommendation,
          action: validated.data.recommendation, // Backwards compatibility alias
          confidence: validated.data.confidence,
          reasonCodes: validated.data.reasonCodes || [],
          rationale: validated.data.rationale,
          reasoning: validated.data.rationale, // Backwards compatibility alias
          suggestedParameters: validated.data.suggestedParameters || {},
          toolParams: validated.data.suggestedParameters || {}, // Backwards compatibility alias
          playbookStrategy: validated.data.metadata?.playbookStrategy || null,
          isFallback: false,
          latencyMs,
        };

        // Observability Log
        console.log(
          JSON.stringify({
            level: 'INFO',
            event: 'AGENT_ANALYSIS_COMPLETED',
            agent: 'RecoveryAnalyst',
            transactionId: transaction.id,
            recommendation: result.recommendation,
            confidence: result.confidence,
            latencyMs,
          })
        );

        return result;
      }

      console.warn(
        `[RecoveryAnalystClient] Response validation failed: ${validated.error}. Using safe fallback.`
      );
    } catch (err) {
      console.warn(
        `[RecoveryAnalystClient] GenAI service call failed (${err.message}). Using safe deterministic fallback.`
      );
    }

    // 4. Safe Deterministic Fallback (Model failure does NOT result in unvalidated action)
    const latencyMs = Date.now() - startTime;
    const fallback = RecoveryAnalystClient.deterministicFallback({
      transaction,
      customerStats,
      mlPrediction,
    });
    fallback.latencyMs = latencyMs;

    console.log(
      JSON.stringify({
        level: 'WARN',
        event: 'AGENT_ANALYSIS_FALLBACK',
        agent: 'RecoveryAnalyst',
        transactionId: transaction.id,
        recommendation: fallback.recommendation,
        confidence: fallback.confidence,
        latencyMs,
      })
    );

    return fallback;
  }

  /**
   * Validates structure, types, and value constraints of Agent 1 output
   */
  static validateResponse(data) {
    if (!data || typeof data !== 'object') {
      return { isValid: false, error: 'Response body is not an object' };
    }

    const rec = data.recommendation || data.action;
    if (!rec || typeof rec !== 'string' || !SUPPORTED_ACTIONS.includes(rec)) {
      return { isValid: false, error: `Invalid or unsupported recommendation: ${rec}` };
    }

    const conf = typeof data.confidence === 'number' ? data.confidence : parseFloat(data.confidence);
    if (isNaN(conf) || conf < 0.0 || conf > 1.0) {
      return { isValid: false, error: `Confidence out of bounds [0, 1]: ${data.confidence}` };
    }

    const rationale = data.rationale || data.reasoning;
    if (!rationale || typeof rationale !== 'string' || rationale.trim().length === 0) {
      return { isValid: false, error: 'Rationale explanation missing or empty' };
    }

    return {
      isValid: true,
      data: {
        ...data,
        recommendation: rec,
        confidence: conf,
        rationale: rationale.trim(),
        reasonCodes: Array.isArray(data.reasonCodes) ? data.reasonCodes : [],
        suggestedParameters: data.suggestedParameters || data.toolParams || {},
      },
    };
  }

  /**
   * Deterministic safety fallback when GenAI service is offline or invalid
   */
  static deterministicFallback({ transaction, customerStats, mlPrediction }) {
    const reason = transaction.failureReason;
    const attempts = transaction.attemptCount || 1;
    const mlScore = mlPrediction?.probability ?? 0.70;

    if (reason === 'card_expired') {
      return {
        agentName: 'RecoveryAnalyst',
        agentVersion: 'v1.0-fallback',
        recommendation: 'send_recovery_message',
        action: 'send_recovery_message',
        confidence: 0.95,
        reasonCodes: ['CARD_EXPIRED_FALLBACK', 'SELF_SERVICE_LINK'],
        rationale: 'Card is expired; direct retries will fail. Sending customer self-service recovery link.',
        reasoning: 'Card is expired; direct retries will fail. Sending customer self-service recovery link.',
        suggestedParameters: {
          channel: 'email',
          templateId: 'card_expired_update_v1',
          customMessage: 'Your card on file has expired. Click below to update payment details securely.',
        },
        toolParams: {
          channel: 'email',
          templateId: 'card_expired_update_v1',
          customMessage: 'Your card on file has expired. Click below to update payment details securely.',
        },
        isFallback: true,
      };
    }

    if (reason === 'high_risk_fraud') {
      return {
        agentName: 'RecoveryAnalyst',
        agentVersion: 'v1.0-fallback',
        recommendation: 'escalate_to_human',
        action: 'escalate_to_human',
        confidence: 0.98,
        reasonCodes: ['HIGH_RISK_FRAUD_FLAGGED', 'SECURITY_QUARANTINE'],
        rationale: 'High risk fraud detected. Escalating immediately to risk operations.',
        reasoning: 'High risk fraud detected. Escalating immediately to risk operations.',
        suggestedParameters: { priority: 'urgent', reason: 'Flagged for high-risk fraud activity.' },
        toolParams: { priority: 'urgent', reason: 'Flagged for high-risk fraud activity.' },
        isFallback: true,
      };
    }

    if (reason === 'bank_outage' || reason === 'network_timeout') {
      return {
        agentName: 'RecoveryAnalyst',
        agentVersion: 'v1.0-fallback',
        recommendation: 'attempt_recovery',
        action: 'attempt_recovery',
        confidence: 0.90,
        reasonCodes: ['TRANSIENT_GATEWAY_OUTAGE', 'IMMEDIATE_CAPTURE'],
        rationale: 'Transient network/gateway error identified. Immediate retry has high probability of capture.',
        reasoning: 'Transient network/gateway error identified. Immediate retry has high probability of capture.',
        suggestedParameters: {
          paymentId: `pay_${Date.now()}`,
          reason: 'Gateway/bank network glitch recovered, retrying immediate capture',
        },
        toolParams: {
          paymentId: `pay_${Date.now()}`,
          reason: 'Gateway/bank network glitch recovered, retrying immediate capture',
        },
        isFallback: true,
      };
    }

    if (reason === 'insufficient_funds') {
      if (attempts >= 3) {
        return {
          agentName: 'RecoveryAnalyst',
          agentVersion: 'v1.0-fallback',
          recommendation: 'send_recovery_message',
          action: 'send_recovery_message',
          confidence: 0.85,
          reasonCodes: ['MULTI_ATTEMPT_FUNDS_EXHAUSTED', 'ALTERNATIVE_PAYMENT_METHOD'],
          rationale: 'Repeated insufficient funds failures. Customer message sent with alternative payment methods.',
          reasoning: 'Repeated insufficient funds failures. Customer message sent with alternative payment methods.',
          suggestedParameters: {
            channel: 'email',
            templateId: 'payment_failed_alternative_method',
          },
          toolParams: {
            channel: 'email',
            templateId: 'payment_failed_alternative_method',
          },
          isFallback: true,
        };
      }
      return {
        agentName: 'RecoveryAnalyst',
        agentVersion: 'v1.0-fallback',
        recommendation: 'schedule_retry',
        action: 'schedule_retry',
        confidence: 0.82,
        reasonCodes: ['INSUFFICIENT_FUNDS_SCHEDULED_WINDOW'],
        rationale: 'Transient insufficient funds; scheduling retry for next banking clearing window.',
        reasoning: 'Transient insufficient funds; scheduling retry for next banking clearing window.',
        suggestedParameters: {
          delayHours: 6,
          reason: 'Schedule retry for standard banking settlement window',
        },
        toolParams: {
          delayHours: 6,
          reason: 'Schedule retry for standard banking settlement window',
        },
        isFallback: true,
      };
    }

    return {
      agentName: 'RecoveryAnalyst',
      agentVersion: 'v1.0-fallback',
      recommendation: 'send_recovery_message',
      action: 'send_recovery_message',
      confidence: 0.70,
      reasonCodes: ['BASELINE_RECOVERY_HEURISTIC'],
      rationale: 'General failure reason; routing customer to self-serve checkout link.',
      reasoning: 'General failure reason; routing customer to self-serve checkout link.',
      suggestedParameters: { channel: 'email' },
      toolParams: { channel: 'email' },
      isFallback: true,
    };
  }
}
