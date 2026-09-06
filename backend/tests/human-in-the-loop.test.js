import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import express from 'express';
import { AuthService } from '../services/auth/auth.service.js';
import { ReviewService, REVIEW_STATUSES } from '../services/review/index.js';
import { RecoveryOrchestrator } from '../services/recovery/index.js';
import { evaluatePolicy, POLICY_DECISIONS, RULE_IDS } from '../services/policy/index.js';
import { findOrCreateCustomer } from '../db/queries/customers.queries.js';
import { createTransaction, getTransactionById, updateTransactionStatus } from '../db/queries/transactions.queries.js';
import { createDecision, getDecisionById } from '../db/queries/decisions.queries.js';
import { getOverridesByDecisionId } from '../db/queries/overrides.queries.js';
import { getActionsByDecisionId } from '../db/queries/actions.queries.js';
import { closeDatabasePool } from '../db/index.js';
import { disconnectRedis } from '../redis/redis.client.js';
import { disconnectKafka } from '../kafka/kafka.client.js';
import { stopRecoveryConsumer } from '../kafka/consumers/recovery.consumer.js';
import { stopOutcomeConsumer } from '../kafka/consumers/outcome.consumer.js';
import recoveryCasesRoutes from '../api/routes/recovery-cases.routes.js';
import axios from 'axios';

describe('Phase 5 - Step 5: Human-in-the-Loop Approval Workflow Tests', () => {
  let app;
  let server;
  let BASE_URL;
  let merchantToken;
  let adminToken;

  before(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/admin/recovery-cases', recoveryCasesRoutes);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        BASE_URL = `http://localhost:${port}`;
        resolve();
      });
    });

    merchantToken = AuthService.generateMerchantToken('merchant_test_123', 'merchant');
    adminToken = AuthService.generateMerchantToken('admin_ops_999', 'admin');
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await stopRecoveryConsumer();
    await stopOutcomeConsumer();
    await disconnectKafka();
    await disconnectRedis();
    await closeDatabasePool();
  });

  // -------------------------------------------------------------
  // A. Pending Review Creation
  // -------------------------------------------------------------
  describe('A. Pending Review Creation & Context Persistence', () => {
    it('1. REQUIRE_APPROVAL creates pending review record with no tool execution', async () => {
      const customer = await findOrCreateCustomer({
        name: 'High Value Merchant Case',
        email: `highval.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 75000.00, // Exceeds auto-approval limit (₹50,000)
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const result = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      assert.strictEqual(result.policyResult.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
      assert.strictEqual(result.decision.status, 'pending_review');
      assert.strictEqual(result.executionResult, null, 'Tool must NOT be executed for pending review');

      const caseDetails = await ReviewService.getCaseForReview(result.decision.id);
      assert.ok(caseDetails, 'Review record must be retrievable');
      assert.strictEqual(caseDetails.reviewStatus, REVIEW_STATUSES.PENDING_REVIEW);
      assert.strictEqual(caseDetails.policyDecision, 'REQUIRE_APPROVAL');
      assert.ok(caseDetails.agent1, 'Agent 1 recommendation must be preserved');
      assert.ok(caseDetails.agent2, 'Agent 2 proposal must be preserved');
      assert.ok(caseDetails.proposedParameters, 'Proposed parameters must be stored');
      assert.ok(Array.isArray(caseDetails.ruleIds), 'Triggered rule IDs must be preserved');
    });
  });

  // -------------------------------------------------------------
  // B. Approve Workflow
  // -------------------------------------------------------------
  describe('B. Approve Workflow & Fresh Policy Re-Evaluation', () => {
    it('2. Valid APPROVE: Re-evaluates policy fresh -> ALLOW -> Executes Tool -> Outcome Recovered', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Approve Test Customer',
        email: `approve.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 65000.00, // High-value requiring approval
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
        options: {
          agent2Proposal: {
            agentName: 'RecoveryExecutor',
            agentVersion: 'v1.0',
            proposedAction: 'attempt_recovery',
            parameters: {},
            confidence: 0.95,
            rationale: 'High confidence retry requiring human approval',
            reasonCodes: ['HIGH_VALUE'],
          },
        },
      });

      assert.strictEqual(orchResult.decision.status, 'pending_review');

      // Human Merchant APPROVES via ReviewService
      const approveResult = await ReviewService.approveCase(orchResult.decision.id, {
        reviewerId: 'merchant_finance_lead',
        reasoning: 'Verified customer relationship and approved high-value automated retry',
      });

      assert.strictEqual(approveResult.success, true);
      assert.strictEqual(approveResult.reviewStatus, REVIEW_STATUSES.APPROVED);
      assert.strictEqual(approveResult.policyDecision, POLICY_DECISIONS.ALLOW);
      assert.strictEqual(approveResult.execution.executed, true);
      assert.strictEqual(approveResult.execution.action, 'attempt_recovery');
      assert.strictEqual(approveResult.execution.success, true);

      // Verify DB State
      const updatedDecision = await getDecisionById(orchResult.decision.id);
      assert.strictEqual(updatedDecision.decision.status, 'executed');

      // Verify Audit Lineage
      const humanReview = updatedDecision.decision.agentAnalystResponse.humanReview;
      assert.ok(humanReview, 'Human review audit object must be recorded');
      assert.strictEqual(humanReview.reviewerId, 'merchant_finance_lead');
      assert.strictEqual(humanReview.reviewAction, 'APPROVE');
      assert.strictEqual(humanReview.policyBefore, 'REQUIRE_APPROVAL');
      assert.strictEqual(humanReview.policyAfter, 'ALLOW');
      assert.ok(humanReview.executionResult.success);

      // Verify Overrides table
      const overrides = await getOverridesByDecisionId(orchResult.decision.id);
      assert.ok(overrides.length > 0);
      assert.strictEqual(overrides[0].merchantAction, 'APPROVE');
    });

    it('3. APPROVE on transaction that became already RECOVERED -> Policy returns BLOCK -> Tool NOT executed', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Already Recovered User',
        email: `already_rec.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 55000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      // Simulate transaction being marked recovered externally before merchant review
      await updateTransactionStatus(transaction.id, 'recovered');

      // Merchant tries to approve
      await assert.rejects(
        async () => {
          await ReviewService.approveCase(orchResult.decision.id, {
            reviewerId: 'admin_ops',
            reasoning: 'Late approval',
          });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, 'TERMINAL_TRANSACTION_STATE');
          return true;
        }
      );
    });

    it('4. APPROVE on transaction with high-risk FRAUD -> Policy engine strictly BLOCKS', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Fraud Approval Attempt',
        email: `fraud_app.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 25000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'high_risk_fraud',
        attemptCount: 1,
      });

      // Create a manual decision in pending_review
      const decision = await createDecision({
        transactionId: transaction.id,
        recommendedAction: 'attempt_recovery',
        guardrailResult: 'REQUIRE_APPROVAL',
        reasoning: 'Held for review',
        status: 'pending_review',
        agentAnalystResponse: {
          agent2: { proposedAction: 'attempt_recovery', parameters: {} },
        },
      });

      const approveResult = await ReviewService.approveCase(decision.id, {
        reviewerId: 'admin_ops',
        reasoning: 'Attempted override on fraud',
      });

      // Policy Engine must strictly return BLOCK and refuse execution
      assert.strictEqual(approveResult.policyDecision, POLICY_DECISIONS.BLOCK);
      assert.strictEqual(approveResult.execution.executed, false);
      assert.strictEqual(approveResult.reviewStatus, 'BLOCKED');

      const saved = await getDecisionById(decision.id);
      assert.strictEqual(saved.decision.status, 'blocked');
    });
  });

  // -------------------------------------------------------------
  // C. Modify Workflow
  // -------------------------------------------------------------
  describe('C. Modify Workflow & Parameter Validation', () => {
    it('5. Valid MODIFY: Changes parameters -> Policy ALLOW -> Executes modified Tool', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Modify Test Customer',
        email: `modify.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 60000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
        options: {
          agent2Proposal: {
            agentName: 'RecoveryExecutor',
            agentVersion: 'v1.0',
            proposedAction: 'attempt_recovery',
            parameters: {},
            confidence: 0.85,
            rationale: 'Direct retry proposal',
          },
        },
      });

      // Merchant modifies action to send_recovery_message with custom SMS message
      const modifyResult = await ReviewService.modifyCase(orchResult.decision.id, {
        reviewerId: 'merchant_cx_lead',
        modifiedAction: 'send_recovery_message',
        modifiedParams: {
          channel: 'sms',
          templateId: 'payment_failed_vip_v1',
          customMessage: 'Special VIP link to complete your transaction with 5% discount applied',
        },
        reasoning: 'Switching from immediate retry to personalized SMS recovery link',
      });

      assert.strictEqual(modifyResult.success, true);
      assert.strictEqual(modifyResult.reviewStatus, REVIEW_STATUSES.MODIFIED);
      assert.strictEqual(modifyResult.policyDecision, POLICY_DECISIONS.ALLOW);
      assert.strictEqual(modifyResult.execution.executed, true);
      assert.strictEqual(modifyResult.execution.action, 'send_recovery_message');
      assert.strictEqual(modifyResult.execution.success, true);

      // Verify DB State
      const updated = await getDecisionById(orchResult.decision.id);
      assert.strictEqual(updated.decision.status, 'modified');
      assert.strictEqual(updated.decision.finalAction, 'send_recovery_message');

      const humanReview = updated.decision.agentAnalystResponse.humanReview;
      assert.strictEqual(humanReview.reviewAction, 'MODIFY');
      assert.strictEqual(humanReview.previousAction, 'attempt_recovery');
      assert.strictEqual(humanReview.modifiedAction, 'send_recovery_message');
      assert.strictEqual(humanReview.modifiedParams.channel, 'sms');
    });

    it('6. Invalid Parameter / Channel in MODIFY is rejected', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Invalid Modify Customer',
        email: `inv_modify.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 52000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      await assert.rejects(
        async () => {
          await ReviewService.modifyCase(orchResult.decision.id, {
            reviewerId: 'merchant_admin',
            modifiedAction: 'send_recovery_message',
            modifiedParams: {
              channel: 'invalid_carrier_pigeon', // Invalid channel
            },
          });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, 'INVALID_PARAMETER');
          return true;
        }
      );
    });

    it('7. Forbidden parameter injection (e.g. amount override) is stripped during MODIFY', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Injection Test Customer',
        email: `inj_modify.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 55000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      const modifyResult = await ReviewService.modifyCase(orchResult.decision.id, {
        reviewerId: 'security_auditor',
        modifiedAction: 'send_recovery_message',
        modifiedParams: {
          channel: 'email',
          templateId: 'standard_v1',
          amount: 1.00, // Forbidden attempt to rewrite transaction amount
          transactionId: 'malicious_txn_id',
          bypassSecurity: true,
        },
        reasoning: 'Testing parameter strip',
      });

      assert.strictEqual(modifyResult.success, true);
      const updated = await getDecisionById(orchResult.decision.id);
      const modifiedParams = updated.decision.agentAnalystResponse.humanReview.modifiedParams;
      assert.strictEqual(modifiedParams.amount, undefined, 'Forbidden amount must be stripped');
      assert.strictEqual(modifiedParams.transactionId, undefined, 'Forbidden transactionId must be stripped');
      assert.strictEqual(modifiedParams.bypassSecurity, undefined, 'Forbidden security flag must be stripped');
    });
  });

  // -------------------------------------------------------------
  // D. Reject Workflow
  // -------------------------------------------------------------
  describe('D. Reject Workflow', () => {
    it('8. REJECT: Persists rejection, creates audit, and never executes recovery tool', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Reject Test Customer',
        email: `reject.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 80000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      const rejectResult = await ReviewService.rejectCase(orchResult.decision.id, {
        reviewerId: 'risk_officer_1',
        reasoning: 'Customer account flagged for manual fraud investigation. Automated recovery declined.',
      });

      assert.strictEqual(rejectResult.success, true);
      assert.strictEqual(rejectResult.reviewStatus, REVIEW_STATUSES.REJECTED);
      assert.strictEqual(rejectResult.execution.executed, false);

      // Verify DB State
      const updated = await getDecisionById(orchResult.decision.id);
      assert.strictEqual(updated.decision.status, 'rejected');

      const humanReview = updated.decision.agentAnalystResponse.humanReview;
      assert.strictEqual(humanReview.reviewAction, 'REJECT');
      assert.strictEqual(humanReview.reviewerId, 'risk_officer_1');
      assert.ok(humanReview.reasoning.includes('manual fraud investigation'));

      // Verify no action was executed
      const actions = await getActionsByDecisionId(orchResult.decision.id);
      assert.strictEqual(actions.length, 0, 'No action records must be created for rejection');
    });
  });

  // -------------------------------------------------------------
  // E. Authentication & Authorization
  // -------------------------------------------------------------
  describe('E. Authentication & API Endpoints', () => {
    it('9. GET /api/admin/recovery-cases/:caseId/review rejects unauthenticated requests with 401', async () => {
      const res = await axios.get(`${BASE_URL}/api/admin/recovery-cases/fake-id/review`, {
        validateStatus: () => true,
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.data.success, false);
    });

    it('10. GET /api/admin/recovery-cases/:caseId/review returns structured review data with valid JWT', async () => {
      const customer = await findOrCreateCustomer({
        name: 'API Review Customer',
        email: `apireview.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 70000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      const res = await axios.get(`${BASE_URL}/api/admin/recovery-cases/${orchResult.decision.id}/review`, {
        headers: { Authorization: `Bearer ${merchantToken}` },
        validateStatus: () => true,
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(res.data.data.caseId, orchResult.decision.id);
      assert.strictEqual(res.data.data.reviewStatus, 'PENDING_REVIEW');
      assert.strictEqual(res.data.data.transaction.amount, 70000);
    });

    it('11. POST /api/admin/recovery-cases/:caseId/approve executes via HTTP API with JWT auth', async () => {
      const customer = await findOrCreateCustomer({
        name: 'API Approve Customer',
        email: `apiapprove.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 60000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      const res = await axios.post(
        `${BASE_URL}/api/admin/recovery-cases/${orchResult.decision.id}/approve`,
        { reasoning: 'Approved via Merchant Admin API Dashboard' },
        {
          headers: { Authorization: `Bearer ${adminToken}` },
          validateStatus: () => true,
        }
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(res.data.reviewStatus, 'APPROVED');
      assert.strictEqual(res.data.policyDecision, 'ALLOW');
      assert.strictEqual(res.data.execution.executed, true);
    });
  });

  // -------------------------------------------------------------
  // F. State Machine Protections
  // -------------------------------------------------------------
  describe('F. State Machine & Transition Protections', () => {
    it('12. Double APPROVE is rejected with 400', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Double Approve User',
        email: `double_app.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 55000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({ transaction, customer });

      // First approve succeeds
      const first = await ReviewService.approveCase(orchResult.decision.id);
      assert.strictEqual(first.success, true);

      // Second approve fails
      await assert.rejects(
        async () => {
          await ReviewService.approveCase(orchResult.decision.id);
        },
        (err) => {
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, 'INVALID_CASE_STATUS');
          return true;
        }
      );
    });

    it('13. APPROVE after REJECT is rejected with 400', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Approve After Reject User',
        email: `app_after_rej.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 55000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({ transaction, customer });

      // Reject first
      await ReviewService.rejectCase(orchResult.decision.id);

      // Attempt approve
      await assert.rejects(
        async () => {
          await ReviewService.approveCase(orchResult.decision.id);
        },
        (err) => {
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, 'INVALID_CASE_STATUS');
          return true;
        }
      );
    });

    it('14. MODIFY after EXECUTION is rejected with 400', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Modify After Exec User',
        email: `mod_after_exec.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 55000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({ transaction, customer });
      await ReviewService.approveCase(orchResult.decision.id);

      // Attempt modify after execution
      await assert.rejects(
        async () => {
          await ReviewService.modifyCase(orchResult.decision.id, {
            modifiedAction: 'send_recovery_message',
          });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.code, 'INVALID_CASE_STATUS');
          return true;
        }
      );
    });
  });

  // -------------------------------------------------------------
  // G. Concurrency & Race Condition Handling
  // -------------------------------------------------------------
  describe('G. Concurrency & Race Condition Protections', () => {
    it('15. Concurrent simultaneous APPROVE requests: exactly 1 succeeds, 1 is rejected', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Concurrent Approve Customer',
        email: `concurrent_app.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 65000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({ transaction, customer });

      const results = await Promise.allSettled([
        ReviewService.approveCase(orchResult.decision.id, { reviewerId: 'reviewer_A' }),
        ReviewService.approveCase(orchResult.decision.id, { reviewerId: 'reviewer_B' }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent approval must succeed');
      assert.strictEqual(rejected.length, 1, 'The other concurrent request must be rejected');
    });

    it('16. APPROVE vs REJECT race: exactly 1 terminal state wins', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Approve Reject Race Customer',
        email: `race_app_rej.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 65000.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const orchResult = await RecoveryOrchestrator.orchestrateRecovery({ transaction, customer });

      const results = await Promise.allSettled([
        ReviewService.approveCase(orchResult.decision.id, { reviewerId: 'approver' }),
        ReviewService.rejectCase(orchResult.decision.id, { reviewerId: 'rejecter' }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 1, 'Exactly one review action must succeed in a race');
      assert.strictEqual(rejected.length, 1, 'The competing action must fail');
    });
  });
});
