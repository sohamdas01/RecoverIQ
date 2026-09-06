/**
 * RecoverIQ Decision Persistence, Audit & Observability Tests
 * Phase 5 - Step 6: Decision Persistence, Audit & Observability
 *
 * Verifies end-to-end traceability, agent separation, policy authority,
 * human review lineage, replay lineage, tool execution auditing, secret scrubbing,
 * and explanation reconstructability.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import express from 'express';
import axios from 'axios';
import { AuthService } from '../services/auth/auth.service.js';
import { ObservabilityService, AUDIT_EVENT_TYPES } from '../services/observability/index.js';
import { RecoveryOrchestrator } from '../services/recovery/index.js';
import { ReviewService, REVIEW_STATUSES } from '../services/review/index.js';
import { evaluatePolicy, POLICY_DECISIONS, RULE_IDS } from '../services/policy/index.js';
import { findOrCreateCustomer } from '../db/queries/customers.queries.js';
import { createTransaction, getTransactionById } from '../db/queries/transactions.queries.js';
import { createDecision, getDecisionById } from '../db/queries/decisions.queries.js';
import { getActionsByDecisionId } from '../db/queries/actions.queries.js';
import { getOverridesByDecisionId } from '../db/queries/overrides.queries.js';
import { getMessagesByTransactionId } from '../db/queries/messages.queries.js';
import { closeDatabasePool } from '../db/index.js';
import { disconnectRedis } from '../redis/redis.client.js';
import { disconnectKafka } from '../kafka/kafka.client.js';
import { stopRecoveryConsumer } from '../kafka/consumers/recovery.consumer.js';
import { stopOutcomeConsumer } from '../kafka/consumers/outcome.consumer.js';
import recoveryCasesRoutes from '../api/routes/recovery-cases.routes.js';

describe('Phase 5 - Step 6: Decision Persistence, Audit & Observability Tests', () => {
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

    merchantToken = AuthService.generateMerchantToken('merchant_obs_123', 'merchant');
    adminToken = AuthService.generateMerchantToken('admin_obs_999', 'admin');
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
  // A. Full Decision Lineage & Agent Separation
  // -------------------------------------------------------------
  describe('A. Full Decision Lineage & Agent Separation', () => {
    it('1. Persists complete lineage from event to ML, Agent 1, Agent 2, Policy, and Execution', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Audit Trace Customer',
        email: `trace.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 2500.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      });

      const eventId = `evt_audit_${crypto.randomUUID()}`;
      const result = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
        eventId,
      });

      assert.ok(result.decision);
      assert.strictEqual(result.policyResult.decision, POLICY_DECISIONS.ALLOW);

      // Verify Decision Record Structure
      const record = await getDecisionById(result.decision.id);
      assert.ok(record);
      const analystData = record.decision.agentAnalystResponse;
      assert.ok(analystData, 'agentAnalystResponse must be populated');

      // Lineage
      assert.ok(analystData.lineage, 'Lineage object must exist');
      assert.strictEqual(analystData.lineage.eventId, eventId);
      assert.strictEqual(analystData.lineage.transactionId, transaction.id);

      // ML Layer
      assert.ok(analystData.ml, 'ML sub-object must exist');
      assert.strictEqual(typeof analystData.ml.probability, 'number');
      assert.ok(Array.isArray(analystData.ml.reasonCodes));
      assert.ok(analystData.ml.predictedAt);

      // Agent 1 Layer
      assert.ok(analystData.agent1, 'Agent 1 sub-object must exist');
      assert.strictEqual(analystData.agent1.agentName, 'RecoveryAnalyst');
      assert.ok(analystData.agent1.recommendation);
      assert.strictEqual(typeof analystData.agent1.confidence, 'number');
      assert.ok(analystData.agent1.rationale);
      assert.ok(Array.isArray(analystData.agent1.reasonCodes));

      // Agent 2 Layer
      assert.ok(analystData.agent2, 'Agent 2 sub-object must exist');
      assert.strictEqual(analystData.agent2.agentName, 'RecoveryExecutor');
      assert.ok(analystData.agent2.proposedAction);
      assert.strictEqual(typeof analystData.agent2.confidence, 'number');
      assert.ok(analystData.agent2.parameters);

      // Policy Layer
      assert.ok(analystData.policy, 'Policy sub-object must exist');
      assert.strictEqual(analystData.policy.decision, POLICY_DECISIONS.ALLOW);
      assert.ok(Array.isArray(analystData.policy.appliedRules));
      assert.ok(analystData.policy.evaluatedAt);

      // Execution Layer in Actions Table
      const actions = await getActionsByDecisionId(result.decision.id);
      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].toolName, analystData.agent2.proposedAction);
      assert.strictEqual(actions[0].status, 'success');
    });

    it('2. Maintains strict separation between Agent 1 analysis and Agent 2 execution proposal', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Separation Customer',
        email: `sep.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 3200.00,
        currency: 'INR',
        paymentMethod: 'upi',
        status: 'failed',
        failureReason: 'temporary_network_failure',
        attemptCount: 1,
      });

      const result = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      const explanation = await ObservabilityService.getDecisionExplanation(result.decision.id);
      assert.ok(explanation);

      // Verify Agent 1 and Agent 2 objects are distinct
      assert.strictEqual(explanation.agent1.agentName, 'RecoveryAnalyst');
      assert.strictEqual(explanation.agent2.agentName, 'RecoveryExecutor');
      assert.ok(explanation.agent1.recommendation);
      assert.ok(explanation.agent2.proposedAction);
      assert.ok(explanation.agent2.parameters);
      assert.strictEqual(typeof explanation.agent1.confidence, 'number');
      assert.strictEqual(typeof explanation.agent2.confidence, 'number');
    });
  });

  // -------------------------------------------------------------
  // B. Policy Authority & Immutability Under Agent Recommendations
  // -------------------------------------------------------------
  describe('B. Policy Authority & Immutability Under Agent Recommendations', () => {
    it('1. High-value transactions force REQUIRE_APPROVAL despite Agent recommendation', async () => {
      const customer = await findOrCreateCustomer({
        name: 'High Amount Customer',
        email: `high.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 80000.00, // Exceeds auto-approval limit of ₹50,000
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

      // Policy must strictly override auto-execution
      assert.strictEqual(result.policyResult.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
      assert.strictEqual(result.decision.status, 'pending_review');
      assert.strictEqual(result.executionResult, null, 'Tool must NOT be executed');

      const explanation = await ObservabilityService.getDecisionExplanation(result.decision.id);
      assert.strictEqual(explanation.policy.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
      assert.ok(explanation.policy.appliedRules.includes(RULE_IDS.MAX_AMOUNT_CEILING));
      assert.strictEqual(explanation.status, 'pending_review');
    });

    it('2. Terminal transaction state forces BLOCK despite confident Agent recommendation', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Terminal State Customer',
        email: `term.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 1500.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'recovered', // Already recovered
        failureReason: 'initial_failure',
        attemptCount: 1,
      });

      const result = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      assert.strictEqual(result.policyResult.decision, POLICY_DECISIONS.BLOCK);
      assert.strictEqual(result.decision.status, 'blocked');
      assert.strictEqual(result.executionResult, null);

      const explanation = await ObservabilityService.getDecisionExplanation(result.decision.id);
      assert.strictEqual(explanation.policy.decision, POLICY_DECISIONS.BLOCK);
      assert.ok(explanation.policy.appliedRules.includes(RULE_IDS.TERMINAL_STATE_RECOVERED));
    });
  });

  // -------------------------------------------------------------
  // C. Human Review Lineage & Immutability
  // -------------------------------------------------------------
  describe('C. Human Review Lineage & Immutability', () => {
    it('1. APPROVE records reviewer, before/after policy decisions, and executes safely', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Review Approve Customer',
        email: `approve.${Date.now()}@example.com`,
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

      const orchestratorResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      const caseId = orchestratorResult.decision.id;

      // Approve case
      const approveRes = await axios.post(
        `${BASE_URL}/api/admin/recovery-cases/${caseId}/approve`,
        { reasoning: 'Approved by Senior Risk Lead' },
        { headers: { Authorization: `Bearer ${merchantToken}` } }
      );

      assert.strictEqual(approveRes.status, 200);
      assert.strictEqual(approveRes.data.success, true);
      assert.strictEqual(approveRes.data.reviewStatus, REVIEW_STATUSES.APPROVED);
      assert.strictEqual(approveRes.data.policyDecision, POLICY_DECISIONS.ALLOW);

      // Verify Explanation Reconstructability
      const explanation = await ObservabilityService.getDecisionExplanation(caseId);
      assert.ok(explanation.humanReview, 'humanReview object must be present');
      assert.strictEqual(explanation.humanReview.reviewAction, 'APPROVE');
      assert.strictEqual(explanation.humanReview.reviewerId, 'merchant_obs_123');
      assert.strictEqual(explanation.humanReview.policyBefore, 'REQUIRE_APPROVAL');
      assert.strictEqual(explanation.humanReview.policyAfter, 'ALLOW');
      assert.strictEqual(explanation.humanReview.ruleIdAfter, RULE_IDS.POLICY_CLEAR);
      assert.ok(explanation.humanReview.executionResult.success);

      // Historical Agent 1 & Agent 2 outputs must remain intact
      assert.ok(explanation.agent1.recommendation);
      assert.ok(explanation.agent2.proposedAction);
      assert.strictEqual(explanation.overrides.length, 1);
    });

    it('2. MODIFY records previous vs modified parameters, fresh policy, and tool execution', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Review Modify Customer',
        email: `modify.${Date.now()}@example.com`,
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

      const orchestratorResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      const caseId = orchestratorResult.decision.id;

      // Modify case to send_recovery_message with email channel
      const modifyRes = await axios.post(
        `${BASE_URL}/api/admin/recovery-cases/${caseId}/modify`,
        {
          modifiedAction: 'send_recovery_message',
          modifiedParams: {
            channel: 'email',
            template: 'urgent_payment_reminder',
          },
          reasoning: 'Changed recovery strategy to email notification',
        },
        { headers: { Authorization: `Bearer ${merchantToken}` } }
      );

      assert.strictEqual(modifyRes.status, 200);
      assert.strictEqual(modifyRes.data.success, true);
      assert.strictEqual(modifyRes.data.reviewStatus, REVIEW_STATUSES.MODIFIED);

      const explanation = await ObservabilityService.getDecisionExplanation(caseId);
      assert.ok(explanation.humanReview);
      assert.strictEqual(explanation.humanReview.reviewAction, 'MODIFY');
      assert.strictEqual(explanation.humanReview.modifiedAction, 'send_recovery_message');
      assert.strictEqual(explanation.humanReview.modifiedParams.channel, 'email');
      assert.strictEqual(explanation.humanReview.policyBefore, 'REQUIRE_APPROVAL');
      assert.strictEqual(explanation.humanReview.policyAfter, 'ALLOW');
    });

    it('3. REJECT records rejection reason, blocks tool execution, and logs outcome', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Review Reject Customer',
        email: `reject.${Date.now()}@example.com`,
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

      const orchestratorResult = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      const caseId = orchestratorResult.decision.id;

      const rejectRes = await axios.post(
        `${BASE_URL}/api/admin/recovery-cases/${caseId}/reject`,
        { reasoning: 'Customer requested cancellation of account' },
        { headers: { Authorization: `Bearer ${merchantToken}` } }
      );

      assert.strictEqual(rejectRes.status, 200);
      assert.strictEqual(rejectRes.data.success, true);
      assert.strictEqual(rejectRes.data.reviewStatus, REVIEW_STATUSES.REJECTED);
      assert.strictEqual(rejectRes.data.execution.executed, false);

      const explanation = await ObservabilityService.getDecisionExplanation(caseId);
      assert.strictEqual(explanation.status, 'rejected');
      assert.strictEqual(explanation.humanReview.reviewAction, 'REJECT');
      assert.strictEqual(explanation.humanReview.reasoning, 'Customer requested cancellation of account');
      assert.strictEqual(explanation.actions.length, 0, 'No action record should be executed for rejected case');
    });
  });

  // -------------------------------------------------------------
  // D. Event Replay Lineage Tracking
  // -------------------------------------------------------------
  describe('D. Event Replay Lineage Tracking', () => {
    it('1. Correctly preserves originalEventId and replayEventId during replay orchestration', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Replay Lineage Customer',
        email: `replay.lineage.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 1999.00,
        currency: 'INR',
        paymentMethod: 'upi',
        status: 'failed',
        failureReason: 'network_timeout',
        attemptCount: 1,
      });

      const originalEventId = `evt_orig_${crypto.randomUUID()}`;
      const replayEventId = `evt_replay_${crypto.randomUUID()}`;

      const result = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
        eventId: replayEventId,
        originalEventId,
        replayEventId,
      });

      assert.ok(result.decision);

      const explanation = await ObservabilityService.getDecisionExplanation(result.decision.id);
      assert.strictEqual(explanation.isReplay, true);
      assert.strictEqual(explanation.lineage.originalEventId, originalEventId);
      assert.strictEqual(explanation.lineage.replayEventId, replayEventId);
    });
  });

  // -------------------------------------------------------------
  // E. Secret & Credential Scrubbing (Security Guardrail)
  // -------------------------------------------------------------
  describe('E. Secret & Credential Scrubbing (Security Guardrail)', () => {
    it('1. Recursively scrubs sensitive keys from audit logs and decision explanations', () => {
      const sensitivePayload = {
        transactionId: 'txn_123',
        amount: 5000,
        card_number: '4111111111111234',
        cvv: '123',
        token: 'tok_live_secret_9999',
        apiKey: 'sk_live_abcdef123456',
        password: 'super_secret_password',
        authorization: 'Bearer jwt.token.here',
        metadata: {
          user_id: 'usr_888',
          secret: 'top_secret_salt',
          pan: '5500000000000004',
          nested: {
            auth_token: 'auth_tok_xyz',
            safeField: 'This is safe',
          },
        },
        items: [
          { name: 'Subscription A', price: 5000 },
          { jwt: 'jwt.token.string', description: 'Item with token' },
        ],
      };

      const sanitized = ObservabilityService.sanitizeForAudit(sensitivePayload);

      assert.strictEqual(sanitized.card_number, '[REDACTED]');
      assert.strictEqual(sanitized.cvv, '[REDACTED]');
      assert.strictEqual(sanitized.token, '[REDACTED]');
      assert.strictEqual(sanitized.apiKey, '[REDACTED]');
      assert.strictEqual(sanitized.password, '[REDACTED]');
      assert.strictEqual(sanitized.authorization, '[REDACTED]');
      assert.strictEqual(sanitized.metadata.secret, '[REDACTED]');
      assert.strictEqual(sanitized.metadata.pan, '[REDACTED]');
      assert.strictEqual(sanitized.metadata.nested.auth_token, '[REDACTED]');
      assert.strictEqual(sanitized.metadata.nested.safeField, 'This is safe');
      assert.strictEqual(sanitized.items[1].jwt, '[REDACTED]');
      assert.strictEqual(sanitized.items[0].name, 'Subscription A');
      assert.strictEqual(sanitized.amount, 5000);
    });

    it('2. Metadata with secrets is sanitized when stored in decision explanation', async () => {
      const customer = await findOrCreateCustomer({
        name: 'Secret Scrub Customer',
        email: `secret.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 3500.00,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
        metadata: {
          webhookSecret: 'whsec_9999999',
          apiKey: 'key_live_hidden',
          safeNote: 'Regular customer',
        },
      });

      const result = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      const explanation = await ObservabilityService.getDecisionExplanation(result.decision.id);
      assert.strictEqual(explanation.transaction.metadata.apiKey, '[REDACTED]');
      assert.strictEqual(explanation.transaction.metadata.safeNote, 'Regular customer');
    });
  });

  // -------------------------------------------------------------
  // F. Decision Explanation API Endpoint
  // -------------------------------------------------------------
  describe('F. Decision Explanation API Endpoint', () => {
    it('1. GET /api/admin/recovery-cases/:caseId/explanation returns complete audit schema', async () => {
      const customer = await findOrCreateCustomer({
        name: 'API Explanation Customer',
        email: `api.exp.${Date.now()}@example.com`,
      });

      const transaction = await createTransaction({
        customerId: customer.id,
        amount: 4500.00,
        currency: 'INR',
        paymentMethod: 'upi',
        status: 'failed',
        failureReason: 'payment_gateway_down',
        attemptCount: 1,
      });

      const result = await RecoveryOrchestrator.orchestrateRecovery({
        transaction,
        customer,
      });

      const caseId = result.decision.id;

      const res = await axios.get(`${BASE_URL}/api/admin/recovery-cases/${caseId}/explanation`, {
        headers: { Authorization: `Bearer ${merchantToken}` },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      const data = res.data.data;

      assert.strictEqual(data.caseId, caseId);
      assert.strictEqual(data.transactionId, transaction.id);
      assert.ok(data.lineage);
      assert.ok(data.ml);
      assert.ok(data.agent1);
      assert.ok(data.agent2);
      assert.ok(data.policy);
      assert.ok(Array.isArray(data.actions));
      assert.ok(Array.isArray(data.timeline));
    });

    it('2. GET /api/admin/recovery-cases/:caseId/explanation returns 404 for unknown case', async () => {
      const nonExistentId = crypto.randomUUID();
      try {
        await axios.get(`${BASE_URL}/api/admin/recovery-cases/${nonExistentId}/explanation`, {
          headers: { Authorization: `Bearer ${merchantToken}` },
        });
        assert.fail('Should have returned 404');
      } catch (err) {
        assert.strictEqual(err.response.status, 404);
        assert.strictEqual(err.response.data.success, false);
      }
    });

    it('3. GET /api/admin/recovery-cases/:caseId/explanation requires merchant authentication', async () => {
      const nonExistentId = crypto.randomUUID();
      try {
        await axios.get(`${BASE_URL}/api/admin/recovery-cases/${nonExistentId}/explanation`);
        assert.fail('Should have returned 401');
      } catch (err) {
        assert.strictEqual(err.response.status, 401);
      }
    });
  });
});
