import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { EventProducerService } from '../services/ingestion/event-producer.service.js';
import { publishPaymentEvent, publishOutcomeEvent, publishDeadLetterEvent } from '../kafka/producer.js';
import {
  EVENT_TYPES,
  OUTCOME_TYPES,
  validatePaymentEvent,
  validateOutcomeEvent,
  validateDeadLetterEvent,
  deserializeEvent,
} from '../kafka/schemas/events.schema.js';
import {
  getProducer,
  createConsumer,
  initKafkaTopics,
  disconnectKafka,
} from '../kafka/kafka.client.js';
import { config } from '../services/config/index.js';
import { getTransactionById } from '../db/queries/transactions.queries.js';
import { getDecisionById } from '../db/queries/decisions.queries.js';

import { disconnectRedis } from '../redis/redis.client.js';
import { closeDatabasePool } from '../db/index.js';

describe('Step 3: Kafka Producer & Decoupled Ingestion Tests', () => {
  before(async () => {
    await initKafkaTopics();
  });

  after(async () => {
    await disconnectKafka();
    await disconnectRedis();
    await closeDatabasePool();
  });

  it('1. should publish a valid payment event to Kafka payment-events topic', async () => {
    const rawEvent = {
      eventId: crypto.randomUUID(),
      eventType: EVENT_TYPES.PAYMENT_FAILED,
      occurredAt: new Date().toISOString(),
      transactionId: `txn_test_${Date.now()}`,
      customerId: `cust_test_${Date.now()}`,
      payload: {
        amount: 4999.00,
        currency: 'INR',
        paymentMethod: 'card',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
        metadata: { source: 'producer_unit_test' },
      },
      version: 1,
    };

    const result = await publishPaymentEvent(rawEvent);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.topic, config.kafka.paymentEventsTopic);
    assert.strictEqual(result.eventId, rawEvent.eventId);
    assert.strictEqual(result.transactionId, rawEvent.transactionId);
    assert.strictEqual(typeof result.partition, 'number');
  });

  it('2. should reject invalid payment event before producing to Kafka', async () => {
    const invalidEvent = {
      eventId: crypto.randomUUID(),
      eventType: EVENT_TYPES.PAYMENT_FAILED,
      occurredAt: new Date().toISOString(),
      transactionId: 'txn_invalid_1',
      customerId: 'cust_invalid_1',
      payload: {
        amount: -100, // Invalid: negative
        paymentMethod: 'invalid_method', // Invalid method
        failureReason: 'insufficient_funds',
      },
    };

    await assert.rejects(
      async () => publishPaymentEvent(invalidEvent),
      (err) => {
        assert.ok(err.message.includes('Payment event validation failed'));
        assert.ok(Array.isArray(err.validationErrors));
        return true;
      }
    );
  });

  it('3. should ingest failure, persist to PostgreSQL, and publish to Kafka (EventProducerService)', async () => {
    const uniqueEmail = `test.user.${Date.now()}@example.com`;
    const input = {
      customer: {
        name: 'Test Kafka User',
        email: uniqueEmail,
        phone: '+919988776655',
      },
      amount: 3499.00,
      currency: 'INR',
      paymentMethod: 'upi',
      failureReason: 'bank_outage',
      attemptCount: 1,
      metadata: { testRunner: 'node_test' },
    };

    const response = await EventProducerService.ingestAndPublishPaymentFailure(input);

    assert.strictEqual(response.success, true);
    assert.strictEqual(response.status, 'queued');
    assert.ok(response.eventId, 'Should have eventId');
    assert.ok(response.transactionId, 'Should have transactionId');
    assert.strictEqual(response.topic, config.kafka.paymentEventsTopic);

    // Verify PostgreSQL transaction record exists
    const dbTx = await getTransactionById(response.transactionId);
    assert.ok(dbTx, 'Transaction record must exist in PostgreSQL');
    assert.strictEqual(dbTx.transaction.status, 'failed');
    assert.strictEqual(parseFloat(dbTx.transaction.amount), 3499.00);

    // Verify synchronous decision record was NOT created (decoupled!)
    // Note: No decision record should exist at ingestion time
    assert.strictEqual(response.decision, undefined);
  });

  it('4. should handle duplicate events via idempotency check without duplicate Kafka publish', async () => {
    const idempotencyKey = `idemp_test_${Date.now()}`;
    const input = {
      customer: {
        name: 'Idempotency User',
        email: `idemp.${Date.now()}@example.com`,
      },
      amount: 1999.00,
      paymentMethod: 'card',
      failureReason: 'card_expired',
      idempotencyKey,
    };

    // First call: succeeds and queues
    const firstCall = await EventProducerService.ingestAndPublishPaymentFailure(input);
    assert.strictEqual(firstCall.success, true);
    assert.strictEqual(firstCall.status, 'queued');

    // Second call with same idempotency key: returns duplicate status safely
    const secondCall = await EventProducerService.ingestAndPublishPaymentFailure(input);
    assert.strictEqual(secondCall.success, true);
    assert.strictEqual(secondCall.isDuplicate, true);
    assert.strictEqual(secondCall.status, 'duplicate');
  });

  it('5. should verify that produced Kafka message matches the Zod PaymentEventSchema exactly', async () => {
    const targetEventId = crypto.randomUUID();
    const paymentEvent = {
      eventId: targetEventId,
      eventType: EVENT_TYPES.PAYMENT_FAILED,
      occurredAt: new Date().toISOString(),
      transactionId: `txn_contract_${Date.now()}`,
      customerId: `cust_contract_${Date.now()}`,
      payload: {
        amount: 8999.00,
        currency: 'INR',
        paymentMethod: 'subscription_mandate',
        failureReason: 'insufficient_funds',
        attemptCount: 2,
        metadata: { contractCheck: true },
      },
      version: 1,
    };

    // First publish the event to Kafka
    const publishRes = await publishPaymentEvent(paymentEvent);
    assert.strictEqual(publishRes.success, true);

    // Now consume and verify with a dedicated test consumer
    const consumer = createConsumer({ groupId: `test-contract-verify-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: config.kafka.paymentEventsTopic, fromBeginning: true });

    let messageReceived = null;

    await new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for Kafka message consumption'));
      }, 10000);

      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const deserialized = deserializeEvent(message.value);
          if (deserialized.success && deserialized.data.eventId === targetEventId) {
            messageReceived = deserialized.data;
            clearTimeout(timer);
            resolve();
          }
        },
      });
    });

    await consumer.stop();
    await consumer.disconnect();

    assert.ok(messageReceived, 'Message must be received from Kafka');
    assert.strictEqual(messageReceived.eventId, targetEventId);

    // Validate the received message against Zod schema
    const validation = validatePaymentEvent(messageReceived);
    assert.strictEqual(validation.success, true, 'Received message must satisfy Zod PaymentEventSchema');
    assert.strictEqual(validation.data.payload.amount, 8999.00);

    // Verify NO customer PII is present in the Kafka message
    assert.strictEqual(messageReceived.name, undefined);
    assert.strictEqual(messageReceived.email, undefined);
    assert.strictEqual(messageReceived.phone, undefined);
    assert.strictEqual(messageReceived.customer, undefined);
  });
});
