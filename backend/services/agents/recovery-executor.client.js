import axios from 'axios';
import { config } from '../config/index.js';
import { SUPPORTED_ACTIONS } from '../policy/policy.types.js';
import { logger } from '../logger/index.js';
import { metrics, classifyError } from '../metrics/index.js';
import { withSpan, injectTraceContext } from '../observability/tracing.service.js';

const executorLogger = logger.withComponent('agent_executor_client');

export class RecoveryExecutorClient {
  /**
   * Request a concrete Action Plan proposal from Agent 2.
   *
   * @param {Object} params Planning input
   * @param {Object} params.transaction Authoritative transaction record
   * @param {Object} params.customer Customer record
   * @param {Object} params.customerStats Customer historical profile
   * @param {Object} params.mlPrediction ML prediction from LightGBM model
   * @param {Object} params.agent1Recommendation Structured output from Agent 1
   * @param {Object} options Optional client options
   * @returns {Promise<Object>} Validated Agent 2 Action Plan proposal
   */
  static async plan({ transaction, customer, customerStats, mlPrediction, agent1Recommendation }, options = {}) {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || 3500;

    executorLogger.debug('agent2_plan_started', {
      transactionId: transaction.id,
      agent1Recommendation: agent1Recommendation?.recommendation,
    });

    // 1. Prepare Sanitized Input Context for Agent 2
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
      mlPrediction: mlPrediction ? {
        probability: mlPrediction.probability,
        reason_codes: mlPrediction.reason_codes || [],
        model_version: mlPrediction.model_version || 'v1.0.0',
      } : null,
      agent1Recommendation: {
        recommendation: agent1Recommendation.recommendation || agent1Recommendation.action,
        confidence: agent1Recommendation.confidence,
        reasonCodes: agent1Recommendation.reasonCodes || [],
        rationale: agent1Recommendation.rationale || agent1Recommendation.reasoning || 'Recommendation provided',
        suggestedParameters: agent1Recommendation.suggestedParameters || agent1Recommendation.toolParams || {},
      },
      availableActions: SUPPORTED_ACTIONS,
    };

    return withSpan('agent2.planning', {
      attributes: {
        'agent.name': 'RecoveryExecutor',
        'peer.service': 'recoveriq-genai-service',
        'component': 'agent2_executor_client',
      },
    }, async (span) => {
      try {
        // 2. Call Internal Agent 2 API
        const endpoint = `${config.genaiServiceUrl}/internal/recovery/plan`;
        const headers = {
          'x-internal-service-token': config.genaiInternalToken,
        };
        injectTraceContext(headers);

        const response = await axios.post(endpoint, payload, { timeout: timeoutMs, headers });
        const latencyMs = Date.now() - startTime;

        const data = response.data;

        // 3. Strict Machine Validation of Agent 2 Response
        const validated = RecoveryExecutorClient.validateResponse(data);
        if (validated.isValid) {
          const result = {
            agentName: validated.data.metadata?.agentName || 'RecoveryExecutor',
            agentVersion: validated.data.metadata?.agentVersion || 'v1.0',
            proposedAction: validated.data.proposedAction,
            action: validated.data.proposedAction, // Alias
            confidence: validated.data.confidence,
            reasonCodes: validated.data.reasonCodes || [],
            rationale: validated.data.rationale,
            reasoning: validated.data.rationale, // Alias
            parameters: validated.data.parameters || {},
            toolParams: validated.data.parameters || {}, // Alias
            isFallback: false,
            latencyMs,
          };

          span.setAttribute('agent.proposed_action', result.proposedAction);
          span.setAttribute('agent.version', result.agentVersion);
          span.setAttribute('agent.is_fallback', false);

          metrics.recordAgentInvocation('executor', false, latencyMs / 1000);

          // Observability Log
          executorLogger.info('agent2_completed', {
            agent: 'RecoveryExecutor',
            agentVersion: result.agentVersion,
            transactionId: transaction.id,
            proposedAction: result.proposedAction,
            confidence: result.confidence,
            durationMs: latencyMs,
            isFallback: false,
          });

          return result;
        }

        metrics.recordAgentFailure('executor', 'validation_error');
        executorLogger.warn('agent2_validation_failed', {
          transactionId: transaction.id,
          error: validated.error,
        });
      } catch (err) {
        const errorType = classifyError(err);
        metrics.recordAgentFailure('executor', errorType);
        executorLogger.warn('agent2_request_failed', {
          transactionId: transaction.id,
          error: err.message,
          errorType,
        });
      }

      // 4. Safe Deterministic Fallback
      const latencyMs = Date.now() - startTime;
      metrics.recordAgentInvocation('executor', true, latencyMs / 1000);
      const fallback = RecoveryExecutorClient.deterministicFallback({
        transaction,
        agent1Recommendation,
      });
      fallback.latencyMs = latencyMs;

      span.setAttribute('agent.proposed_action', fallback.proposedAction);
      span.setAttribute('agent.version', fallback.agentVersion);
      span.setAttribute('agent.is_fallback', true);

      executorLogger.warn('agent2_fallback_used', {
        agent: 'RecoveryExecutor',
        transactionId: transaction.id,
        proposedAction: fallback.proposedAction,
        confidence: fallback.confidence,
        durationMs: latencyMs,
        isFallback: true,
      });

      return fallback;
    });
  }


  /**
   * Validates structure, types, allowed action enums, and parameter shapes
   */
  static validateResponse(data) {
    if (!data || typeof data !== 'object') {
      return { isValid: false, error: 'Response body is not an object' };
    }

    const action = data.proposedAction || data.action;
    if (!action || typeof action !== 'string' || !SUPPORTED_ACTIONS.includes(action)) {
      return { isValid: false, error: `Invalid or unsupported proposedAction: ${action}` };
    }

    const conf = typeof data.confidence === 'number' ? data.confidence : parseFloat(data.confidence);
    if (isNaN(conf) || conf < 0.0 || conf > 1.0) {
      return { isValid: false, error: `Confidence out of bounds [0, 1]: ${data.confidence}` };
    }

    const rationale = data.rationale || data.reasoning;
    if (!rationale || typeof rationale !== 'string' || rationale.trim().length === 0) {
      return { isValid: false, error: 'Rationale explanation missing or empty' };
    }

    const rawParams = data.parameters || data.toolParams || {};
    if (typeof rawParams !== 'object' || Array.isArray(rawParams)) {
      return { isValid: false, error: 'Parameters must be an object' };
    }

    // Sanitize parameters according to action type
    const sanitizedParams = RecoveryExecutorClient.sanitizeParameters(action, rawParams);

    return {
      isValid: true,
      data: {
        ...data,
        proposedAction: action,
        confidence: conf,
        rationale: rationale.trim(),
        reasonCodes: Array.isArray(data.reasonCodes) ? data.reasonCodes : [],
        parameters: sanitizedParams,
      },
    };
  }

  /**
   * Sanitizes parameters ensuring no arbitrary keys or unauthorized commands pass through
   */
  static sanitizeParameters(action, params) {
    const safe = {};
    if (action === 'attempt_recovery') {
      if (params.paymentId) safe.paymentId = String(params.paymentId);
      if (params.reason) safe.reason = String(params.reason);
      safe.retryDelayMinutes = Number.isInteger(params.retryDelayMinutes) ? params.retryDelayMinutes : 0;
    } else if (action === 'send_recovery_message') {
      safe.channel = ['email', 'sms', 'whatsapp'].includes(params.channel) ? params.channel : 'email';
      if (params.templateId) safe.templateId = String(params.templateId);
      if (params.customMessage) safe.customMessage = String(params.customMessage).substring(0, 500);
    } else if (action === 'schedule_retry') {
      safe.delayHours = Number.isInteger(params.delayHours) && params.delayHours > 0 ? params.delayHours : 4;
      safe.retryDelayMinutes = Number.isInteger(params.retryDelayMinutes) && params.retryDelayMinutes > 0 ? params.retryDelayMinutes : safe.delayHours * 60;
      if (params.reason) safe.reason = String(params.reason);
    } else if (action === 'escalate_to_human') {
      safe.priority = ['low', 'medium', 'high', 'urgent'].includes(params.priority) ? params.priority : 'urgent';
      safe.reason = params.reason ? String(params.reason) : 'Automated escalation';
      safe.channel = 'internal_escalation';
    } else if (action === 'log_outcome') {
      safe.reason = params.reason ? String(params.reason) : 'Outcome logged';
      safe.category = params.category ? String(params.category) : 'unrecoverable';
    }
    return safe;
  }

  /**
   * Safe deterministic fallback when Agent 2 is unreachable
   */
  static deterministicFallback({ transaction, agent1Recommendation }) {
    const reason = transaction.failureReason;
    const a1Action = agent1Recommendation?.recommendation || agent1Recommendation?.action;

    // Safety Invariant 1: Expired card direct retry overrule
    if (reason === 'card_expired') {
      return {
        agentName: 'RecoveryExecutor',
        agentVersion: 'v1.0-fallback',
        proposedAction: 'send_recovery_message',
        action: 'send_recovery_message',
        confidence: 0.95,
        reasonCodes: ['CARD_EXPIRED_FALLBACK', 'SELF_SERVICE_REQUIRED'],
        rationale: 'Card expired; formulated self-service payment update message.',
        reasoning: 'Card expired; formulated self-service payment update message.',
        parameters: {
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

    // Safety Invariant 2: Fraud cases
    if (reason === 'high_risk_fraud') {
      return {
        agentName: 'RecoveryExecutor',
        agentVersion: 'v1.0-fallback',
        proposedAction: 'escalate_to_human',
        action: 'escalate_to_human',
        confidence: 0.98,
        reasonCodes: ['HIGH_RISK_FRAUD_FLAGGED', 'SECURITY_ESCALATION'],
        rationale: 'High-risk fraud detected. Action plan: escalate immediately to risk operations.',
        reasoning: 'High-risk fraud detected. Action plan: escalate immediately to risk operations.',
        parameters: { priority: 'urgent', reason: 'Flagged for high-risk fraud activity.', channel: 'internal_escalation' },
        toolParams: { priority: 'urgent', reason: 'Flagged for high-risk fraud activity.', channel: 'internal_escalation' },
        isFallback: true,
      };
    }

    // Safety Invariant 3: Confirm supported Agent 1 action
    if (a1Action && SUPPORTED_ACTIONS.includes(a1Action)) {
      const safeParams = RecoveryExecutorClient.sanitizeParameters(
        a1Action,
        agent1Recommendation.suggestedParameters || agent1Recommendation.toolParams || {}
      );

      return {
        agentName: 'RecoveryExecutor',
        agentVersion: 'v1.0-fallback',
        proposedAction: a1Action,
        action: a1Action,
        confidence: agent1Recommendation.confidence || 0.80,
        reasonCodes: agent1Recommendation.reasonCodes || ['AGENT1_ACTION_CONFIRMED'],
        rationale: `Executor confirmed Agent 1 recommendation: ${agent1Recommendation.rationale || agent1Recommendation.reasoning || a1Action}`,
        reasoning: `Executor confirmed Agent 1 recommendation: ${agent1Recommendation.rationale || agent1Recommendation.reasoning || a1Action}`,
        parameters: safeParams,
        toolParams: safeParams,
        isFallback: true,
      };
    }

    // Default fallback
    return {
      agentName: 'RecoveryExecutor',
      agentVersion: 'v1.0-fallback',
      proposedAction: 'send_recovery_message',
      action: 'send_recovery_message',
      confidence: 0.70,
      reasonCodes: ['DEFAULT_ACTION_FALLBACK'],
      rationale: 'Default fallback action plan routing customer to recovery link.',
      reasoning: 'Default fallback action plan routing customer to recovery link.',
      parameters: { channel: 'email' },
      toolParams: { channel: 'email' },
      isFallback: true,
    };
  }
}
