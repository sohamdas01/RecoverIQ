import { config } from '../config/index.js';

export class GuardrailService {
  /**
   * Evaluates the recommended action against business policies and state invariants
   */
  static evaluate(context) {
    const appliedRules = [];
    const {
      status,
      failureReason,
      attemptCount,
      amount,
      recommendedAction,
      mlScore,
    } = context;

    // Rule 1: Terminal Status Check
    if (status === 'recovered') {
      appliedRules.push('RULE_TERMINAL_STATE_RECOVERED');
      return {
        decision: 'BLOCK',
        reason: 'Transaction is already successfully recovered. No action permitted.',
        appliedRules,
      };
    }

    if (status === 'abandoned') {
      appliedRules.push('RULE_TERMINAL_STATE_ABANDONED');
      return {
        decision: 'BLOCK',
        reason: 'Transaction is marked abandoned. Automated execution is blocked.',
        appliedRules,
      };
    }

    // Rule 2: Anti-Fraud & High Risk Block
    if (failureReason === 'high_risk_fraud') {
      appliedRules.push('RULE_FRAUD_BLOCK');
      return {
        decision: 'BLOCK',
        reason: 'High risk fraud indicators present. Automated recovery prohibited.',
        appliedRules,
      };
    }

    // Rule 3: Max Auto Retries Cap
    if (recommendedAction === 'attempt_recovery' && attemptCount >= config.guardrails.maxAutoRetries) {
      appliedRules.push('RULE_MAX_RETRIES_EXCEEDED');
      return {
        decision: 'REQUIRE_APPROVAL',
        reason: `Transaction has already had ${attemptCount} failed attempts (Max auto: ${config.guardrails.maxAutoRetries}). Merchant approval required.`,
        appliedRules,
      };
    }

    // Rule 4: High Value Transaction Ceiling
    if (amount > config.guardrails.maxAutoApprovalAmount) {
      appliedRules.push('RULE_MAX_AMOUNT_CEILING');
      return {
        decision: 'REQUIRE_APPROVAL',
        reason: `Transaction amount (₹${amount.toLocaleString()}) exceeds the ₹${config.guardrails.maxAutoApprovalAmount.toLocaleString()} autonomous threshold. Requires merchant sign-off.`,
        appliedRules,
      };
    }

    // Rule 5: Moderate ML Score on Significant Amount
    if (
      recommendedAction === 'attempt_recovery' &&
      amount >= config.guardrails.highValueThreshold &&
      mlScore !== undefined &&
      mlScore < 0.60
    ) {
      appliedRules.push('RULE_HIGH_VALUE_LOW_CONFIDENCE');
      return {
        decision: 'REQUIRE_APPROVAL',
        reason: `High-value amount (₹${amount.toLocaleString()}) paired with low/moderate ML recovery likelihood (${(mlScore * 100).toFixed(0)}%). Merchant review recommended.`,
        appliedRules,
      };
    }

    // Rule 6: Card Expired Fallback
    if (failureReason === 'card_expired' && recommendedAction === 'attempt_recovery') {
      appliedRules.push('RULE_CARD_EXPIRED_MISMATCH');
      return {
        decision: 'REQUIRE_APPROVAL',
        reason: 'Attempting direct retry on an expired card will fail at the gateway. Recommend sending recovery message instead.',
        appliedRules,
      };
    }

    // If all guardrail policies pass cleanly:
    appliedRules.push('RULE_POLICY_CLEAR');
    return {
      decision: 'ALLOW',
      reason: `Action '${recommendedAction}' approved by automated guardrail policy engine.`,
      appliedRules,
    };
  }
}
