import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RecoveryAnalystClient } from '../services/agents/recovery-analyst.client.js';
import { evaluatePolicy, POLICY_DECISIONS, RULE_IDS } from '../services/policy/index.js';

describe('Phase 5 - Step 2: Agent 1 (Recovery Analyst) Tests', () => {

  // -------------------------------------------------------------
  // 1. Schema Validation Tests
  // -------------------------------------------------------------
  describe('A. Schema & Response Validation', () => {
    it('1. Valid analyst output should be accepted by validateResponse', () => {
      const rawData = {
        recommendation: 'attempt_recovery',
        confidence: 0.88,
        reasonCodes: ['TRANSIENT_GATEWAY_OUTAGE'],
        rationale: 'Gateway timeout recovered; immediate retry recommended.',
        suggestedParameters: { paymentId: 'pay_test_123' },
      };

      const result = RecoveryAnalystClient.validateResponse(rawData);
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.data.recommendation, 'attempt_recovery');
      assert.strictEqual(result.data.confidence, 0.88);
      assert.deepStrictEqual(result.data.reasonCodes, ['TRANSIENT_GATEWAY_OUTAGE']);
    });

    it('2. Invalid or unauthorized action recommendation should be rejected', () => {
      const invalidData = {
        recommendation: 'delete_merchant_database', // Forbidden action
        confidence: 0.99,
        rationale: 'Malicious action attempt.',
      };

      const result = RecoveryAnalystClient.validateResponse(invalidData);
      assert.strictEqual(result.isValid, false);
      assert.ok(result.error.includes('Invalid or unsupported recommendation'));
    });

    it('3. Confidence out of bounds (> 1.0 or < 0.0) should be rejected', () => {
      const outOfBounds1 = {
        recommendation: 'attempt_recovery',
        confidence: 1.5,
        rationale: 'Overconfident score.',
      };
      const result1 = RecoveryAnalystClient.validateResponse(outOfBounds1);
      assert.strictEqual(result1.isValid, false);
      assert.ok(result1.error.includes('Confidence out of bounds'));

      const outOfBounds2 = {
        recommendation: 'attempt_recovery',
        confidence: -0.2,
        rationale: 'Negative score.',
      };
      const result2 = RecoveryAnalystClient.validateResponse(outOfBounds2);
      assert.strictEqual(result2.isValid, false);
    });

    it('4. Missing or empty rationale explanation should be rejected', () => {
      const missingRationale = {
        recommendation: 'attempt_recovery',
        confidence: 0.85,
        rationale: '   ', // Empty
      };

      const result = RecoveryAnalystClient.validateResponse(missingRationale);
      assert.strictEqual(result.isValid, false);
      assert.ok(result.error.includes('Rationale explanation missing or empty'));
    });
  });

  // -------------------------------------------------------------
  // 2. Safe Fallback & Resilience Tests
  // -------------------------------------------------------------
  describe('B. Safe Fallback & Resilience', () => {
    it('5. Fallback for card_expired must safely propose send_recovery_message', () => {
      const fallback = RecoveryAnalystClient.deterministicFallback({
        transaction: {
          id: 'txn_exp_test',
          amount: 2500.00,
          failureReason: 'card_expired',
          attemptCount: 1,
        },
        customerStats: {},
        mlPrediction: { probability: 0.85 },
      });

      assert.strictEqual(fallback.recommendation, 'send_recovery_message');
      assert.strictEqual(fallback.isFallback, true);
      assert.strictEqual(fallback.agentName, 'RecoveryAnalyst');
      assert.ok(fallback.reasonCodes.includes('CARD_EXPIRED_FALLBACK'));
    });

    it('6. Fallback for high_risk_fraud must safely propose escalate_to_human', () => {
      const fallback = RecoveryAnalystClient.deterministicFallback({
        transaction: {
          id: 'txn_fraud_test',
          amount: 5000.00,
          failureReason: 'high_risk_fraud',
          attemptCount: 1,
        },
        customerStats: {},
        mlPrediction: { probability: 0.05 },
      });

      assert.strictEqual(fallback.recommendation, 'escalate_to_human');
      assert.strictEqual(fallback.isFallback, true);
      assert.ok(fallback.reasonCodes.includes('HIGH_RISK_FRAUD_FLAGGED'));
    });

    it('7. Service error or timeout triggers safe fallback instead of throwing unhandled error', async () => {
      // Calling with unreachable port to test resilience
      const result = await RecoveryAnalystClient.analyze({
        transaction: {
          id: 'txn_timeout_test',
          amount: 1999.00,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'bank_outage',
          attemptCount: 1,
        },
        customer: { id: 'cust_timeout' },
        customerStats: { previousSuccesses: 2 },
        mlPrediction: { probability: 0.90 },
      }, { timeoutMs: 50 }); // Fast timeout

      assert.ok(result.recommendation, 'Must produce a recommendation');
      assert.strictEqual(result.agentName, 'RecoveryAnalyst');
      assert.ok(result.confidence >= 0.0 && result.confidence <= 1.0);
    });
  });

  // -------------------------------------------------------------
  // 3. Security Boundary & Policy Engine Authority Tests
  // -------------------------------------------------------------
  describe('C. Security & Authority Boundaries', () => {
    it('8. Agent recommendation alone CANNOT authorize tool execution (Policy Engine remains final authority)', () => {
      // Agent recommends attempt_recovery, but amount exceeds ₹50,000 threshold
      const agentOutput = {
        recommendation: 'attempt_recovery',
        confidence: 0.99,
        rationale: 'Agent strongly recommends retrying despite high amount.',
      };

      const highAmountTx = {
        id: 'txn_high_amount_sec',
        amount: 75000.00, // Exceeds autonomous limit
        currency: 'INR',
        status: 'failed',
        failureReason: 'network_timeout',
        attemptCount: 1,
      };

      const policyDecision = evaluatePolicy({
        transaction: highAmountTx,
        proposedAction: agentOutput.recommendation,
        toolParams: {},
      });

      // Policy Engine must OVERRULE the agent and require approval
      assert.strictEqual(policyDecision.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
      assert.strictEqual(policyDecision.ruleId, RULE_IDS.MAX_AMOUNT_CEILING);
    });

    it('9. Fraud case recommended by Agent is strictly BLOCKED by Policy Engine', () => {
      const fraudTx = {
        id: 'txn_fraud_sec',
        amount: 1500.00,
        currency: 'INR',
        status: 'failed',
        failureReason: 'high_risk_fraud',
      };

      // Even if a model mistakenly proposed attempt_recovery:
      const policyDecision = evaluatePolicy({
        transaction: fraudTx,
        proposedAction: 'attempt_recovery',
      });

      assert.strictEqual(policyDecision.decision, POLICY_DECISIONS.BLOCK);
      assert.strictEqual(policyDecision.ruleId, RULE_IDS.FRAUD_BLOCK);
    });

    it('10. Agent client is pure reasoning and never invokes execution tools directly', async () => {
      let toolExecuted = false;
      const fakeTool = () => { toolExecuted = true; };

      const result = await RecoveryAnalystClient.analyze({
        transaction: {
          id: 'txn_pure_sec',
          amount: 500.00,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'bank_outage',
        },
        customer: {},
        fakeTool,
      });

      assert.ok(result.recommendation);
      assert.strictEqual(toolExecuted, false, 'Agent client must never trigger tool side effects');
    });
  });

});
