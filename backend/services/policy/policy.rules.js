/**
 * RecoverIQ Policy Rules Definition
 * Phase 5 - Step 1: Formal Policy Engine
 *
 * Deterministic business rules representing safety invariants and merchant recovery policy.
 */

import { config } from '../config/index.js';
import { POLICY_DECISIONS, RULE_IDS, SUPPORTED_ACTIONS } from './policy.types.js';

export const POLICY_RULES = [
  // -------------------------------------------------------------
  // 1. BLOCK Rules (Highest Precedence - Safety & State Invariants)
  // -------------------------------------------------------------
  {
    id: RULE_IDS.INVALID_STATE,
    name: 'Invalid Transaction State',
    description: 'Rejects transactions with missing or invalid amounts (<= 0 or NaN).',
    decision: POLICY_DECISIONS.BLOCK,
    evaluate: (ctx) => {
      const amount = ctx.transaction?.amount;
      if (amount === undefined || amount === null || typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
        return {
          triggered: true,
          reason: `Invalid transaction state: amount (${amount}) must be a positive number.`,
        };
      }
      return { triggered: false };
    },
  },
  {
    id: RULE_IDS.TERMINAL_STATE_RECOVERED,
    name: 'Terminal State: Recovered',
    description: 'Blocks automated actions on transactions that are already marked recovered.',
    decision: POLICY_DECISIONS.BLOCK,
    evaluate: (ctx) => {
      if (ctx.transaction?.status === 'recovered') {
        return {
          triggered: true,
          reason: 'Transaction is already successfully recovered. No action permitted.',
        };
      }
      return { triggered: false };
    },
  },
  {
    id: RULE_IDS.TERMINAL_STATE_ABANDONED,
    name: 'Terminal State: Abandoned',
    description: 'Blocks automated actions on transactions marked abandoned.',
    decision: POLICY_DECISIONS.BLOCK,
    evaluate: (ctx) => {
      if (ctx.transaction?.status === 'abandoned') {
        return {
          triggered: true,
          reason: 'Transaction is marked abandoned. Automated execution is blocked.',
        };
      }
      return { triggered: false };
    },
  },
  {
    id: RULE_IDS.FRAUD_BLOCK,
    name: 'Anti-Fraud & High Risk Block',
    description: 'Blocks automated recovery when high-risk fraud indicators are present.',
    decision: POLICY_DECISIONS.BLOCK,
    evaluate: (ctx) => {
      const isFraudFailure = ctx.transaction?.failureReason === 'high_risk_fraud';
      const isFraudFlagged = ctx.metadata?.fraudFlag === true || ctx.transaction?.metadata?.fraudFlag === true;
      const isHighFraudScore = ctx.metadata?.fraudScore !== undefined && ctx.metadata.fraudScore >= config.guardrails.fraudBlockThreshold;

      if (isFraudFailure || isFraudFlagged || isHighFraudScore) {
        return {
          triggered: true,
          reason: 'High risk fraud indicators present. Automated recovery prohibited.',
        };
      }
      return { triggered: false };
    },
  },
  {
    id: RULE_IDS.UNSUPPORTED_ACTION,
    name: 'Unsupported Action Enforcement',
    description: 'Blocks execution if the proposed action is not recognized by the platform.',
    decision: POLICY_DECISIONS.BLOCK,
    evaluate: (ctx) => {
      const action = ctx.proposedAction;
      if (action && !SUPPORTED_ACTIONS.includes(action)) {
        return {
          triggered: true,
          reason: `Unsupported or invalid proposed recovery action: '${action}'.`,
        };
      }
      return { triggered: false };
    },
  },

  // -------------------------------------------------------------
  // 2. REQUIRE_APPROVAL Rules (Merchant Approval Thresholds)
  // -------------------------------------------------------------
  {
    id: RULE_IDS.MAX_AMOUNT_CEILING,
    name: 'Autonomous Amount Ceiling',
    description: 'Requires human merchant review for transactions exceeding the autonomous threshold.',
    decision: POLICY_DECISIONS.REQUIRE_APPROVAL,
    evaluate: (ctx) => {
      const amount = ctx.transaction?.amount || 0;
      const maxAmount = config.guardrails.maxAutoApprovalAmount;
      if (amount > maxAmount) {
        if (ctx.humanApproval === true || ctx.merchantApproved === true) {
          return { triggered: false };
        }
        return {
          triggered: true,
          reason: `Transaction amount (₹${amount.toLocaleString()}) exceeds the ₹${maxAmount.toLocaleString()} autonomous threshold. Requires merchant sign-off.`,
        };
      }
      return { triggered: false };
    },
  },
  {
    id: RULE_IDS.MAX_RETRIES_EXCEEDED,
    name: 'Max Automated Retries Cap',
    description: 'Requires approval if direct recovery is requested after exceeding maximum auto retries.',
    decision: POLICY_DECISIONS.REQUIRE_APPROVAL,
    evaluate: (ctx) => {
      const action = ctx.proposedAction;
      const attemptCount = ctx.transaction?.attemptCount ?? ctx.recoveryContext?.attemptCount ?? 1;
      const maxRetries = config.guardrails.maxAutoRetries;

      if (action === 'attempt_recovery' && attemptCount >= maxRetries) {
        if (ctx.humanApproval === true || ctx.merchantApproved === true) {
          return { triggered: false };
        }
        return {
          triggered: true,
          reason: `Transaction has already had ${attemptCount} failed attempts (Max auto: ${maxRetries}). Merchant approval required.`,
        };
      }
      return { triggered: false };
    },
  },
  {
    id: RULE_IDS.HIGH_VALUE_LOW_CONFIDENCE,
    name: 'High Value with Low ML Likelihood',
    description: 'Requires human review when high value is paired with low ML recovery confidence.',
    decision: POLICY_DECISIONS.REQUIRE_APPROVAL,
    evaluate: (ctx) => {
      const action = ctx.proposedAction;
      const amount = ctx.transaction?.amount || 0;
      const mlScore = ctx.mlPrediction?.probability;
      const highValThreshold = config.guardrails.highValueThreshold;

      if (
        action === 'attempt_recovery' &&
        amount >= highValThreshold &&
        mlScore !== undefined &&
        mlScore !== null &&
        mlScore < 0.60
      ) {
        if (ctx.humanApproval === true || ctx.merchantApproved === true) {
          return { triggered: false };
        }
        return {
          triggered: true,
          reason: `High-value amount (₹${amount.toLocaleString()}) paired with low/moderate ML recovery likelihood (${(mlScore * 100).toFixed(0)}%). Merchant review recommended.`,
        };
      }
      return { triggered: false };
    },
  },
  {
    id: RULE_IDS.CARD_EXPIRED_MISMATCH,
    name: 'Card Expired Direct Retry Mismatch',
    description: 'Requires review if attempting direct retry on an expired card instead of messaging.',
    decision: POLICY_DECISIONS.REQUIRE_APPROVAL,
    evaluate: (ctx) => {
      const failureReason = ctx.transaction?.failureReason;
      const action = ctx.proposedAction;

      if (failureReason === 'card_expired' && action === 'attempt_recovery') {
        if (ctx.humanApproval === true || ctx.merchantApproved === true) {
          return { triggered: false };
        }
        return {
          triggered: true,
          reason: 'Attempting direct retry on an expired card will fail at the gateway. Recommend sending recovery message instead.',
        };
      }
      return { triggered: false };
    },
  },

  // -------------------------------------------------------------
  // 3. ALLOW Rules (Policy Clear)
  // -------------------------------------------------------------
  {
    id: RULE_IDS.POLICY_CLEAR,
    name: 'Policy Clearance Approval',
    description: 'Approves autonomous action when all safety and invariant checks pass cleanly.',
    decision: POLICY_DECISIONS.ALLOW,
    evaluate: (ctx) => {
      const action = ctx.proposedAction || 'unknown_action';
      return {
        triggered: true,
        reason: `Action '${action}' approved by automated policy engine.`,
      };
    },
  },
];
