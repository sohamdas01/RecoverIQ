import axios from 'axios';
import { findOrCreateCustomer } from '../../db/queries/customers.queries.js';
import { createTransaction, getTransactionById } from '../../db/queries/transactions.queries.js';
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

    // 3. Consult Agent Decision Layer
    const recommendation = await IngestionService.getAgentRecommendation({
      transactionId: transaction.id,
      customerName: customer.name,
      customerEmail: customer.email,
      amount: parseFloat(transaction.amount),
      currency: transaction.currency,
      paymentMethod: transaction.paymentMethod,
      failureReason: transaction.failureReason,
      attemptCount: transaction.attemptCount,
    });

    // 4. Evaluate Guardrail & Policy Engine (Rule 3: Backend owns security/guardrails)
    const guardrailCheck = GuardrailService.evaluate({
      transactionId: transaction.id,
      amount: parseFloat(transaction.amount),
      currency: transaction.currency,
      status: transaction.status,
      failureReason: transaction.failureReason,
      attemptCount: transaction.attemptCount,
      recommendedAction: recommendation.action,
      toolParams: recommendation.toolParams,
      mlScore: recommendation.mlScore,
    });

    console.log(`[Guardrail] Result for ${transaction.id}: ${guardrailCheck.decision} — ${guardrailCheck.reason}`);

    // 5. Persist Decision
    const decision = await createDecision({
      transactionId: transaction.id,
      agentAnalystResponse: {
        confidence: recommendation.confidence,
        rawReasoning: recommendation.reasoning,
        suggestedTool: recommendation.action,
        toolParams: recommendation.toolParams,
        appliedRules: guardrailCheck.appliedRules,
        playbookStrategy: recommendation.playbookStrategy || null,
      },
      mlScore: recommendation.mlScore || 0.75,
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
