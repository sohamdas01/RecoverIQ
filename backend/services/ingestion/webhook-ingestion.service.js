import { findOrCreateCustomer } from '../../db/queries/customers.queries.js';
import { createTransaction, getTransactionById, getCustomerStats } from '../../db/queries/transactions.queries.js';
import { RecoveryOrchestrator } from '../recovery/index.js';
import { RecoveryAnalystClient } from '../agents/recovery-analyst.client.js';
import { RecoveryExecutorClient } from '../agents/recovery-executor.client.js';
import { getMLPrediction } from '../ml/index.js';

export class IngestionService {
  /**
   * Main entry point for processing a failed transaction event directly via Webhook Ingestion
   */
  static async processFailedPayment(event) {
    console.log(`[Ingestion] Ingesting failed payment for ${event.customer?.email || 'unknown'} (Amount: ${event.currency || 'INR'} ${event.amount}, Reason: ${event.failureReason})`);

    // 1. Ensure Customer exists
    const customer = await findOrCreateCustomer({
      name: event.customer?.name || 'Unknown Customer',
      email: event.customer?.email || `customer_${Date.now()}@example.com`,
      phone: event.customer?.phone,
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

    // 4. Delegate to RecoveryOrchestrator (ML -> Agent 1 -> Agent 2 -> Policy Engine -> Execution Gate -> Decision DB)
    const orchestration = await RecoveryOrchestrator.orchestrateRecovery({
      transaction,
      customer,
      customerStats,
    });

    const updatedTx = await getTransactionById(transaction.id);

    return {
      success: true,
      transaction: updatedTx?.transaction || transaction,
      customer,
      decision: orchestration.decision,
      guardrail: orchestration.policyResult,
      policyResult: orchestration.policyResult,
      executionResult: orchestration.executionResult,
    };
  }

  /**
   * Request recovery probability and SHAP reason codes from ML Service
   */
  static async getMLPrediction(payload) {
    return getMLPrediction(payload);
  }

  /**
   * Request structured recovery analysis from Agent 1 (Recovery Analyst)
   */
  static async getAgent1Recommendation({ transaction, customer, customerStats, mlPrediction }) {
    return RecoveryAnalystClient.analyze({
      transaction,
      customer,
      customerStats,
      mlPrediction,
    });
  }

  /**
   * Request structured Action Plan proposal from Agent 2 (Recovery Executor)
   */
  static async getAgent2ActionPlan({ transaction, customer, customerStats, mlPrediction, agent1Recommendation }) {
    return RecoveryExecutorClient.plan({
      transaction,
      customer,
      customerStats,
      mlPrediction,
      agent1Recommendation,
    });
  }

  /**
   * Request decision from Agent 1 with robust fallback (backwards compatibility)
   */
  static async getAgentRecommendation(txPayload) {
    return RecoveryAnalystClient.analyze({
      transaction: {
        id: txPayload.transactionId,
        amount: txPayload.amount,
        currency: txPayload.currency || 'INR',
        paymentMethod: txPayload.paymentMethod,
        failureReason: txPayload.failureReason,
        attemptCount: txPayload.attemptCount || 1,
      },
      customer: {
        name: txPayload.customerName,
        email: txPayload.customerEmail,
      },
      customerStats: {},
      mlPrediction: txPayload.mlScore !== undefined ? {
        probability: txPayload.mlScore,
        reason_codes: txPayload.mlReasonCodes || [],
      } : null,
    });
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
