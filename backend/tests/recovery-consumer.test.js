import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import {
  processPaymentMessage,
  startRecoveryConsumer,
  stopRecoveryConsumer,
} from '../kafka/consumers/recovery.consumer.js';
import { publishPaymentEvent } from '../kafka/producer.js';
import {
  EVENT_TYPES,
  OUTCOME_TYPES,
  serializeEvent,
  deserializeEvent,
  PaymentEventSchema,
} from '../kafka/schemas/events.schema.js';
import {
  initKafkaTopics,
  createConsumer,
  disconnectKafka,
} from '../kafka/kafka.client.js';
import { config } from '../services/config/index.js';
import { findOrCreateCustomer } from '../db/queries/customers.queries.js';
import { createTransaction, getTransactionById } from '../db/queries/transactions.queries.js';
import { getDecisionById } from '../db/queries/decisions.queries.js';
import { disconnectRedis } from '../redis/redis.client.js';
import { closeDatabasePool } from '../db/index.js';

describe('Step 4: Recovery Consumer & Pipeline Integration Tests', () => {
  before(async () => {
    await initKafkaTopics();
  });

  after(async () => {
    await stopRecoveryConsumer();
    await disconnectKafka();
    await disconnectRedis();
    await closeDatabasePool();
  });

  it('1. should process a valid payment failure event through ML, Guardrails, and Tool execution', async () => {
    // Setup Customer & Transaction in PostgreSQL
    const customer = await findOrCreateCustomer({
      name: 'Rohan Sharma',
      email: `rohan.${Date.now()}@example.com`,
      phone: '+919876543210',
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 4999.00,
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'insufficient_funds',
      attemptCount: 1,
      metadata: { test: 'recovery_pipeline_test' },
    });

    const eventId = crypto.randomUUID();
    const eventPayload = {
      eventId,
      eventType: EVENT_TYPES.PAYMENT_FAILED,
      occurredAt: new Date().toISOString(),
      transactionId: transaction.id,
      customerId: customer.id,
      payload: {
        amount: 4999.00,
        currency: 'INR',
        paymentMethod: 'card',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
        metadata: { test: 'recovery_pipeline_test' },
      },
      version: 1,
    };

    const mockMessage = {
      value: Buffer.from(JSON.stringify(eventPayload), 'utf-8'),
      offset: '0',
    };

    const result = await processPaymentMessage({
      topic: config.kafka.paymentEventsTopic,
      partition: 0,
      message: mockMessage,
      consumer: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.transactionId, transaction.id);
    assert.ok(result.decisionId, 'Decision record must be created');
    assert.strictEqual(result.guardrailDecision, 'ALLOW');

    // Verify Decision in PostgreSQL with ML Score and reasons
    const decisionRecord = await getDecisionById(result.decisionId);
    assert.ok(decisionRecord, 'Decision must be persisted in DB');
    assert.ok(decisionRecord.decision.mlScore !== null, 'ML score must be saved');
    assert.strictEqual(decisionRecord.decision.status, 'executed');
  });

  it('2. should preserve REQUIRE_APPROVAL guardrail state for high amount transactions without tool execution', async () => {
    const customer = await findOrCreateCustomer({
      name: 'High Value Merchant',
      email: `highvalue.${Date.now()}@example.com`,
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

    const eventId = crypto.randomUUID();
    const eventPayload = {
      eventId,
      eventType: EVENT_TYPES.PAYMENT_FAILED,
      occurredAt: new Date().toISOString(),
      transactionId: transaction.id,
      customerId: customer.id,
      payload: {
        amount: 75000.00,
        currency: 'INR',
        paymentMethod: 'card',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      },
      version: 1,
    };

    const mockMessage = {
      value: Buffer.from(JSON.stringify(eventPayload), 'utf-8'),
      offset: '1',
    };

    const result = await processPaymentMessage({
      topic: config.kafka.paymentEventsTopic,
      partition: 0,
      message: mockMessage,
      consumer: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.guardrailDecision, 'REQUIRE_APPROVAL');
    assert.strictEqual(result.outcome, OUTCOME_TYPES.PENDING_REVIEW);
    assert.strictEqual(result.executionResult, null, 'Tool must NOT be executed for REQUIRE_APPROVAL');

    const decisionRecord = await getDecisionById(result.decisionId);
    assert.strictEqual(decisionRecord.decision.status, 'pending_review');
  });

  it('3. should reject invalid event schema gracefully without throwing unhandled exceptions', async () => {
    const invalidMessage = {
      value: Buffer.from(JSON.stringify({ invalid: 'schema', missing: 'everything' }), 'utf-8'),
      offset: '2',
    };

    const result = await processPaymentMessage({
      topic: config.kafka.paymentEventsTopic,
      partition: 0,
      message: invalidMessage,
      consumer: null,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.ok(Array.isArray(result.validationErrors));
  });

  it('4. should prevent duplicate recovery actions when the same eventId is delivered more than once', async () => {
    const customer = await findOrCreateCustomer({
      name: 'Duplicate Test Customer',
      email: `dupe.${Date.now()}@example.com`,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 1999.00,
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'card_expired',
    });

    const eventId = crypto.randomUUID();
    const eventPayload = {
      eventId,
      eventType: EVENT_TYPES.PAYMENT_FAILED,
      occurredAt: new Date().toISOString(),
      transactionId: transaction.id,
      customerId: customer.id,
      payload: {
        amount: 1999.00,
        currency: 'INR',
        paymentMethod: 'card',
        failureReason: 'card_expired',
        attemptCount: 1,
      },
      version: 1,
    };

    const mockMessage = {
      value: Buffer.from(JSON.stringify(eventPayload), 'utf-8'),
      offset: '3',
    };

    // First delivery: processes successfully
    const firstResult = await processPaymentMessage({
      topic: config.kafka.paymentEventsTopic,
      partition: 0,
      message: mockMessage,
      consumer: null,
    });
    assert.strictEqual(firstResult.success, true);
    assert.strictEqual(firstResult.skipped, undefined);

    // Second delivery of same eventId: skipped via idempotency check
    const secondResult = await processPaymentMessage({
      topic: config.kafka.paymentEventsTopic,
      partition: 0,
      message: mockMessage,
      consumer: null,
    });
    assert.strictEqual(secondResult.success, true);
    assert.strictEqual(secondResult.skipped, true);
    assert.strictEqual(secondResult.reason, 'duplicate_event_id');
  });

  it('5. End-to-End Integration: Real event published to payment-events -> consumed by RecoveryConsumer -> published to recovery-outcomes', async () => {
    // 1. Create DB customer and transaction
    const customer = await findOrCreateCustomer({
      name: 'E2E Integration User',
      email: `e2e.${Date.now()}@example.com`,
      phone: '+919123456780',
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount: 2499.00,
      currency: 'INR',
      paymentMethod: 'card',
      status: 'failed',
      failureReason: 'bank_outage',
      attemptCount: 1,
    });

    // 2. Setup a test consumer listening on recovery-outcomes topic
    const outcomeConsumer = createConsumer({ groupId: `test-outcome-listener-${Date.now()}` });
    await outcomeConsumer.connect();
    await outcomeConsumer.subscribe({ topic: config.kafka.recoveryOutcomesTopic, fromBeginning: true });

    // 3. Start the real Recovery Worker Consumer
    const recoveryWorker = await startRecoveryConsumer({ groupId: `test-rec-worker-${Date.now()}`, fromBeginning: true });
    assert.ok(recoveryWorker, 'Recovery consumer should be running');

    const targetEventId = crypto.randomUUID();
    let receivedOutcome = null;

    const outcomePromise = new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for outcome event on recovery-outcomes topic'));
      }, 12000);

      await outcomeConsumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const deserialized = deserializeEvent(message.value);
          if (deserialized.success && deserialized.data.transactionId === transaction.id) {
            receivedOutcome = deserialized.data;
            clearTimeout(timer);
            resolve(receivedOutcome);
          }
        },
      });
    });

    // 4. Publish live event to payment-events
    const paymentEvent = {
      eventId: targetEventId,
      eventType: EVENT_TYPES.PAYMENT_FAILED,
      occurredAt: new Date().toISOString(),
      transactionId: transaction.id,
      customerId: customer.id,
      payload: {
        amount: 2499.00,
        currency: 'INR',
        paymentMethod: 'card',
        failureReason: 'bank_outage',
        attemptCount: 1,
        metadata: { e2eTest: true },
      },
      version: 1,
    };

    await publishPaymentEvent(paymentEvent);

    // 5. Await outcome on recovery-outcomes topic
    const outcome = await outcomePromise;
    await outcomeConsumer.stop();
    await outcomeConsumer.disconnect();
    await recoveryWorker.stop();
    await recoveryWorker.disconnect();

    assert.ok(outcome, 'Outcome event must be received');
    assert.strictEqual(outcome.transactionId, transaction.id);
    assert.strictEqual(outcome.details.originalEventId, targetEventId);
    assert.ok(outcome.caseId, 'caseId / decisionId must be present');
    assert.ok(outcome.outcome, 'outcome status must be defined');

    // Verify Decision record created in PostgreSQL
    const decisionRecord = await getDecisionById(outcome.caseId);
    assert.ok(decisionRecord, 'Decision record must exist in PostgreSQL');
    assert.strictEqual(decisionRecord.transaction.id, transaction.id);
  });
});
