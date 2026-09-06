import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { db, closeDatabasePool } from '../db/index.js';
import { customers, transactions, decisions } from '../../drizzle/schema.js';
import { eq } from 'drizzle-orm';
import { disconnectRedis } from '../redis/redis.client.js';
import {
  initKafkaTopics,
  disconnectKafka,
  createConsumer,
} from '../kafka/kafka.client.js';
import { config } from '../services/config/index.js';
import {
  isTransientError,
  classifyError,
  calculateBackoff,
  executeWithRetry,
  routeToDlq,
} from '../kafka/dlq.service.js';
import { processPaymentMessage } from '../kafka/consumers/recovery.consumer.js';
import { processOutcomeMessage } from '../kafka/consumers/outcome.consumer.js';
import { deserializeEvent } from '../kafka/schemas/events.schema.js';

describe('Step 6: Retry Handling & Dead-Letter Queue (DLQ) Tests', () => {
  let dlqConsumer;
  const receivedDlqEvents = [];

  before(async () => {
    await initKafkaTopics();

    // Start a test DLQ consumer to verify real DLQ publication to Kafka
    const groupId = `test-dlq-verifier-${Date.now()}`;
    dlqConsumer = createConsumer({ groupId });
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({
      topic: config.kafka.deadLetterTopic,
      fromBeginning: false,
    });

    dlqConsumer.run({
      autoCommit: true,
      eachMessage: async ({ message }) => {
        const deserialized = deserializeEvent(message.value);
        if (deserialized.success) {
          receivedDlqEvents.push(deserialized.data);
        }
      },
    });
  });

  after(async () => {
    if (dlqConsumer) {
      try {
        await dlqConsumer.stop();
        await dlqConsumer.disconnect();
      } catch (e) {}
    }
    await disconnectKafka();
    await disconnectRedis();
    await closeDatabasePool();
  });

  // 1. Error Classification & Transient Checks
  describe('1. Error Classification & Transient Detection', () => {
    it('should correctly identify transient errors (network, timeout, 5xx, DB lock)', () => {
      const connRefused = new Error('connect ECONNREFUSED 127.0.0.1:8000');
      connRefused.code = 'ECONNREFUSED';
      assert.strictEqual(isTransientError(connRefused), true);

      const timeoutErr = new Error('Request timed out after 5000ms');
      assert.strictEqual(isTransientError(timeoutErr), true);

      const http503 = new Error('Service Unavailable');
      http503.statusCode = 503;
      assert.strictEqual(isTransientError(http503), true);

      const pgDeadlock = new Error('deadlock detected');
      pgDeadlock.code = '40P01';
      assert.strictEqual(isTransientError(pgDeadlock), true);

      // Non-transient errors
      const zodErr = new Error('Validation failed');
      zodErr.name = 'ZodError';
      assert.strictEqual(isTransientError(zodErr), false);

      const syntaxErr = new SyntaxError('Unexpected token in JSON');
      assert.strictEqual(isTransientError(syntaxErr), false);
    });

    it('should classify error types into valid DLQ failure categories', () => {
      assert.strictEqual(classifyError(new SyntaxError('Unexpected token < in JSON at position 0')), 'poison_message');
      assert.strictEqual(classifyError(new Error('Event contract validation rejected: amount: Required')), 'schema_validation_error');
      assert.strictEqual(classifyError(new Error('Transaction txn_123 not found in PostgreSQL')), 'database_error');
      
      const exhausted = new Error('connect ECONNREFUSED');
      exhausted.code = 'ECONNREFUSED';
      exhausted.isExhausted = true;
      assert.strictEqual(classifyError(exhausted), 'transient_exhausted');
    });

    it('should calculate exponential backoff with jitter within bounded range', () => {
      const delay1 = calculateBackoff(1, { initialDelayMs: 100, backoffMultiplier: 2, jitter: false });
      assert.strictEqual(delay1, 100);

      const delay2 = calculateBackoff(2, { initialDelayMs: 100, backoffMultiplier: 2, jitter: false });
      assert.strictEqual(delay2, 200);

      const delay3 = calculateBackoff(3, { initialDelayMs: 100, backoffMultiplier: 2, jitter: false });
      assert.strictEqual(delay3, 400);

      // With jitter: within [0.5 * delay, 1.5 * delay]
      const jitterDelay = calculateBackoff(2, { initialDelayMs: 100, backoffMultiplier: 2, jitter: true });
      assert.ok(jitterDelay >= 100 && jitterDelay <= 300);
    });
  });

  // 2. Retry Logic Execution
  describe('2. executeWithRetry Logic', () => {
    it('should succeed on retry when a transient failure recovers on 2nd attempt', async () => {
      let attempts = 0;
      const result = await executeWithRetry(
        async (attempt) => {
          attempts = attempt;
          if (attempt === 1) {
            const err = new Error('Temporary gateway timeout');
            err.statusCode = 504;
            throw err;
          }
          return { recovered: true, attempt };
        },
        { maxRetries: 3, initialDelayMs: 20, backoffMultiplier: 1.5, jitter: false }
      );

      assert.strictEqual(attempts, 2);
      assert.strictEqual(result.recovered, true);
    });

    it('should not retry permanent validation errors and fail immediately on attempt 1', async () => {
      let attempts = 0;
      await assert.rejects(
        async () => {
          await executeWithRetry(
            async (attempt) => {
              attempts = attempt;
              const err = new Error('Zod validation failed: invalid currency');
              err.name = 'ZodError';
              throw err;
            },
            { maxRetries: 3, initialDelayMs: 20 }
          );
        },
        (err) => {
          assert.strictEqual(attempts, 1);
          assert.strictEqual(err.name, 'ZodError');
          return true;
        }
      );
    });

    it('should throw with isExhausted=true when transient retries exceed maxRetries', async () => {
      let attempts = 0;
      await assert.rejects(
        async () => {
          await executeWithRetry(
            async (attempt) => {
              attempts = attempt;
              const err = new Error('Database connection refused');
              err.code = 'ECONNREFUSED';
              throw err;
            },
            { maxRetries: 3, initialDelayMs: 10, backoffMultiplier: 1.5, jitter: false }
          );
        },
        (err) => {
          assert.strictEqual(attempts, 3);
          assert.strictEqual(err.retryCount, 3);
          assert.strictEqual(err.isExhausted, true);
          assert.strictEqual(err.failureType, 'transient_exhausted');
          return true;
        }
      );
    });
  });

  // 3. Recovery Consumer DLQ & Retry Scenarios
  describe('3. Recovery Consumer DLQ Scenarios', () => {
    it('should route malformed non-JSON payload to DLQ as poison_message and commit offset', async () => {
      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => {
          committedOffsets.push(...offsets);
        },
      };

      const result = await processPaymentMessage({
        topic: 'payment-events',
        partition: 0,
        message: {
          offset: '42',
          value: Buffer.from('NOT_A_VALID_JSON_{{{'),
          headers: {
            eventId: 'poison-evt-001',
            transactionId: 'txn-poison-001',
          },
        },
        consumer: mockConsumer,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.routedToDlq, true);
      assert.strictEqual(result.failureType, 'poison_message');
      assert.ok(result.dlqEventId);
      assert.strictEqual(committedOffsets.length, 1);
      assert.strictEqual(committedOffsets[0].offset, '43');
    });

    it('should route invalid schema event to DLQ as schema_validation_error and commit offset', async () => {
      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => {
          committedOffsets.push(...offsets);
        },
      };

      const invalidPayload = {
        eventId: crypto.randomUUID(),
        eventType: 'payment.failed',
        // Missing transactionId, customerId, and payload
      };

      const result = await processPaymentMessage({
        topic: 'payment-events',
        partition: 1,
        message: {
          offset: '88',
          value: Buffer.from(JSON.stringify(invalidPayload)),
        },
        consumer: mockConsumer,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.routedToDlq, true);
      assert.strictEqual(result.failureType, 'schema_validation_error');
      assert.ok(result.validationErrors.length > 0);
      assert.strictEqual(committedOffsets.length, 1);
      assert.strictEqual(committedOffsets[0].offset, '89');
    });

    it('should perform bounded rechecks for missing transaction before routing to DLQ as database_error', async () => {
      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => {
          committedOffsets.push(...offsets);
        },
      };

      const missingTxId = `txn-non-existent-${Date.now()}`;
      const validEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'payment.failed',
        occurredAt: new Date().toISOString(),
        transactionId: missingTxId,
        customerId: crypto.randomUUID(),
        payload: {
          amount: 2500,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
          attemptCount: 1,
        },
        version: 1,
      };

      const result = await processPaymentMessage({
        topic: 'payment-events',
        partition: 2,
        message: {
          offset: '105',
          value: Buffer.from(JSON.stringify(validEvent)),
        },
        consumer: mockConsumer,
        retryConfig: {
          entityRecheckRetries: 3,
          entityRecheckDelayMs: 10,
        },
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.routedToDlq, true);
      assert.strictEqual(result.failureType, 'database_error');
      assert.ok(result.error.includes('not found after bounded rechecks'));
      assert.strictEqual(committedOffsets.length, 1);
      assert.strictEqual(committedOffsets[0].offset, '106');
    });

    it('should succeed normally without DLQ routing when event and DB records are valid', async () => {
      const testEmail = `dlq.success.${Date.now()}@example.com`;
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'DLQ Success User',
          email: testEmail,
          phone: '+919876543210',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '1499.00',
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
          attemptCount: 1,
        })
        .returning();

      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => {
          committedOffsets.push(...offsets);
        },
      };

      const validEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'payment.failed',
        occurredAt: new Date().toISOString(),
        transactionId: tx.id,
        customerId: customer.id,
        payload: {
          amount: 1499,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
          attemptCount: 1,
        },
        version: 1,
      };

      const result = await processPaymentMessage({
        topic: 'payment-events',
        partition: 0,
        message: {
          offset: '200',
          value: Buffer.from(JSON.stringify(validEvent)),
        },
        consumer: mockConsumer,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.routedToDlq, undefined);
      assert.ok(result.decisionId);
      assert.strictEqual(committedOffsets.length, 1);
      assert.strictEqual(committedOffsets[0].offset, '201');
    });
  });

  // 4. Outcome Consumer DLQ & Retry Scenarios
  describe('4. Outcome Consumer DLQ Scenarios', () => {
    it('should route malformed outcome payload to DLQ and commit offset', async () => {
      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => {
          committedOffsets.push(...offsets);
        },
      };

      const result = await processOutcomeMessage({
        topic: 'recovery-outcomes',
        partition: 0,
        message: {
          offset: '500',
          value: Buffer.from('MALFORMED_OUTCOME_PAYLOAD_<<<'),
        },
        consumer: mockConsumer,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.routedToDlq, true);
      assert.strictEqual(result.failureType, 'poison_message');
      assert.strictEqual(committedOffsets.length, 1);
      assert.strictEqual(committedOffsets[0].offset, '501');
    });

    it('should route missing transaction/case outcome to DLQ after bounded rechecks', async () => {
      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => {
          committedOffsets.push(...offsets);
        },
      };

      const missingTxId = crypto.randomUUID();
      const missingCaseId = crypto.randomUUID();

      const invalidOutcome = {
        eventId: crypto.randomUUID(),
        eventType: 'recovery.completed',
        occurredAt: new Date().toISOString(),
        transactionId: missingTxId,
        caseId: missingCaseId,
        outcome: 'recovered',
        toolName: 'attempt_recovery',
        recoveredAmount: 500,
        currency: 'INR',
        version: 1,
      };

      const result = await processOutcomeMessage({
        topic: 'recovery-outcomes',
        partition: 1,
        message: {
          offset: '600',
          value: Buffer.from(JSON.stringify(invalidOutcome)),
        },
        consumer: mockConsumer,
        retryConfig: {
          entityRecheckRetries: 3,
          entityRecheckDelayMs: 10,
        },
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.routedToDlq, true);
      assert.strictEqual(result.failureType, 'database_error');
      assert.strictEqual(committedOffsets.length, 1);
      assert.strictEqual(committedOffsets[0].offset, '601');
    });

    it('should reconcile valid outcome atomically without DLQ routing', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'Outcome DLQ Test',
          email: `outcome.dlq.${Date.now()}@example.com`,
          phone: '+919876543211',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '3500.00',
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'upi',
          failureReason: 'network_timeout',
          attemptCount: 1,
        })
        .returning();

      const [decision] = await db
        .insert(decisions)
        .values({
          transactionId: tx.id,
          status: 'pending',
          recommendedAction: 'attempt_recovery',
          guardrailResult: 'ALLOW',
          reasoning: 'Automated test recovery decision',
        })
        .returning();

      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => {
          committedOffsets.push(...offsets);
        },
      };

      const validOutcome = {
        eventId: crypto.randomUUID(),
        eventType: 'recovery.completed',
        occurredAt: new Date().toISOString(),
        transactionId: tx.id,
        caseId: decision.id,
        customerId: customer.id,
        outcome: 'recovered',
        toolName: 'attempt_recovery',
        recoveredAmount: 3500,
        currency: 'INR',
        version: 1,
      };

      const result = await processOutcomeMessage({
        topic: 'recovery-outcomes',
        partition: 0,
        message: {
          offset: '700',
          value: Buffer.from(JSON.stringify(validOutcome)),
        },
        consumer: mockConsumer,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.routedToDlq, undefined);
      assert.strictEqual(result.newState.transactionStatus, 'recovered');
      assert.strictEqual(committedOffsets.length, 1);
      assert.strictEqual(committedOffsets[0].offset, '701');
    });
  });
});
