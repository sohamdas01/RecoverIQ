import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { RecoveryOrchestrator } from '../services/recovery/index.js';
import { evaluatePolicy, POLICY_DECISIONS, RULE_IDS } from '../services/policy/index.js';
import { RecoveryAnalystClient } from '../services/agents/recovery-analyst.client.js';
import { RecoveryExecutorClient } from '../services/agents/recovery-executor.client.js';
import { findOrCreateCustomer } from '../db/queries/customers.queries.js';
import { createTransaction, getTransactionById } from '../db/queries/transactions.queries.js';
import { getDecisionById } from '../db/queries/decisions.queries.js';
import { getActionsByDecisionId } from '../db/queries/actions.queries.js';
import { EVENT_TYPES, OUTCOME_TYPES } from '../kafka/schemas/events.schema.js';
import { closeDatabasePool } from '../db/index.js';
import { disconnectRedis } from '../redis/redis.client.js';

describe('Phase 5 - Step 4: Formal Agent -> Policy Integration Tests', () => {
  after(async () => {
    await disconnectRedis();
    await closeDatabasePool();
  });

  it('1. Happy Path (ALLOW): Agent 1 -> Agent 2 -> Policy Engine ALLOW -> Tool Execution -> Recovered Outcome', async () => {
    const customer = await findOrCreateCustomer({
      name: 'Priya Patel',
      email: `priya.${Date.now()}@example.com`,
      phone: '+919876543222',
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 2499.00,
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'bank_outage',
      attemptCount: 1,
      metadata: { testId: 'integration_happy_path' },
    });

    const result = await RecoveryOrchestrator.orchestrateRecovery({
      transaction,
      customer,
      customerStats: { previousSuccesses: 3, previousFailures: 0, previousRecoverySuccess: true },
    });

    // 1. Policy Decision Verification
    assert.strictEqual(result.policyResult.decision, POLICY_DECISIONS.ALLOW, 'Policy should ALLOW standard recovery');
    assert.strictEqual(result.decision.status, 'executed');
    assert.strictEqual(result.outcomeStatus, OUTCOME_TYPES.RECOVERED);
    assert.strictEqual(result.outcomeEventType, EVENT_TYPES.RECOVERY_COMPLETED);

    // 2. Tool Execution Verification
    assert.ok(result.executionResult, 'Tool must be executed for ALLOW');
    assert.strictEqual(result.executionResult.success, true);

    // 3. Database Persistence & Audit Separation Verification
    const savedDecision = await getDecisionById(result.decision.id);
    assert.ok(savedDecision, 'Decision must be persisted in PostgreSQL');
    
    const auditData = savedDecision.decision.agentAnalystResponse;
    assert.ok(auditData.agent1, 'Agent 1 audit record must exist');
    assert.ok(auditData.agent1.recommendation, 'Agent 1 recommendation must be present');
    assert.ok(typeof auditData.agent1.confidence === 'number');

    assert.ok(auditData.agent2, 'Agent 2 audit record must exist');
    assert.ok(auditData.agent2.proposedAction, 'Agent 2 proposedAction must be present');
    assert.ok(typeof auditData.agent2.confidence === 'number');

    assert.ok(Array.isArray(auditData.appliedRules), 'Policy applied rules must be recorded');
    assert.ok(auditData.policyVersion, 'Policy version must be recorded');
    assert.ok(auditData.evaluatedAt, 'Policy evaluation timestamp must be recorded');

    // 4. Linked Action Record in DB
    const actions = await getActionsByDecisionId(result.decision.id);
    assert.ok(actions.length > 0, 'Action record must be created and linked');
    assert.strictEqual(actions[0].status, 'success');
  });

  it('2. High-Value Payment (REQUIRE_APPROVAL): Policy Engine enforces limit; Tool execution is strictly BLOCKED/SKIPPED', async () => {
    const customer = await findOrCreateCustomer({
      name: 'High Net Worth Enterprise',
      email: `enterprise.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 85000.00, // Exceeds ₹50,000 threshold
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'insufficient_funds',
      attemptCount: 1,
    });

    const result = await RecoveryOrchestrator.orchestrateRecovery({
      transaction,
      customer,
      customerStats: { previousSuccesses: 10 },
      options: {
        agent2Proposal: {
          agentName: 'RecoveryExecutor',
          agentVersion: 'v1.0',
          proposedAction: 'attempt_recovery',
          parameters: {},
          confidence: 0.99, // Extremely confident agent
          rationale: 'High confidence automated retry',
          reasonCodes: ['VIP_CUSTOMER'],
        },
      },
    });

    // 1. Policy Gate Verification: Must REQUIRE_APPROVAL despite Agent confidence 0.99
    assert.strictEqual(result.policyResult.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
    assert.ok(result.policyResult.appliedRules.includes(RULE_IDS.MAX_AMOUNT_CEILING));
    assert.strictEqual(result.decision.status, 'pending_review');
    assert.strictEqual(result.outcomeStatus, OUTCOME_TYPES.PENDING_REVIEW);

    // 2. Strict Tool Execution Gate: No execution must occur
    assert.strictEqual(result.executionResult, null, 'Tool MUST NOT execute when Policy is REQUIRE_APPROVAL');

    // 3. Database Persistence Verification
    const savedDecision = await getDecisionById(result.decision.id);
    assert.strictEqual(savedDecision.decision.status, 'pending_review');
    assert.strictEqual(savedDecision.decision.guardrailResult, 'REQUIRE_APPROVAL');
  });

  it('3. Fraud Risk Payment (BLOCK): Policy Engine enforces fraud block; Tool execution is strictly BLOCKED', async () => {
    const customer = await findOrCreateCustomer({
      name: 'Suspicious Actor',
      email: `suspicious.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 1500.00,
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'high_risk_fraud',
      attemptCount: 1,
    });

    const result = await RecoveryOrchestrator.orchestrateRecovery({
      transaction,
      customer,
    });

    // 1. Policy Gate Verification: Must BLOCK
    assert.strictEqual(result.policyResult.decision, POLICY_DECISIONS.BLOCK);
    assert.ok(result.policyResult.appliedRules.includes(RULE_IDS.FRAUD_BLOCK));
    assert.strictEqual(result.decision.status, 'blocked');
    assert.strictEqual(result.outcomeStatus, OUTCOME_TYPES.BLOCKED);

    // 2. Strict Tool Execution Gate: No execution must occur
    assert.strictEqual(result.executionResult, null, 'Tool MUST NOT execute when Policy is BLOCK');

    // 3. Database Persistence Verification
    const savedDecision = await getDecisionById(result.decision.id);
    assert.strictEqual(savedDecision.decision.status, 'blocked');
    assert.strictEqual(savedDecision.decision.guardrailResult, 'BLOCK');
  });

  it('4. Parameter Sanitization: Agent 2 unauthorized parameters are stripped before Policy Engine and Execution', async () => {
    const customer = await findOrCreateCustomer({
      name: 'Sanitization Test',
      email: `sanitize.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 999.00,
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'card_expired',
      attemptCount: 1,
    });

    const result = await RecoveryOrchestrator.orchestrateRecovery({
      transaction,
      customer,
      options: {
        agent2Proposal: {
          agentName: 'RecoveryExecutor',
          agentVersion: 'v1.0',
          proposedAction: 'send_recovery_message',
          parameters: {
            channel: 'email',
            templateId: 'card_update_v1',
            customMessage: 'Please update your card',
            unauthorizedKey: 'malicious_payload',
            adminOverride: true,
            bypassChecks: true,
          },
          confidence: 0.88,
          rationale: 'Sending customer update email with attempted parameter injection',
          reasonCodes: ['CARD_EXPIRED'],
        },
      },
    });

    assert.strictEqual(result.policyResult.decision, POLICY_DECISIONS.ALLOW);
    const auditData = result.decision.agentAnalystResponse;

    // Verify sanitized parameters in Agent 2 proposal and decision record
    assert.strictEqual(auditData.agent2.parameters.channel, 'email');
    assert.strictEqual(auditData.agent2.parameters.templateId, 'card_update_v1');
    assert.strictEqual(auditData.agent2.parameters.unauthorizedKey, undefined, 'Unauthorized key must be stripped');
    assert.strictEqual(auditData.agent2.parameters.adminOverride, undefined, 'Admin override key must be stripped');
    assert.strictEqual(auditData.agent2.parameters.bypassChecks, undefined, 'Bypass check key must be stripped');
  });

  it('5. Agent Confidence Independence: Even 1.0 confidence cannot bypass policy guardrails', async () => {
    const customer = await findOrCreateCustomer({
      name: 'Confidence Bypass Test',
      email: `confidence.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 99999.00, // Very high amount
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'insufficient_funds',
      attemptCount: 1,
    });

    const result = await RecoveryOrchestrator.orchestrateRecovery({
      transaction,
      customer,
      options: {
        agent1Analysis: {
          agentName: 'RecoveryAnalyst',
          agentVersion: 'v1.0',
          recommendation: 'attempt_recovery',
          confidence: 1.0,
          rationale: 'Maximum possible confidence recommendation',
          reasonCodes: ['MAX_CONFIDENCE'],
        },
        agent2Proposal: {
          agentName: 'RecoveryExecutor',
          agentVersion: 'v1.0',
          proposedAction: 'attempt_recovery',
          parameters: {},
          confidence: 1.0,
          rationale: 'Maximum possible confidence proposal',
          reasonCodes: ['MAX_CONFIDENCE'],
        },
      },
    });

    // Policy Engine MUST override agent confidence 1.0
    assert.strictEqual(result.policyResult.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
    assert.strictEqual(result.decision.status, 'pending_review');
    assert.strictEqual(result.executionResult, null, 'Execution must remain blocked');
  });

  it('6. Fallback Behavior: Safe fallback recommendations on agent error/timeout are still evaluated by Policy Engine', async () => {
    const customer = await findOrCreateCustomer({
      name: 'Fallback Pipeline Test',
      email: `fallback.${Date.now()}@example.com`,
    });

    // Create a high-value transaction
    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 60000.00, // Exceeds threshold
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'insufficient_funds',
      attemptCount: 1,
    });

    // Trigger fallback by passing an unreachable agent endpoint
    const result = await RecoveryOrchestrator.orchestrateRecovery({
      transaction,
      customer,
      options: {
        agent1Options: { timeoutMs: 1 },
        agent2Options: { timeoutMs: 1 },
      },
    });

    // Verify fallbacks were generated
    assert.strictEqual(result.agent1Analysis.isFallback, true);
    assert.strictEqual(result.agent2Proposal.isFallback, true);

    // Crucial safety check: Fallback did NOT bypass Policy Engine
    assert.strictEqual(result.policyResult.decision, POLICY_DECISIONS.REQUIRE_APPROVAL);
    assert.strictEqual(result.decision.status, 'pending_review');
    assert.strictEqual(result.executionResult, null);
  });

  it('7. Complete Outcome Event Payload contains full provenance and tracing metadata', async () => {
    const customer = await findOrCreateCustomer({
      name: 'Provenance Test',
      email: `provenance.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 1500.00,
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'network_timeout',
      attemptCount: 1,
    });

    const originalEventId = crypto.randomUUID();
    const result = await RecoveryOrchestrator.orchestrateRecovery({
      transaction,
      customer,
      originalEventId,
    });

    const outcome = result.outcomePayload;
    assert.ok(outcome.eventId, 'Outcome eventId must be present');
    assert.strictEqual(outcome.transactionId, transaction.id);
    assert.strictEqual(outcome.customerId, customer.id);
    assert.strictEqual(outcome.details.originalEventId, originalEventId);
    assert.ok(outcome.details.guardrailDecision);
    assert.ok(Array.isArray(outcome.details.appliedRules));
    assert.ok(outcome.details.agent1Recommendation);
    assert.ok(outcome.details.agent2ProposedAction);
    assert.ok(typeof outcome.details.agentConfidence === 'number');
    assert.ok(typeof outcome.details.mlScore === 'number');
  });
});
