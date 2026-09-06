/**
 * RecoverIQ Policy Engine
 * Phase 5 - Step 1: Formal Policy Engine
 *
 * Deterministic authority for all recovery action authorizations.
 * Precedence hierarchy: BLOCK > REQUIRE_APPROVAL > ALLOW
 *
 * Agents RECOMMEND.
 * The Policy Engine DECIDES.
 * Tools EXECUTE.
 */

import {
  POLICY_VERSION,
  POLICY_DECISIONS,
  RULE_IDS,
  DECISION_PRECEDENCE,
} from './policy.types.js';
import { POLICY_RULES } from './policy.rules.js';

export class PolicyEngine {
  /**
   * Evaluates recovery action context against deterministic safety and business rules.
   *
   * @param {Object} rawContext Structured or flat policy evaluation context
   * @returns {Object} Structured policy evaluation outcome
   */
  static evaluate(rawContext) {
    const context = PolicyEngine.normalizeContext(rawContext);
    const evaluatedAt = new Date().toISOString();

    const triggeredRules = [];
    const triggeredBlock = [];
    const triggeredApproval = [];
    const triggeredAllow = [];

    // Evaluate all rules in policy catalog
    for (const rule of POLICY_RULES) {
      // Skip the fallback clearance rule during specific evaluations
      if (rule.id === RULE_IDS.POLICY_CLEAR) {
        continue;
      }

      try {
        const result = rule.evaluate(context);
        if (result && result.triggered) {
          const triggeredRecord = {
            id: rule.id,
            name: rule.name,
            decision: rule.decision,
            reason: result.reason || rule.description,
            details: result.details || {},
          };

          triggeredRules.push(triggeredRecord);

          if (rule.decision === POLICY_DECISIONS.BLOCK) {
            triggeredBlock.push(triggeredRecord);
          } else if (rule.decision === POLICY_DECISIONS.REQUIRE_APPROVAL) {
            triggeredApproval.push(triggeredRecord);
          } else if (rule.decision === POLICY_DECISIONS.ALLOW) {
            triggeredAllow.push(triggeredRecord);
          }
        }
      } catch (err) {
        // Fail-safe: if any rule evaluation errors, block execution for safety
        const errorRecord = {
          id: RULE_IDS.INVALID_STATE,
          name: 'Rule Evaluation Error',
          decision: POLICY_DECISIONS.BLOCK,
          reason: `Policy rule evaluation error: ${err.message}`,
          details: { error: err.message },
        };
        triggeredRules.push(errorRecord);
        triggeredBlock.push(errorRecord);
      }
    }

    // -------------------------------------------------------------
    // Deterministic Decision Resolution (Precedence: BLOCK > APPROVAL > ALLOW)
    // -------------------------------------------------------------
    let finalDecision = POLICY_DECISIONS.ALLOW;
    let primaryRule = null;

    if (triggeredBlock.length > 0) {
      finalDecision = POLICY_DECISIONS.BLOCK;
      primaryRule = triggeredBlock[0];
    } else if (triggeredApproval.length > 0) {
      finalDecision = POLICY_DECISIONS.REQUIRE_APPROVAL;
      primaryRule = triggeredApproval[0];
    } else {
      finalDecision = POLICY_DECISIONS.ALLOW;
      const clearRule = POLICY_RULES.find((r) => r.id === RULE_IDS.POLICY_CLEAR);
      const clearResult = clearRule ? clearRule.evaluate(context) : null;
      primaryRule = {
        id: RULE_IDS.POLICY_CLEAR,
        name: 'Policy Clearance Approval',
        decision: POLICY_DECISIONS.ALLOW,
        reason: clearResult?.reason || `Action '${context.proposedAction}' approved by automated policy engine.`,
      };
      triggeredRules.push(primaryRule);
    }

    const appliedRules = triggeredRules.map((r) => r.id);
    const reasons = triggeredRules.map((r) => r.reason);

    return {
      decision: finalDecision,
      ruleId: primaryRule.id,
      appliedRules,
      reasons,
      reason: primaryRule.reason,
      evaluatedAt,
      policyVersion: POLICY_VERSION,
      metadata: {
        transactionId: context.transaction?.id,
        amount: context.transaction?.amount,
        currency: context.transaction?.currency,
        proposedAction: context.proposedAction,
        mlProbability: context.mlPrediction?.probability,
      },
    };
  }

  /**
   * Normalizes incoming context to a standard structured object
   */
  static normalizeContext(raw) {
    if (!raw) {
      return {
        transaction: null,
        customer: null,
        recoveryContext: {},
        proposedAction: null,
        mlPrediction: null,
        metadata: {},
      };
    }

    // If structured format already provided:
    if (raw.transaction && typeof raw.transaction === 'object') {
      const tx = raw.transaction;
      const amount = typeof tx.amount === 'string' ? parseFloat(tx.amount) : tx.amount;

      return {
        transaction: {
          ...tx,
          amount,
        },
        customer: raw.customer || null,
        recoveryContext: raw.recoveryContext || {},
        proposedAction: raw.proposedAction || raw.recommendedAction || null,
        toolParams: raw.toolParams || {},
        mlPrediction: raw.mlPrediction || (raw.mlScore !== undefined ? { probability: raw.mlScore } : null),
        humanApproval: raw.humanApproval === true || raw.merchantApproved === true,
        merchantApproved: raw.merchantApproved === true || raw.humanApproval === true,
        humanReview: raw.humanReview || null,
        metadata: raw.metadata || {},
      };
    }

    // Flat legacy format compatibility
    const amount = typeof raw.amount === 'string' ? parseFloat(raw.amount) : raw.amount;
    const mlProb = raw.mlScore !== undefined
      ? raw.mlScore
      : raw.mlPrediction?.probability;

    return {
      transaction: {
        id: raw.transactionId,
        amount,
        currency: raw.currency || 'INR',
        status: raw.status || 'failed',
        failureReason: raw.failureReason,
        attemptCount: raw.attemptCount !== undefined ? raw.attemptCount : 1,
        paymentMethod: raw.paymentMethod,
        metadata: raw.metadata || {},
      },
      customer: raw.customer || (raw.customerId ? { id: raw.customerId } : null),
      recoveryContext: raw.recoveryContext || {
        attemptCount: raw.attemptCount || 1,
      },
      proposedAction: raw.proposedAction || raw.recommendedAction || null,
      toolParams: raw.toolParams || {},
      mlPrediction: raw.mlPrediction || (mlProb !== undefined ? { probability: mlProb } : null),
      humanApproval: raw.humanApproval === true || raw.merchantApproved === true,
      merchantApproved: raw.merchantApproved === true || raw.humanApproval === true,
      humanReview: raw.humanReview || null,
      metadata: raw.metadata || {},
    };
  }
}

/**
 * Public function API: evaluatePolicy(context)
 */
export function evaluatePolicy(context) {
  return PolicyEngine.evaluate(context);
}
