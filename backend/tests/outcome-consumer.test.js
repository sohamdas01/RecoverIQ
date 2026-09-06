import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import {
  processOutcomeMessage,
  startOutcomeConsumer,
  stopOutcomeConsumer,
} from '../kafka/consumers/outcome.consumer.js';
import { publishOutcomeEvent } from '../kafka/producer.js';
import {
  EVENT_TYPES,
  OUTCOME_TYPES,
  deserializeEvent,
} from '../kafka/schemas/events.schema.js';
import {
  initKafkaTopics,
  createConsumer,
  disconnectKafka,
} from '../kafka/kafka.client.js';
import { config } from '../services/config/index.js';
import { findOrCreateCustomer } from '../db/queries/customers.queries.js';
import { createTransaction, getTransactionById } from '../db/queries/transactions.queries.js';
import { createDecision, getDecisionById } from '../db/queries/decisions.queries.js';
import { createAction, getActionsByDecisionId } from '../db/queries/actions.queries.js';
import { getMessagesByTransactionId } from '../db/queries/messages.queries.js';
import { disconnectRedis } from '../redis/redis.client.js';
import { closeDatabasePool } from '../db/index.js';

describe('Step 5: Outcome Consumer & Atomic PostgreSQL Reconciliation Tests', () => {
  before(async () => {
    await initKafkaTopics();
  });

  after(async () => {
    await stopOutcomeConsumer();
    await disconnectKafka();
    await disconnectRedis();
    await closeDatabasePool();
  });

  it('1. should atomically reconcile a successful recovery.completed outcome event', async () => {
    // Setup Customer, Transaction, Decision, and Action in DB
    const customer = await findOrCreateCustomer({
      name: 'Ananya Iyer',
      email: `ananya.outcome.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 4999.00,
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'bank_outage',
    });

    const decision = await createDecision({
      transactionId: transaction.id,
      recommendedAction: 'attempt_recovery',
      guardrailResult: 'ALLOW',
      status: 'executed',
      reasoning: 'Transient network glitch; immediate retry allowed',
    });

    const action = await createAction({
      decisionId: decision.id,
      toolName: 'attempt_recovery',
      toolParams: { amount: 4999.00 },
      status: 'pending',
    });

    const eventId = crypto.randomUUID();
    const outcomePayload = {
      eventId,
      eventType: EVENT_TYPES.RECOVERY_COMPLETED,
      occurredAt: new Date().toISOString(),
      transactionId: transaction.id,
      caseId: decision.id,
      customerId: customer.id,
      outcome: OUTCOME_TYPES.RECOVERED,
      toolName: 'attempt_recovery',
      recoveredAmount: 4999.00,
      currency: 'INR',
      details: {
        gatewayResponse: 'PAYMENT_CAPTURED',
        retryAttempt: 1,
      },
      version: 1,
    };

    const mockMessage = {
      value: Buffer.from(JSON.stringify(outcomePayload), 'utf-8'),
      offset: '0',
    };

    const result = await processOutcomeMessage({
      topic: config.kafka.recoveryOutcomesTopic,
      partition: 0,
      message: mockMessage,
      consumer: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.newState.transactionStatus, 'recovered');

    // Verify PostgreSQL Atomic Updates
    const updatedTx = await getTransactionById(transaction.id);
    assert.strictEqual(updatedTx.transaction.status, 'recovered');
    assert.strictEqual(updatedTx.transaction.metadata.recoveredAmount, 4999.00);
    assert.strictEqual(updatedTx.transaction.metadata.lastOutcomeEventId, eventId);

    const updatedDecision = await getDecisionById(decision.id);
    assert.strictEqual(updatedDecision.decision.status, 'executed');

    const updatedActions = await getActionsByDecisionId(decision.id);
    assert.strictEqual(updatedActions[0].status, 'success');
    assert.strictEqual(updatedActions[0].result.outcome, 'recovered');

    const messagesList = await getMessagesByTransactionId(transaction.id);
    assert.ok(messagesList.length > 0);
    assert.strictEqual(messagesList[0].eventTaken, 'resolved');
  });

  it('2. should atomically reconcile a failed recovery outcome event', async () => {
    const customer = await findOrCreateCustomer({
      name: 'Failed Recovery User',
      email: `failed.outcome.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 1999.00,
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'insufficient_funds',
    });

    const decision = await createDecision({
      transactionId: transaction.id,
      recommendedAction: 'attempt_recovery',
      guardrailResult: 'ALLOW',
      status: 'executed',
      reasoning: 'Retry attempted',
    });

    const action = await createAction({
      decisionId: decision.id,
      toolName: 'attempt_recovery',
      status: 'pending',
    });

    const eventId = crypto.randomUUID();
    const outcomePayload = {
      eventId,
      eventType: EVENT_TYPES.RECOVERY_FAILED,
      occurredAt: new Date().toISOString(),
      transactionId: transaction.id,
      caseId: decision.id,
      customerId: customer.id,
      outcome: OUTCOME_TYPES.FAILED,
      toolName: 'attempt_recovery',
      details: { error: 'Bank declined capture' },
      version: 1,
    };

    const mockMessage = {
      value: Buffer.from(JSON.stringify(outcomePayload), 'utf-8'),
      offset: '1',
    };

    const result = await processOutcomeMessage({
      topic: config.kafka.recoveryOutcomesTopic,
      partition: 0,
      message: mockMessage,
      consumer: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.newState.transactionStatus, 'failed');
    assert.strictEqual(result.newState.actionStatus, 'failed');

    const updatedTx = await getTransactionById(transaction.id);
    assert.strictEqual(updatedTx.transaction.status, 'failed');

    const updatedActions = await getActionsByDecisionId(decision.id);
    assert.strictEqual(updatedActions[0].status, 'failed');
  });

  it('3. should atomically reconcile an escalated recovery outcome event', async () => {
    const customer = await findOrCreateCustomer({
      name: 'Fraud Suspect',
      email: `fraud.outcome.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 95000.00,
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'high_risk_fraud',
    });

    const decision = await createDecision({
      transactionId: transaction.id,
      recommendedAction: 'escalate_to_human',
      guardrailResult: 'ALLOW',
      status: 'executed',
      reasoning: 'Fraud risk flagged',
    });

    const eventId = crypto.randomUUID();
    const outcomePayload = {
      eventId,
      eventType: EVENT_TYPES.RECOVERY_ESCALATED,
      occurredAt: new Date().toISOString(),
      transactionId: transaction.id,
      caseId: decision.id,
      customerId: customer.id,
      outcome: OUTCOME_TYPES.ESCALATED,
      toolName: 'escalate_to_human',
      details: { ticketId: 'TICK-999', priority: 'urgent' },
      version: 1,
    };

    const mockMessage = {
      value: Buffer.from(JSON.stringify(outcomePayload), 'utf-8'),
      offset: '2',
    };

    const result = await processOutcomeMessage({
      topic: config.kafka.recoveryOutcomesTopic,
      partition: 0,
      message: mockMessage,
      consumer: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.newState.transactionStatus, 'escalated');

    const updatedTx = await getTransactionById(transaction.id);
    assert.strictEqual(updatedTx.transaction.status, 'escalated');

    const messagesList = await getMessagesByTransactionId(transaction.id);
    assert.ok(messagesList.some((m) => m.eventTaken === 'escalated'));
  });

  it('4. should reject invalid outcome event schema gracefully without throwing', async () => {
    const invalidMessage = {
      value: Buffer.from(JSON.stringify({ invalid: 'outcome', caseId: 'missing_fields' }), 'utf-8'),
      offset: '3',
    };

    const result = await processOutcomeMessage({
      topic: config.kafka.recoveryOutcomesTopic,
      partition: 0,
      message: invalidMessage,
      consumer: null,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.ok(Array.isArray(result.validationErrors));
  });

  it('5. should prevent duplicate outcome processing when the same eventId is delivered more than once', async () => {
    const customer = await findOrCreateCustomer({
      name: 'Duplicate Outcome Customer',
      email: `dupe.outcome.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 2999.00,
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'bank_outage',
    });

    const decision = await createDecision({
      transactionId: transaction.id,
      recommendedAction: 'attempt_recovery',
      guardrailResult: 'ALLOW',
      status: 'executed',
      reasoning: 'Retry allowed',
    });

    const eventId = crypto.randomUUID();
    const outcomePayload = {
      eventId,
      eventType: EVENT_TYPES.RECOVERY_COMPLETED,
      occurredAt: new Date().toISOString(),
      transactionId: transaction.id,
      caseId: decision.id,
      customerId: customer.id,
      outcome: OUTCOME_TYPES.RECOVERED,
      toolName: 'attempt_recovery',
      recoveredAmount: 2999.00,
      currency: 'INR',
      version: 1,
    };

    const mockMessage = {
      value: Buffer.from(JSON.stringify(outcomePayload), 'utf-8'),
      offset: '4',
    };

    // First processing
    const first = await processOutcomeMessage({
      topic: config.kafka.recoveryOutcomesTopic,
      partition: 0,
      message: mockMessage,
      consumer: null,
    });
    assert.strictEqual(first.success, true);
    assert.strictEqual(first.skipped, undefined);

    // Duplicate processing
    const second = await processOutcomeMessage({
      topic: config.kafka.recoveryOutcomesTopic,
      partition: 0,
      message: mockMessage,
      consumer: null,
    });
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.skipped, true);
    assert.strictEqual(second.reason, 'duplicate_event_id');
  });

  it('6. End-to-End Integration: Real outcome published to recovery-outcomes -> consumed by OutcomeConsumer -> reconciled in PostgreSQL', async () => {
    // 1. Setup DB state
    const customer = await findOrCreateCustomer({
      name: 'E2E Outcome User',
      email: `e2e.outcome.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 3499.00,
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'network_timeout',
    });

    const decision = await createDecision({
      transactionId: transaction.id,
      recommendedAction: 'attempt_recovery',
      guardrailResult: 'ALLOW',
      status: 'executed',
      reasoning: 'Transient network glitch recovered',
    });

    // 2. Start dedicated Outcome Worker Consumer
    const outcomeWorker = await startOutcomeConsumer({
      groupId: `test-outcome-worker-${Date.now()}`,
      fromBeginning: true,
    });
    assert.ok(outcomeWorker, 'Outcome consumer should be running');

    const targetEventId = crypto.randomUUID();

    // 3. Publish real outcome event to recovery-outcomes
    const outcomeEvent = {
      eventId: targetEventId,
      eventType: EVENT_TYPES.RECOVERY_COMPLETED,
      occurredAt: new Date().toISOString(),
      transactionId: transaction.id,
      caseId: decision.id,
      customerId: customer.id,
      outcome: OUTCOME_TYPES.RECOVERED,
      toolName: 'attempt_recovery',
      recoveredAmount: 3499.00,
      currency: 'INR',
      details: { captureResult: 'live_test_capture' },
      version: 1,
    };

    await publishOutcomeEvent(outcomeEvent);

    // 4. Poll PostgreSQL until atomic reconciliation updates the record (with timeout)
    let reconciledTx = null;
    const startTime = Date.now();

    while (Date.now() - startTime < 10000) {
      const txCheck = await getTransactionById(transaction.id);
      if (txCheck && txCheck.transaction.status === 'recovered' && txCheck.transaction.metadata?.lastOutcomeEventId === targetEventId) {
        reconciledTx = txCheck;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    await outcomeWorker.stop();
    await outcomeWorker.disconnect();

    assert.ok(reconciledTx, 'Transaction status must be atomically updated to recovered by OutcomeConsumer');
    assert.strictEqual(reconciledTx.transaction.status, 'recovered');
    assert.strictEqual(reconciledTx.transaction.metadata.recoveredAmount, 3499.00);

    // Verify audit record in messages
    const auditMessages = await getMessagesByTransactionId(transaction.id);
    assert.ok(auditMessages.some((m) => m.eventTaken === 'resolved'));
  });
});
