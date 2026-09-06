import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  PolicyEngine,
  evaluatePolicy,
  POLICY_VERSION,
  POLICY_DECISIONS,
  RULE_IDS,
} from '../services/policy/index.js';
import { config } from '../services/config/index.js';

describe('Phase 5 - Step 1: Formal Policy Engine Tests', () => {

  it('1. Normal low-value eligible recovery should return ALLOW (RULE_POLICY_CLEAR)', () => {
    const context = {
      transaction: {
        id: 'txn_normal_001',
        amount: 2499.00,
        currency: 'INR',
        status: 'failed',
        failureReason: 'network_timeout',
        attemptCount: 1,
        paymentMethod: 'card',
      },
      customer: {
        id: 'cust_001',
        name: 'Aarav Patel',
        email: 'aarav@example.com',
      },
      recoveryContext: {
        attemptCount: 1,
        previousSuccesses: 3,
        previousFailures: 0,
      },
      proposedAction: 'attempt_recovery',
      toolParams: { paymentId: 'pay_123' },
      mlPrediction: {
        probability: 0.88,
        reason_codes: ['transient_network_glitch'],
      },
      metadata: {},
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.ALLOW);
    assert.strictEqual(result.ruleId, RULE_IDS.POLICY_CLEAR);
    assert.strictEqual(result.policyVersion, POLICY_VERSION);
    assert.ok(result.appliedRules.includes(RULE_IDS.POLICY_CLEAR));
    assert.ok(result.reasons.length > 0);
    assert.ok(result.evaluatedAt);
    assert.strictEqual(result.metadata.transactionId, 'txn_normal_001');
    assert.strictEqual(result.metadata.amount, 2499.00);
  });

  it('2. Transaction amount exceeding autonomous ceiling should return REQUIRE_APPROVAL (RULE_MAX_AMOUNT_CEILING)', () => {
    const maxThreshold = config.guardrails.maxAutoApprovalAmount; // ₹50,000
    const context = {
      transaction: {
        id: 'txn_high_amount_002',
        amount: maxThreshold + 15000.00, // ₹65,000
        currency: 'INR',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
        paymentMethod: 'card',
      },
      customer: { id: 'cust_002' },
      proposedAction: 'send_recovery_message',
      mlPrediction: { probability: 0.75 },
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
    assert.strictEqual(result.ruleId, RULE_IDS.MAX_AMOUNT_CEILING);
    assert.ok(result.appliedRules.includes(RULE_IDS.MAX_AMOUNT_CEILING));
    assert.ok(result.reason.includes('exceeds the ₹50,000 autonomous threshold'));
  });

  it('3. High-risk fraud case should return BLOCK (RULE_FRAUD_BLOCK)', () => {
    const context = {
      transaction: {
        id: 'txn_fraud_003',
        amount: 3500.00,
        currency: 'INR',
        status: 'failed',
        failureReason: 'high_risk_fraud',
        attemptCount: 1,
        paymentMethod: 'card',
      },
      proposedAction: 'attempt_recovery',
      mlPrediction: { probability: 0.05 },
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.BLOCK);
    assert.strictEqual(result.ruleId, RULE_IDS.FRAUD_BLOCK);
    assert.ok(result.appliedRules.includes(RULE_IDS.FRAUD_BLOCK));
    assert.ok(result.reason.includes('High risk fraud indicators present'));
  });

  it('4. Fraud flagged in metadata should also return BLOCK (RULE_FRAUD_BLOCK)', () => {
    const context = {
      transaction: {
        id: 'txn_meta_fraud_004',
        amount: 1999.00,
        currency: 'INR',
        status: 'failed',
        failureReason: 'authentication_failed',
        attemptCount: 1,
      },
      proposedAction: 'attempt_recovery',
      metadata: { fraudFlag: true },
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.BLOCK);
    assert.strictEqual(result.ruleId, RULE_IDS.FRAUD_BLOCK);
  });

  it('5. Terminal state (recovered) should return BLOCK (RULE_TERMINAL_STATE_RECOVERED)', () => {
    const context = {
      transaction: {
        id: 'txn_rec_005',
        amount: 1500.00,
        currency: 'INR',
        status: 'recovered',
        failureReason: 'none',
        attemptCount: 1,
      },
      proposedAction: 'attempt_recovery',
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.BLOCK);
    assert.strictEqual(result.ruleId, RULE_IDS.TERMINAL_STATE_RECOVERED);
    assert.ok(result.reason.includes('already successfully recovered'));
  });

  it('6. Terminal state (abandoned) should return BLOCK (RULE_TERMINAL_STATE_ABANDONED)', () => {
    const context = {
      transaction: {
        id: 'txn_aban_006',
        amount: 1500.00,
        currency: 'INR',
        status: 'abandoned',
        failureReason: 'insufficient_funds',
        attemptCount: 4,
      },
      proposedAction: 'send_recovery_message',
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.BLOCK);
    assert.strictEqual(result.ruleId, RULE_IDS.TERMINAL_STATE_ABANDONED);
    assert.ok(result.reason.includes('Transaction is marked abandoned'));
  });

  it('7. Unsupported or invalid proposed recovery action should return BLOCK (RULE_UNSUPPORTED_ACTION)', () => {
    const context = {
      transaction: {
        id: 'txn_unsupp_007',
        amount: 2000.00,
        currency: 'INR',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      },
      proposedAction: 'delete_merchant_account', // Unsupported action
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.BLOCK);
    assert.strictEqual(result.ruleId, RULE_IDS.UNSUPPORTED_ACTION);
    assert.ok(result.reason.includes("Unsupported or invalid proposed recovery action: 'delete_merchant_account'"));
  });

  it('8. Missing or invalid required transaction state (amount <= 0) should return BLOCK (RULE_INVALID_STATE)', () => {
    const context = {
      transaction: {
        id: 'txn_inv_008',
        amount: -50.00, // Invalid negative amount
        currency: 'INR',
        status: 'failed',
        failureReason: 'insufficient_funds',
      },
      proposedAction: 'attempt_recovery',
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.BLOCK);
    assert.strictEqual(result.ruleId, RULE_IDS.INVALID_STATE);
  });

  it('9. Card expired with attempt_recovery should return REQUIRE_APPROVAL (RULE_CARD_EXPIRED_MISMATCH)', () => {
    const context = {
      transaction: {
        id: 'txn_card_exp_009',
        amount: 3000.00,
        currency: 'INR',
        status: 'failed',
        failureReason: 'card_expired',
        attemptCount: 1,
      },
      proposedAction: 'attempt_recovery', // Mismatched action on expired card
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
    assert.strictEqual(result.ruleId, RULE_IDS.CARD_EXPIRED_MISMATCH);
    assert.ok(result.reason.includes('expired card will fail at the gateway'));
  });

  it('10. Card expired with send_recovery_message should be ALLOWed cleanly', () => {
    const context = {
      transaction: {
        id: 'txn_card_exp_msg_010',
        amount: 3000.00,
        currency: 'INR',
        status: 'failed',
        failureReason: 'card_expired',
        attemptCount: 1,
      },
      proposedAction: 'send_recovery_message', // Correct action for expired card
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.ALLOW);
    assert.strictEqual(result.ruleId, RULE_IDS.POLICY_CLEAR);
  });

  it('11. Max retries exceeded (attemptCount >= 3 with attempt_recovery) should return REQUIRE_APPROVAL (RULE_MAX_RETRIES_EXCEEDED)', () => {
    const context = {
      transaction: {
        id: 'txn_max_retries_011',
        amount: 2500.00,
        currency: 'INR',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 3, // At or above maxAutoRetries (3)
      },
      proposedAction: 'attempt_recovery',
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
    assert.strictEqual(result.ruleId, RULE_IDS.MAX_RETRIES_EXCEEDED);
    assert.ok(result.reason.includes('already had 3 failed attempts'));
  });

  it('12. High value transaction paired with low ML recovery score should return REQUIRE_APPROVAL (RULE_HIGH_VALUE_LOW_CONFIDENCE)', () => {
    const context = {
      transaction: {
        id: 'txn_high_val_low_ml_012',
        amount: 25000.00, // >= highValueThreshold (₹20,000)
        currency: 'INR',
        status: 'failed',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      },
      proposedAction: 'attempt_recovery',
      mlPrediction: {
        probability: 0.35, // < 0.60
      },
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
    assert.strictEqual(result.ruleId, RULE_IDS.HIGH_VALUE_LOW_CONFIDENCE);
    assert.ok(result.reason.includes('High-value amount'));
    assert.ok(result.reason.includes('35%'));
  });

  it('13. Strict Precedence: BLOCK must override REQUIRE_APPROVAL when multiple rules trigger', () => {
    // Both amount > 50,000 (REQUIRE_APPROVAL) AND status === 'recovered' (BLOCK)
    const context = {
      transaction: {
        id: 'txn_multi_013',
        amount: 80000.00,
        currency: 'INR',
        status: 'recovered', // BLOCK
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      },
      proposedAction: 'attempt_recovery',
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.BLOCK, 'BLOCK must take precedence over REQUIRE_APPROVAL');
    assert.strictEqual(result.ruleId, RULE_IDS.TERMINAL_STATE_RECOVERED);
    assert.ok(result.appliedRules.includes(RULE_IDS.TERMINAL_STATE_RECOVERED));
    assert.ok(result.appliedRules.includes(RULE_IDS.MAX_AMOUNT_CEILING));
  });

  it('14. Strict Determinism: Identical inputs must return strictly identical policy results', () => {
    const context = {
      transaction: {
        id: 'txn_det_014',
        amount: 9999.00,
        currency: 'INR',
        status: 'failed',
        failureReason: 'bank_outage',
        attemptCount: 1,
      },
      proposedAction: 'attempt_recovery',
      mlPrediction: { probability: 0.91 },
    };

    const run1 = evaluatePolicy(context);
    const run2 = evaluatePolicy(context);

    assert.strictEqual(run1.decision, run2.decision);
    assert.strictEqual(run1.ruleId, run2.ruleId);
    assert.deepStrictEqual(run1.appliedRules, run2.appliedRules);
    assert.deepStrictEqual(run1.reasons, run2.reasons);
    assert.strictEqual(run1.policyVersion, run2.policyVersion);
  });

  it('15. Backward compatibility: supports legacy flat context object', () => {
    const flatContext = {
      transactionId: 'txn_legacy_015',
      amount: 4500.00,
      currency: 'INR',
      status: 'failed',
      failureReason: 'network_timeout',
      attemptCount: 1,
      recommendedAction: 'attempt_recovery',
      mlScore: 0.85,
    };

    const result = evaluatePolicy(flatContext);

    assert.strictEqual(result.decision, POLICY_DECISIONS.ALLOW);
    assert.strictEqual(result.ruleId, RULE_IDS.POLICY_CLEAR);
    assert.strictEqual(result.metadata.transactionId, 'txn_legacy_015');
    assert.strictEqual(result.metadata.amount, 4500.00);
  });

  it('16. Policy Engine is purely deterministic and NEVER executes tools directly', () => {
    let toolExecuted = false;
    const fakeTool = () => { toolExecuted = true; };

    const context = {
      transaction: {
        id: 'txn_pure_016',
        amount: 1000.00,
        status: 'failed',
        failureReason: 'network_timeout',
      },
      proposedAction: 'attempt_recovery',
      fakeTool,
    };

    const result = evaluatePolicy(context);

    assert.strictEqual(result.decision, POLICY_DECISIONS.ALLOW);
    assert.strictEqual(toolExecuted, false, 'Policy engine must never invoke external tools');
  });

});
