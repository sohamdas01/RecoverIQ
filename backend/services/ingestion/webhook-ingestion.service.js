import axios from 'axios';
import { findOrCreateCustomer } from '../../db/queries/customers.queries.js';
import { createTransaction, getTransactionById, getCustomerStats } from '../../db/queries/transactions.queries.js';
import { createDecision } from '../../db/queries/decisions.queries.js';
import { createAction, updateActionResult } from '../../db/queries/actions.queries.js';
import { GuardrailService } from '../guardrail/guardrail.service.js';
import { executeTool } from '../tools/index.js';
import { config } from '../config/index.js';

export class IngestionService {
  /**
   * Main entry point for processing a failed transaction event
   */
  static async processFailedPayment(event) {
    console.log(`[Ingestion] Ingesting failed payment for ${event.customer.email} (Amount: ${event.currency} ${event.amount}, Reason: ${event.failureReason})`);

    // 1. Ensure Customer exists
    const customer = await findOrCreateCustomer({
      name: event.customer.name,
      email: event.customer.email,
      phone: event.customer.phone,
    });

    // 2. Record Failed Transaction
    const transaction = await createTransaction({
      customerId: customer.id,
      amount: event.amount,
      currency: event.currency || 'INR',
      paymentMethod: event.paymentMethod,
      status: 'failed',
      failureReason: event.failureReason,
      attemptCount: event.attemptCount || 1,
      metadata: event.metadata || {},
    });

    // 3. Extract Customer Historical Profile
    const customerStats = await getCustomerStats(customer.id);

    // 4. Request ML Recovery Probability & SHAP Explainability from ML Service
    const mlPrediction = await IngestionService.getMLPrediction({
      amount: parseFloat(transaction.amount),
      payment_method: transaction.paymentMethod,
      failure_reason: transaction.failureReason,
      attempt_count: transaction.attemptCount,
      days_since_failure: 0.0,
      day_of_month: new Date().getDate(),
      hour_of_day: new Date().getHours(),
      previous_successes: customerStats.previousSuccesses,
      previous_failures: customerStats.previousFailures,
      previous_recovery_success: customerStats.previousRecoverySuccess,
      is_subscription: transaction.paymentMethod === 'subscription_mandate',
    });

    console.log(`[ML Service] Recovery Probability: ${(mlPrediction.probability * 100).toFixed(1)}% | Reasons: [${mlPrediction.reason_codes.join(', ')}]`);

    // 5. Consult Agent Decision Layer (Pass ML Score and Grounded Reasons)
    const recommendation = await IngestionService.getAgentRecommendation({
      transactionId: transaction.id,
      customerName: customer.name,
      customerEmail: customer.email,
      amount: parseFloat(transaction.amount),
      currency: transaction.currency,
      paymentMethod: transaction.paymentMethod,
      failureReason: transaction.failureReason,
      attemptCount: transaction.attemptCount,
      mlScore: mlPrediction.probability,
      mlReasonCodes: mlPrediction.reason_codes,
    });

    // 6. Evaluate Guardrail & Policy Engine (Rule 3: Backend owns security/guardrails)
    const guardrailCheck = GuardrailService.evaluate({
      transactionId: transaction.id,
      amount: parseFloat(transaction.amount),
      currency: transaction.currency,
      status: transaction.status,
      failureReason: transaction.failureReason,
      attemptCount: transaction.attemptCount,
      recommendedAction: recommendation.action,
      toolParams: recommendation.toolParams,
      mlScore: mlPrediction.probability,
    });

    console.log(`[Guardrail] Result for ${transaction.id}: ${guardrailCheck.decision} — ${guardrailCheck.reason}`);

    // 7. Persist Decision with ML Score & SHAP Metadata
    const decision = await createDecision({
      transactionId: transaction.id,
      agentAnalystResponse: {
        confidence: recommendation.confidence,
        rawReasoning: recommendation.reasoning,
        suggestedTool: recommendation.action,
        toolParams: recommendation.toolParams,
        appliedRules: guardrailCheck.appliedRules,
        playbookStrategy: recommendation.playbookStrategy || null,
        mlReasonCodes: mlPrediction.reason_codes,
        mlModelVersion: mlPrediction.model_version,
        mlAttributions: mlPrediction.attributions || [],
      },
      mlScore: mlPrediction.probability,
      recommendedAction: recommendation.action,
      guardrailResult: guardrailCheck.decision,
      finalAction: guardrailCheck.decision === 'ALLOW' ? recommendation.action : undefined,
      reasoning: recommendation.reasoning + ` | Guardrail: ${guardrailCheck.reason}`,
      status: guardrailCheck.decision === 'ALLOW' ? 'executed' : guardrailCheck.decision === 'REQUIRE_APPROVAL' ? 'pending_review' : 'blocked',
    });


    // 6. Action Execution (if ALLOWed by Guardrails)
    let executionResult = null;
    if (guardrailCheck.decision === 'ALLOW') {
      const actionRecord = await createAction({
        decisionId: decision.id,
        toolName: recommendation.action,
        toolParams: {
          ...recommendation.toolParams,
          transactionId: transaction.id,
          amount: parseFloat(transaction.amount),
          currency: transaction.currency,
        },
        status: 'pending',
      });

      executionResult = await executeTool(recommendation.action, {
        ...recommendation.toolParams,
        transactionId: transaction.id,
        amount: parseFloat(transaction.amount),
        currency: transaction.currency,
      });

      await updateActionResult(
        actionRecord.id,
        executionResult.success ? 'success' : 'failed',
        executionResult.output || {}
      );
    }

    const updatedTx = await getTransactionById(transaction.id);

    return {
      success: true,
      transaction: updatedTx?.transaction || transaction,
      customer,
      decision,
      guardrail: guardrailCheck,
      executionResult,
    };
  }

  /**
   * Request recovery probability and SHAP reason codes from ML Service
   */
  static async getMLPrediction(payload) {
    try {
      const response = await axios.post(
        `${config.mlServiceUrl}/predict`,
        payload,
        { timeout: 3000 }
      );
      if (response.data && typeof response.data.probability === 'number') {
        return response.data;
      }
    } catch (err) {
      console.warn(`[Ingestion] ML service unreachable (${err.message}). Using built-in baseline probability heuristics.`);
    }

    // Heuristic ML fallback in case ML service is offline
    const reason = payload.failure_reason;
    let fallbackProb = 0.72;
    let fallbackReasons = ['baseline_heuristic_estimate'];

    if (reason === 'high_risk_fraud') {
      fallbackProb = 0.05;
      fallbackReasons = ['high_risk_fraud_flagged'];
    } else if (reason === 'card_expired') {
      fallbackProb = 0.45;
      fallbackReasons = ['hard_decline_expired_card'];
    } else if (reason === 'bank_outage' || reason === 'network_timeout') {
      fallbackProb = 0.88;
      fallbackReasons = ['transient_infrastructure_glitch'];
    } else if (payload.previous_successes > 5) {
      fallbackProb = 0.82;
      fallbackReasons = ['strong_payment_history'];
    }

    return {
      probability: fallbackProb,
      reason_codes: fallbackReasons,
      model_version: 'v1.0.0-fallback',
      attributions: [],
    };
  }

  /**
   * Request decision from GenAI Service with robust fallback
   */
  static async getAgentRecommendation(txPayload) {
    try {
      const response = await axios.post(
        `${config.genaiServiceUrl}/analyze`,
        txPayload,
        { timeout: 3500 }
      );
      if (response.data && response.data.action) {
        return response.data;
      }
    } catch (err) {
      console.warn(`[Ingestion] GenAI service unavailable (${err.message}). Using built-in Phase 1 decision heuristics.`);
    }

    return IngestionService.fallbackHeuristicDecision(txPayload);
  }

  /**
   * Deterministic decision logic for Phase 1 baseline
   */
  static fallbackHeuristicDecision(tx) {
    const reason = tx.failureReason;
    const attempts = tx.attemptCount || 1;

    if (reason === 'card_expired') {
      return {
        action: 'send_recovery_message',
        toolParams: {
          channel: 'email',
          templateId: 'card_expired_update_v1',
          customMessage: 'Your card on file has expired. Click below to update payment details securely.',
        },
        confidence: 0.95,
        reasoning: 'Card is expired; direct retries will fail. Sending a tokenized customer recovery link is the optimal recovery vector.',
        mlScore: 0.88,
      };
    }

    if (reason === 'insufficient_funds') {
      if (attempts >= 3) {
        return {
          action: 'send_recovery_message',
          toolParams: {
            channel: 'email',
            templateId: 'payment_failed_alternative_method',
          },
          confidence: 0.85,
          reasoning: 'Repeated insufficient funds failures. Customer message sent with alternative payment methods.',
          mlScore: 0.65,
        };
      }
      return {
        action: 'schedule_retry',
        toolParams: {
          delayHours: 6,
          reason: 'Schedule retry for standard banking settlement window',
        },
        confidence: 0.82,
        reasoning: 'Transient insufficient funds; scheduling retry for next banking clearing window.',
        mlScore: 0.72,
      };
    }

    if (reason === 'bank_outage' || reason === 'network_timeout') {
      return {
        action: 'attempt_recovery',
        toolParams: {
          paymentId: `pay_${Date.now()}`,
          reason: 'Gateway/bank network glitch recovered, retrying immediate capture',
        },
        confidence: 0.90,
        reasoning: 'Transient network/gateway error identified. Immediate retry has high probability of capture.',
        mlScore: 0.89,
      };
    }

    if (reason === 'high_risk_fraud') {
      return {
        action: 'escalate_to_human',
        toolParams: {
          priority: 'urgent',
          reason: 'Flagged for high-risk fraud activity.',
        },
        confidence: 0.98,
        reasoning: 'Fraud safety violation. Escalating immediately to risk operations team.',
        mlScore: 0.05,
      };
    }

    return {
      action: 'send_recovery_message',
      toolParams: { channel: 'email' },
      confidence: 0.75,
      reasoning: 'General failure reason; routing customer to self-serve checkout link.',
      mlScore: 0.70,
    };
  }
}
