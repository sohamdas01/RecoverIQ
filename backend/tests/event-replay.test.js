import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import { db, closeDatabasePool } from '../db/index.js';
import { customers, transactions, decisions, messages } from '../../drizzle/schema.js';
import { eq } from 'drizzle-orm';
import { disconnectRedis } from '../redis/redis.client.js';
import {
  initKafkaTopics,
  disconnectKafka,
  createConsumer,
} from '../kafka/kafka.client.js';
import { config } from '../services/config/index.js';
import { AuthService } from '../services/auth/auth.service.js';
import { routeToDlq } from '../kafka/dlq.service.js';
import {
  findDlqEvent,
  replayDlqEvent,
  indexDlqEventInMemory,
} from '../kafka/replay.service.js';
import { processPaymentMessage } from '../kafka/consumers/recovery.consumer.js';
import { processOutcomeMessage } from '../kafka/consumers/outcome.consumer.js';
import { deserializeEvent } from '../kafka/schemas/events.schema.js';
import adminRoutes from '../api/routes/admin-events.routes.js';

describe('Step 7: Event Replay Mechanism Tests', () => {
  let app;
  let server;
  let baseUrl;
  let adminToken;

  before(async () => {
    await initKafkaTopics();

    // Setup express app with admin routes for testing
    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });

    adminToken = AuthService.generateMerchantToken('test_admin_merchant_1', 'admin');
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await disconnectKafka();
    await disconnectRedis();
    await closeDatabasePool();
  });

  // 1. DLQ Event Lookup & Inspection
  describe('1. DLQ Event Discovery', () => {
    it('should find an existing DLQ event by ID', async () => {
      const originalEventId = crypto.randomUUID();
      const dlqResult = await routeToDlq({
        topic: 'payment-events',
        partition: 0,
        offset: '123',
        error: new Error('Simulated upstream failure'),
        failureType: 'transient_exhausted',
        retryCount: 3,
        originalPayload: {
          eventId: originalEventId,
          eventType: 'payment.failed',
          transactionId: 'txn_dlq_lookup_test',
          customerId: 'cust_dlq_lookup_test',
          payload: {
            amount: 1999,
            currency: 'INR',
            paymentMethod: 'card',
            failureReason: 'bank_outage',
            attemptCount: 1,
          },
          version: 1,
        },
        originalEventId,
        transactionId: 'txn_dlq_lookup_test',
      });

      assert.ok(dlqResult.eventId);
      const found = await findDlqEvent(dlqResult.eventId);
      assert.ok(found);
      assert.strictEqual(found.eventId, dlqResult.eventId);
      assert.strictEqual(found.failureType, 'transient_exhausted');
      assert.strictEqual(found.originalTopic, 'payment-events');
    });

    it('should return null when searching for a non-existent DLQ event', async () => {
      const nonExistentId = crypto.randomUUID();
      const found = await findDlqEvent(nonExistentId);
      assert.strictEqual(found, null);
    });
  });

  // 2. Unsafe Replay Prevention & Validations
  describe('2. Unsafe Replay Protections', () => {
    it('should reject replay if DLQ event does not exist (404)', async () => {
      const missingDlqId = crypto.randomUUID();
      await assert.rejects(
        async () => {
          await replayDlqEvent(missingDlqId, { replayedBy: 'admin_test' });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 404);
          assert.ok(err.message.includes('DLQ event not found'));
          return true;
        }
      );
    });

    it('should reject replay if original topic is unsupported (400)', async () => {
      const fakeDlqEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'dead_letter.recorded',
        occurredAt: new Date().toISOString(),
        originalTopic: 'unsupported-topic-xyz',
        failureType: 'unhandled_error',
        failureReason: 'Bad topic',
        originalPayload: { amount: 100 },
        version: 1,
      };
      indexDlqEventInMemory(fakeDlqEvent);

      await assert.rejects(
        async () => {
          await replayDlqEvent(fakeDlqEvent.eventId, { replayedBy: 'admin_test' });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 400);
          assert.ok(err.message.includes('Unsupported replay target topic'));
          return true;
        }
      );
    });

    it('should reject replay if original payload is invalid JSON / corrupt (400)', async () => {
      const corruptDlqEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'dead_letter.recorded',
        occurredAt: new Date().toISOString(),
        originalTopic: 'payment-events',
        failureType: 'poison_message',
        failureReason: 'Corrupted binary',
        originalPayload: 'NOT_VALID_JSON_CORRUPT',
        version: 1,
      };
      indexDlqEventInMemory(corruptDlqEvent);

      await assert.rejects(
        async () => {
          await replayDlqEvent(corruptDlqEvent.eventId, { replayedBy: 'admin_test' });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 400);
          assert.ok(err.message.includes('cannot be replayed'));
          return true;
        }
      );
    });

    it('should reject replay if payload violates schema contract (400)', async () => {
      const invalidSchemaDlqEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'dead_letter.recorded',
        occurredAt: new Date().toISOString(),
        originalTopic: 'payment-events',
        failureType: 'schema_validation_error',
        failureReason: 'Missing fields',
        originalPayload: {
          eventType: 'payment.failed',
          // Missing transactionId, customerId, payload
        },
        version: 1,
      };
      indexDlqEventInMemory(invalidSchemaDlqEvent);

      await assert.rejects(
        async () => {
          await replayDlqEvent(invalidSchemaDlqEvent.eventId, { replayedBy: 'admin_test' });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 400);
          assert.ok(err.message.includes('schema validation failed'));
          return true;
        }
      );
    });
  });

  // 3. Successful Replay & Duplicate Prevention
  describe('3. Replay Execution & Idempotency', () => {
    it('should successfully replay a valid DLQ event with a new eventId and preserve originalEventId', async () => {
      // Seed customer & transaction in DB
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'Replay Test User',
          email: `replay.user.${Date.now()}@example.com`,
          phone: '+919876543215',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '2999.00',
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureReason: 'bank_outage',
          attemptCount: 1,
        })
        .returning();

      const originalEventId = crypto.randomUUID();
      const validPayload = {
        eventId: originalEventId,
        eventType: 'payment.failed',
        occurredAt: new Date().toISOString(),
        transactionId: tx.id,
        customerId: customer.id,
        payload: {
          amount: 2999,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'bank_outage',
          attemptCount: 1,
        },
        version: 1,
      };

      const dlqResult = await routeToDlq({
        topic: 'payment-events',
        partition: 0,
        offset: '555',
        error: new Error('Temporary gateway timeout'),
        failureType: 'transient_exhausted',
        retryCount: 3,
        originalPayload: validPayload,
        originalEventId,
        transactionId: tx.id,
        customerId: customer.id,
      });

      // 1. Dry run verification
      const dryRunResult = await replayDlqEvent(dlqResult.eventId, {
        replayedBy: 'admin_tester',
        dryRun: true,
      });
      assert.strictEqual(dryRunResult.dryRun, true);
      assert.strictEqual(dryRunResult.originalEventId, originalEventId);

      // 2. Real replay execution
      const replayResult = await replayDlqEvent(dlqResult.eventId, {
        replayedBy: 'admin_tester',
      });

      assert.strictEqual(replayResult.success, true);
      assert.strictEqual(replayResult.dlqEventId, dlqResult.eventId);
      assert.strictEqual(replayResult.originalEventId, originalEventId);
      assert.ok(replayResult.replayEventId);
      assert.notStrictEqual(replayResult.replayEventId, originalEventId);
      assert.strictEqual(replayResult.targetTopic, 'payment-events');
      assert.strictEqual(replayResult.status, 'replayed');

      // 3. Duplicate Replay Check (409 Conflict)
      await assert.rejects(
        async () => {
          await replayDlqEvent(dlqResult.eventId, { replayedBy: 'admin_tester' });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 409);
          assert.ok(err.message.includes('has already been replayed'));
          return true;
        }
      );

      // 4. Immutability Check: Original DLQ record remains unchanged
      const dlqRecordAfter = await findDlqEvent(dlqResult.eventId);
      assert.strictEqual(dlqRecordAfter.eventId, dlqResult.eventId);
      assert.strictEqual(dlqRecordAfter.failureType, 'transient_exhausted');

      // 5. Audit Check in PostgreSQL messages table
      const auditMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.transactionId, tx.id));

      const replayAudit = auditMessages.find((m) => m.eventTaken === 'event_replayed');
      assert.ok(replayAudit, 'Audit record for event_replayed should exist in messages table');
      assert.strictEqual(replayAudit.details.dlqEventId, dlqResult.eventId);
      assert.strictEqual(replayAudit.details.replayEventId, replayResult.replayEventId);
      assert.strictEqual(replayAudit.details.replayedBy, 'admin_tester');
    });
  });

  // 4. Admin API Endpoint & Authentication
  describe('4. Admin Replay API Endpoint', () => {
    it('should reject unauthenticated replay requests (401)', async () => {
      const response = await fetch(`${baseUrl}/api/admin/events/${crypto.randomUUID()}/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      assert.strictEqual(response.status, 401);
      const data = await response.json();
      assert.strictEqual(data.success, false);
    });

    it('should successfully replay event via POST /api/admin/events/:dlqEventId/replay with JWT auth', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'API Replay User',
          email: `api.replay.${Date.now()}@example.com`,
          phone: '+919876543216',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '1299.00',
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'upi',
          failureReason: 'network_timeout',
          attemptCount: 1,
        })
        .returning();

      const originalEventId = crypto.randomUUID();
      const dlqResult = await routeToDlq({
        topic: 'payment-events',
        partition: 1,
        offset: '777',
        error: new Error('Temporary service unavailable'),
        failureType: 'transient_exhausted',
        retryCount: 3,
        originalPayload: {
          eventId: originalEventId,
          eventType: 'payment.failed',
          occurredAt: new Date().toISOString(),
          transactionId: tx.id,
          customerId: customer.id,
          payload: {
            amount: 1299,
            currency: 'INR',
            paymentMethod: 'upi',
            failureReason: 'network_timeout',
            attemptCount: 1,
          },
          version: 1,
        },
        originalEventId,
        transactionId: tx.id,
        customerId: customer.id,
      });

      // Replay via Admin API
      const response = await fetch(`${baseUrl}/api/admin/events/${dlqResult.eventId}/replay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ replayedBy: 'merchant_admin_api' }),
      });

      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.dlqEventId, dlqResult.eventId);
      assert.strictEqual(data.originalEventId, originalEventId);
      assert.ok(data.replayEventId);
      assert.strictEqual(data.targetTopic, 'payment-events');
    });
  });

  // 5. Full End-to-End Replay Pipeline Integration
  describe('5. End-to-End Integration: DLQ -> Replay -> Consumer -> Outcome Pipeline', () => {
    it('should allow replayed event to be consumed normally by recovery consumer without bypassing validation/guardrails', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'E2E Replay User',
          email: `e2e.replay.${Date.now()}@example.com`,
          phone: '+919876543217',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '1999.00',
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
          attemptCount: 1,
        })
        .returning();

      const originalEventId = crypto.randomUUID();
      const validPayload = {
        eventId: originalEventId,
        eventType: 'payment.failed',
        occurredAt: new Date().toISOString(),
        transactionId: tx.id,
        customerId: customer.id,
        payload: {
          amount: 1999,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
          attemptCount: 1,
        },
        version: 1,
      };

      // 1. Initial transient error sends to DLQ
      const dlqResult = await routeToDlq({
        topic: 'payment-events',
        partition: 0,
        offset: '999',
        error: new Error('Temporary connection timeout'),
        failureType: 'transient_exhausted',
        retryCount: 3,
        originalPayload: validPayload,
        originalEventId,
        transactionId: tx.id,
        customerId: customer.id,
      });

      // 2. Admin triggers replay
      const replayResult = await replayDlqEvent(dlqResult.eventId, {
        replayedBy: 'admin_pipeline_test',
      });

      assert.strictEqual(replayResult.success, true);
      const replayedEventId = replayResult.replayEventId;

      // 3. Recovery Consumer processes the replayed event
      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => {
          committedOffsets.push(...offsets);
        },
      };

      const processResult = await processPaymentMessage({
        topic: 'payment-events',
        partition: 0,
        message: {
          offset: '1000',
          value: Buffer.from(
            JSON.stringify({
              ...validPayload,
              eventId: replayedEventId,
              originalEventId,
              isReplay: true,
              replayedFromDlqId: dlqResult.eventId,
            })
          ),
        },
        consumer: mockConsumer,
      });

      assert.strictEqual(processResult.success, true);
      assert.strictEqual(processResult.eventId, replayedEventId);
      assert.ok(processResult.decisionId);
      assert.strictEqual(committedOffsets.length, 1);
      assert.strictEqual(committedOffsets[0].offset, '1001');

      // 4. Verify decision created in PostgreSQL for the replay attempt
      const [savedDecision] = await db
        .select()
        .from(decisions)
        .where(eq(decisions.id, processResult.decisionId))
        .limit(1);

      assert.ok(savedDecision);
      assert.strictEqual(savedDecision.transactionId, tx.id);
      assert.strictEqual(savedDecision.status, 'executed');
    });
  });
});
