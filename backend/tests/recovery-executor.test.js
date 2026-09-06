import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RecoveryExecutorClient } from '../services/agents/recovery-executor.client.js';
import { RecoveryAnalystClient } from '../services/agents/recovery-analyst.client.js';
import { evaluatePolicy, POLICY_DECISIONS, RULE_IDS } from '../services/policy/index.js';

describe('Phase 5 - Step 3: Agent 2 (Recovery Executor / Action Planner) Tests', () => {

  // -------------------------------------------------------------
  // 1. Schema & Response Validation Tests
  // -------------------------------------------------------------
  describe('A. Schema & Parameter Validation', () => {
    it('1. Valid executor output should be accepted by validateResponse', () => {
      const rawData = {
        proposedAction: 'send_recovery_message',
        confidence: 0.94,
        reasonCodes: ['CARD_EXPIRED_CONFIRMED'],
        rationale: 'Formulated self-service recovery message with tokenized payment link.',
        parameters: {
          channel: 'email',
          templateId: 'card_expired_update_v1',
          customMessage: 'Please update your card.',
        },
      };

      const result = RecoveryExecutorClient.validateResponse(rawData);
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.data.proposedAction, 'send_recovery_message');
      assert.strictEqual(result.data.confidence, 0.94);
      assert.strictEqual(result.data.parameters.channel, 'email');
    });

    it('2. Invalid or unsupported proposedAction should be rejected', () => {
      const invalidData = {
        proposedAction: 'execute_shell_script', // Forbidden action
        confidence: 0.99,
        rationale: 'Attempting unauthorized action.',
      };

      const result = RecoveryExecutorClient.validateResponse(invalidData);
      assert.strictEqual(result.isValid, false);
      assert.ok(result.error.includes('Invalid or unsupported proposedAction'));
    });

    it('3. Confidence out of bounds (> 1.0 or < 0.0) should be rejected', () => {
      const invalidData = {
        proposedAction: 'attempt_recovery',
        confidence: 2.5,
        rationale: 'Overconfident score.',
      };

      const result = RecoveryExecutorClient.validateResponse(invalidData);
      assert.strictEqual(result.isValid, false);
      assert.ok(result.error.includes('Confidence out of bounds'));
    });

    it('4. Parameter sanitization strips arbitrary/unauthorized parameter keys', () => {
      const unsafeParams = {
        paymentId: 'pay_valid_123',
        retryDelayMinutes: 15,
        maliciousToken: 'DROP TABLE users;',
        unauthorizedSecret: '12345',
      };

      const sanitized = RecoveryExecutorClient.sanitizeParameters('attempt_recovery', unsafeParams);
      assert.strictEqual(sanitized.paymentId, 'pay_valid_123');
      assert.strictEqual(sanitized.retryDelayMinutes, 15);
      assert.strictEqual(sanitized.maliciousToken, undefined);
      assert.strictEqual(sanitized.unauthorizedSecret, undefined);
    });
  });

  // -------------------------------------------------------------
  // 2. Safe Fallback & Resilience Tests
  // -------------------------------------------------------------
  describe('B. Safe Fallback & Invariants', () => {
    it('5. Fallback for card_expired forces send_recovery_message', () => {
      const fallback = RecoveryExecutorClient.deterministicFallback({
        transaction: {
          id: 'txn_exp_exec',
          amount: 2500.00,
          failureReason: 'card_expired',
        },
        agent1Recommendation: {
          recommendation: 'attempt_recovery', // Inappropriate
          confidence: 0.70,
        },
      });

      assert.strictEqual(fallback.proposedAction, 'send_recovery_message');
      assert.strictEqual(fallback.isFallback, true);
      assert.strictEqual(fallback.agentName, 'RecoveryExecutor');
    });

    it('6. Fallback for high_risk_fraud forces escalate_to_human', () => {
      const fallback = RecoveryExecutorClient.deterministicFallback({
        transaction: {
          id: 'txn_fraud_exec',
          amount: 8000.00,
          failureReason: 'high_risk_fraud',
        },
        agent1Recommendation: {
          recommendation: 'attempt_recovery',
          confidence: 0.50,
        },
      });

      assert.strictEqual(fallback.proposedAction, 'escalate_to_human');
      assert.strictEqual(fallback.isFallback, true);
      assert.ok(fallback.reasonCodes.includes('HIGH_RISK_FRAUD_FLAGGED'));
    });

    it('7. Unreachable GenAI service returns safe deterministic fallback without throwing', async () => {
      const result = await RecoveryExecutorClient.plan({
        transaction: {
          id: 'txn_timeout_exec',
          amount: 1500.00,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'network_timeout',
          attemptCount: 1,
        },
        customer: { id: 'cust_timeout_2' },
        customerStats: {},
        agent1Recommendation: {
          recommendation: 'attempt_recovery',
          confidence: 0.88,
          rationale: 'Network glitch.',
          suggestedParameters: { paymentId: 'pay_retry_123' },
        },
      }, { timeoutMs: 50 });

      assert.ok(result.proposedAction);
      assert.strictEqual(result.agentName, 'RecoveryExecutor');
      assert.ok(result.confidence >= 0.0 && result.confidence <= 1.0);
      assert.ok(result.parameters);
    });
  });

  // -------------------------------------------------------------
  // 3. Security & Policy Authority Boundaries
  // -------------------------------------------------------------
  describe('C. Security Boundaries & Policy Engine Authority', () => {
    it('8. High value action proposal (> ₹50,000) is STILL overruled to REQUIRE_APPROVAL by Policy Engine', () => {
      const agent2Proposal = {
        proposedAction: 'attempt_recovery',
        confidence: 0.98,
        parameters: { paymentId: 'pay_high_val' },
      };

      const highValTx = {
        id: 'txn_high_amount_exec',
        amount: 85000.00, // Exceeds threshold
        currency: 'INR',
        status: 'failed',
        failureReason: 'bank_outage',
        attemptCount: 1,
      };

      const policyResult = evaluatePolicy({
        transaction: highValTx,
        proposedAction: agent2Proposal.proposedAction,
        toolParams: agent2Proposal.parameters,
      });

      assert.strictEqual(policyResult.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
      assert.strictEqual(policyResult.ruleId, RULE_IDS.MAX_AMOUNT_CEILING);
    });

    it('9. Fraud action proposal is STILL strictly BLOCKED by Policy Engine', () => {
      const fraudTx = {
        id: 'txn_fraud_policy_check',
        amount: 1000.00,
        currency: 'INR',
        status: 'failed',
        failureReason: 'high_risk_fraud',
      };

      const policyResult = evaluatePolicy({
        transaction: fraudTx,
        proposedAction: 'attempt_recovery',
      });

      assert.strictEqual(policyResult.decision, POLICY_DECISIONS.BLOCK);
      assert.strictEqual(policyResult.ruleId, RULE_IDS.FRAUD_BLOCK);
    });

    it('10. Agent 2 client is pure reasoning and never executes tools directly', async () => {
      let toolExecuted = false;
      const fakeTool = () => { toolExecuted = true; };

      const result = await RecoveryExecutorClient.plan({
        transaction: {
          id: 'txn_pure_sec_2',
          amount: 500.00,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'bank_outage',
        },
        customer: {},
        agent1Recommendation: {
          recommendation: 'attempt_recovery',
          confidence: 0.90,
        },
        fakeTool,
      });

      assert.ok(result.proposedAction);
      assert.strictEqual(toolExecuted, false, 'Agent 2 client must never execute tools directly');
    });
  });

  // -------------------------------------------------------------
  // 4. Sequential Multi-Agent Pipeline Integration
  // -------------------------------------------------------------
  describe('D. Multi-Agent Pipeline Flow (Agent 1 -> Agent 2 -> Policy Engine)', () => {
    it('11. Complete multi-agent pipeline evaluates eligible transaction cleanly', async () => {
      const tx = {
        id: 'txn_pipeline_test',
        amount: 1999.00,
        currency: 'INR',
        paymentMethod: 'card',
        failureReason: 'bank_outage',
        attemptCount: 1,
      };

      // 1. Agent 1 Analysis
      const a1Result = await RecoveryAnalystClient.analyze({
        transaction: tx,
        customer: { id: 'cust_pipe_1' },
        customerStats: { previousSuccesses: 4 },
        mlPrediction: { probability: 0.92, reason_codes: ['GATEWAY_OUTAGE'] },
      });
      assert.ok(a1Result.recommendation);

      // 2. Agent 2 Action Planning
      const a2Result = await RecoveryExecutorClient.plan({
        transaction: tx,
        customer: { id: 'cust_pipe_1' },
        customerStats: { previousSuccesses: 4 },
        mlPrediction: { probability: 0.92 },
        agent1Recommendation: a1Result,
      });
      assert.ok(a2Result.proposedAction);
      assert.ok(a2Result.parameters);

      // 3. Policy Engine Evaluation
      const policyResult = evaluatePolicy({
        transaction: tx,
        proposedAction: a2Result.proposedAction,
        toolParams: a2Result.parameters,
      });
      assert.strictEqual(policyResult.decision, POLICY_DECISIONS.ALLOW);
      assert.strictEqual(policyResult.ruleId, RULE_IDS.POLICY_CLEAR);
    });
  });

});
