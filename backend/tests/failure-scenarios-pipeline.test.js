import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { db, closeDatabasePool } from '../db/index.js';
import { customers, transactions, decisions, actions, messages } from '../../drizzle/schema.js';
import { eq } from 'drizzle-orm';
import { disconnectRedis, redis, checkIdempotency } from '../redis/redis.client.js';
import {
  initKafkaTopics,
  disconnectKafka,
  createConsumer,
} from '../kafka/kafka.client.js';
import { config } from '../services/config/index.js';
import {
  validatePaymentEvent,
  validateOutcomeEvent,
  serializeEvent,
  PaymentEventSchema,
  OutcomeEventSchema,
} from '../kafka/schemas/events.schema.js';
import { routeToDlq, executeWithRetry } from '../kafka/dlq.service.js';
import { replayDlqEvent, findDlqEvent } from '../kafka/replay.service.js';
import { processPaymentMessage } from '../kafka/consumers/recovery.consumer.js';
import { processOutcomeMessage } from '../kafka/consumers/outcome.consumer.js';

describe('Step 8: Comprehensive Pipeline Failure & Resilience Tests', () => {
  before(async () => {
    await initKafkaTopics();
  });

  after(async () => {
    await disconnectKafka();
    await disconnectRedis();
    await closeDatabasePool();
  });

  // -------------------------------------------------------------
  // 1. Kafka Event Contract & Boundary Failures
  // -------------------------------------------------------------
  describe('1. Kafka Event Contract & Boundary Failures', () => {
    it('should reject and route to DLQ when event contains unsupported eventType', async () => {
      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => { committedOffsets.push(...offsets); },
      };

      const invalidEventTypePayload = {
        eventId: crypto.randomUUID(),
        eventType: 'unsupported.order.created', // Invalid eventType
        occurredAt: new Date().toISOString(),
        transactionId: crypto.randomUUID(),
        customerId: crypto.randomUUID(),
        payload: {
          amount: 500,
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
          offset: '10',
          value: Buffer.from(JSON.stringify(invalidEventTypePayload)),
        },
        consumer: mockConsumer,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.routedToDlq, true);
      assert.strictEqual(result.failureType, 'schema_validation_error');
      assert.strictEqual(committedOffsets.length, 1);
      assert.strictEqual(committedOffsets[0].offset, '11');
    });

    it('should reject payment event with negative amount or unsupported currency', () => {
      const invalidEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'payment.failed',
        transactionId: 'txn_neg_test',
        customerId: 'cust_neg_test',
        payload: {
          amount: -500, // Negative amount
          currency: 'INVALID_CURRENCY_CODE', // Invalid currency
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
          attemptCount: 1,
        },
        version: 1,
      };

      const validation = validatePaymentEvent(invalidEvent);
      assert.strictEqual(validation.success, false);
      assert.ok(validation.errors.some((e) => e.field.includes('amount') || e.message.includes('positive')));
    });

    it('should fail serialization when required fields are missing', () => {
      assert.throws(
        () => {
          serializeEvent(PaymentEventSchema, {
            // Missing all required fields
            version: 1,
          });
        },
        (err) => {
          assert.ok(err.message.includes('Event serialization failed'));
          return true;
        }
      );
    });
  });

  // -------------------------------------------------------------
  // 2. Idempotency & Concurrent Ingestion Stress
  // -------------------------------------------------------------
  describe('2. Idempotency & Concurrent Ingestion Stress', () => {
    it('should handle concurrent duplicate payment events: exactly 1 executes, 1 is skipped', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'Concurrent Test User',
          email: `concurrent.${Date.now()}@example.com`,
          phone: '+919876543230',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '1500.00',
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
          attemptCount: 1,
        })
        .returning();

      const sharedEventId = crypto.randomUUID();
      const eventPayload = {
        eventId: sharedEventId,
        eventType: 'payment.failed',
        occurredAt: new Date().toISOString(),
        transactionId: tx.id,
        customerId: customer.id,
        payload: {
          amount: 1500,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
          attemptCount: 1,
        },
        version: 1,
      };

      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => { committedOffsets.push(...offsets); },
      };

      // Run two identical event messages concurrently
      const [res1, res2] = await Promise.all([
        processPaymentMessage({
          topic: 'payment-events',
          partition: 0,
          message: { offset: '101', value: Buffer.from(JSON.stringify(eventPayload)) },
          consumer: mockConsumer,
        }),
        processPaymentMessage({
          topic: 'payment-events',
          partition: 0,
          message: { offset: '102', value: Buffer.from(JSON.stringify(eventPayload)) },
          consumer: mockConsumer,
        }),
      ]);

      const executedCount = [res1, res2].filter((r) => r.success && !r.skipped).length;
      const skippedCount = [res1, res2].filter((r) => r.success && r.skipped).length;

      assert.strictEqual(executedCount, 1, 'Exactly one concurrent message should be processed');
      assert.strictEqual(skippedCount, 1, 'Exactly one concurrent message should be skipped as duplicate');
      assert.strictEqual(committedOffsets.length, 2, 'Both partition offsets must be committed');
    });

    it('should handle duplicate outcome event: skips second DB reconciliation without error', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'Outcome Dupe User',
          email: `outcome.dupe.${Date.now()}@example.com`,
          phone: '+919876543231',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '2000.00',
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
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
          reasoning: 'Test outcome dupe',
        })
        .returning();

      const outcomeEventId = crypto.randomUUID();
      const outcomePayload = {
        eventId: outcomeEventId,
        eventType: 'recovery.completed',
        occurredAt: new Date().toISOString(),
        transactionId: tx.id,
        caseId: decision.id,
        customerId: customer.id,
        outcome: 'recovered',
        toolName: 'attempt_recovery',
        recoveredAmount: 2000,
        currency: 'INR',
        version: 1,
      };

      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => { committedOffsets.push(...offsets); },
      };

      // First run
      const res1 = await processOutcomeMessage({
        topic: 'recovery-outcomes',
        partition: 0,
        message: { offset: '201', value: Buffer.from(JSON.stringify(outcomePayload)) },
        consumer: mockConsumer,
      });

      // Second run (duplicate)
      const res2 = await processOutcomeMessage({
        topic: 'recovery-outcomes',
        partition: 0,
        message: { offset: '202', value: Buffer.from(JSON.stringify(outcomePayload)) },
        consumer: mockConsumer,
      });

      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.skipped, undefined);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.skipped, true);
      assert.strictEqual(res2.reason, 'duplicate_event_id');
      assert.strictEqual(committedOffsets.length, 2);
    });
  });

  // -------------------------------------------------------------
  // 3. Consumer & Downstream Failure Resilience
  // -------------------------------------------------------------
  describe('3. Consumer & Downstream Failure Resilience', () => {
    it('should retry transient downstream 503 error with exponential backoff and succeed', async () => {
      let callCount = 0;
      const result = await executeWithRetry(
        async (attempt) => {
          callCount = attempt;
          if (attempt < 2) {
            const err = new Error('ML Service Unavailable (503)');
            err.statusCode = 503;
            throw err;
          }
          return { status: 'healthy', attempt };
        },
        { maxRetries: 3, initialDelayMs: 15, backoffMultiplier: 1.5, jitter: false }
      );

      assert.strictEqual(callCount, 2);
      assert.strictEqual(result.status, 'healthy');
    });

    it('should recover when transaction record becomes available on bounded recheck attempt 2 (Race Condition)', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'Race Condition Customer',
          email: `race.${Date.now()}@example.com`,
          phone: '+919876543232',
        })
        .returning();

      // Defer creating the transaction until attempt 2
      let delayedTxId = null;
      let checkAttempts = 0;

      const txPromise = executeWithRetry(
        async (attempt) => {
          checkAttempts = attempt;
          if (attempt === 1) {
            // Simulate missing record on first attempt
            const err = new Error('Transaction not found in PostgreSQL');
            err.code = 'TRANSACTION_NOT_FOUND';
            err.isEntityMissing = true;
            throw err;
          }

          // On attempt 2, record now exists in DB
          const [createdTx] = await db
            .insert(transactions)
            .values({
              customerId: customer.id,
              amount: '1800.00',
              currency: 'INR',
              status: 'failed',
              paymentMethod: 'card',
              failureReason: 'insufficient_funds',
              attemptCount: 1,
            })
            .returning();

          delayedTxId = createdTx.id;
          return { transaction: createdTx, customer };
        },
        {
          maxRetries: 3,
          initialDelayMs: 20,
          backoffMultiplier: 1.5,
          jitter: false,
          shouldRetry: (err) => err.isEntityMissing === true,
        }
      );

      const resolvedData = await txPromise;
      assert.strictEqual(checkAttempts, 2);
      assert.ok(resolvedData.transaction);
      assert.strictEqual(resolvedData.transaction.id, delayedTxId);
    });

    it('should exhaust retries and route to DLQ with retryCount=3 when transaction never appears', async () => {
      const committedOffsets = [];
      const mockConsumer = {
        commitOffsets: async (offsets) => { committedOffsets.push(...offsets); },
      };

      const phantomTxId = crypto.randomUUID();
      const phantomEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'payment.failed',
        occurredAt: new Date().toISOString(),
        transactionId: phantomTxId,
        customerId: crypto.randomUUID(),
        payload: {
          amount: 3000,
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
        message: { offset: '300', value: Buffer.from(JSON.stringify(phantomEvent)) },
        consumer: mockConsumer,
        retryConfig: { entityRecheckRetries: 3, entityRecheckDelayMs: 10 },
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.routedToDlq, true);
      assert.strictEqual(result.failureType, 'database_error');
      assert.strictEqual(committedOffsets.length, 1);
      assert.strictEqual(committedOffsets[0].offset, '301');
    });
  });

  // -------------------------------------------------------------
  // 4. Decision Policy & Guardrail Branch Verification
  // -------------------------------------------------------------
  describe('4. Decision Policy & Guardrail Branch Verification', () => {
    it('ALLOW Path: Standard amount transaction executes recovery tool and produces outcome recovered', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'Allow Path User',
          email: `allow.path.${Date.now()}@example.com`,
          phone: '+919876543233',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '1200.00',
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
          attemptCount: 1,
        })
        .returning();

      const eventPayload = {
        eventId: crypto.randomUUID(),
        eventType: 'payment.failed',
        occurredAt: new Date().toISOString(),
        transactionId: tx.id,
        customerId: customer.id,
        payload: {
          amount: 1200,
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
        message: { offset: '401', value: Buffer.from(JSON.stringify(eventPayload)) },
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.guardrailDecision, 'ALLOW');
      assert.strictEqual(result.outcome, 'recovered');
      assert.ok(result.executionResult);
      assert.strictEqual(result.executionResult.success, true);
    });

    it('REQUIRE_APPROVAL Path: High amount (> ₹50,000) does NOT execute tool and sets pending_review', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'High Amount User',
          email: `high.value.${Date.now()}@example.com`,
          phone: '+919876543234',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '60000.00', // Exceeds maxAutoApprovalAmount (₹50,000)
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureReason: 'bank_outage',
          attemptCount: 1,
        })
        .returning();

      const eventPayload = {
        eventId: crypto.randomUUID(),
        eventType: 'payment.failed',
        occurredAt: new Date().toISOString(),
        transactionId: tx.id,
        customerId: customer.id,
        payload: {
          amount: 60000,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'bank_outage',
          attemptCount: 1,
        },
        version: 1,
      };

      const result = await processPaymentMessage({
        topic: 'payment-events',
        partition: 0,
        message: { offset: '402', value: Buffer.from(JSON.stringify(eventPayload)) },
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.guardrailDecision, 'REQUIRE_APPROVAL');
      assert.strictEqual(result.outcome, 'pending_review');
      assert.strictEqual(result.executionResult, null, 'No automated tool execution should occur under REQUIRE_APPROVAL');

      // Verify PostgreSQL decision record status
      const [savedDecision] = await db
        .select()
        .from(decisions)
        .where(eq(decisions.id, result.decisionId))
        .limit(1);

      assert.strictEqual(savedDecision.status, 'pending_review');
      assert.strictEqual(savedDecision.guardrailResult, 'REQUIRE_APPROVAL');
    });

    it('BLOCK Path: High risk fraud failure reason triggers BLOCK guardrail', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'Fraud Suspect User',
          email: `fraud.${Date.now()}@example.com`,
          phone: '+919876543235',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '5000.00',
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureReason: 'high_risk_fraud',
          attemptCount: 1,
        })
        .returning();

      const eventPayload = {
        eventId: crypto.randomUUID(),
        eventType: 'payment.failed',
        occurredAt: new Date().toISOString(),
        transactionId: tx.id,
        customerId: customer.id,
        payload: {
          amount: 5000,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'high_risk_fraud',
          attemptCount: 1,
        },
        version: 1,
      };

      const result = await processPaymentMessage({
        topic: 'payment-events',
        partition: 0,
        message: { offset: '403', value: Buffer.from(JSON.stringify(eventPayload)) },
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.guardrailDecision, 'BLOCK');
      assert.strictEqual(result.outcome, 'blocked');
      assert.strictEqual(result.executionResult, null);
    });
  });

  // -------------------------------------------------------------
  // 5. Replay Guardrail Integrity & Atomic PostgreSQL Reconciliation
  // -------------------------------------------------------------
  describe('5. Replay Guardrail Integrity & Atomic PostgreSQL Reconciliation', () => {
    it('should NOT bypass guardrails when replaying high-value event', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'Replay Guardrail User',
          email: `replay.guard.${Date.now()}@example.com`,
          phone: '+919876543236',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '75000.00', // High value
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
          amount: 75000,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'bank_outage',
          attemptCount: 1,
        },
        version: 1,
      };

      // 1. Send to DLQ
      const dlqResult = await routeToDlq({
        topic: 'payment-events',
        partition: 0,
        offset: '501',
        error: new Error('Initial network timeout'),
        failureType: 'transient_exhausted',
        retryCount: 3,
        originalPayload: validPayload,
        originalEventId,
        transactionId: tx.id,
        customerId: customer.id,
      });

      // 2. Replay the DLQ event
      const replayResult = await replayDlqEvent(dlqResult.eventId, {
        replayedBy: 'admin_guardrail_audit',
      });

      assert.strictEqual(replayResult.success, true);
      assert.notStrictEqual(replayResult.replayEventId, originalEventId);

      // 3. Process a replayed message through consumer
      const testReplayEventId = crypto.randomUUID();
      const processResult = await processPaymentMessage({
        topic: 'payment-events',
        partition: 0,
        message: {
          offset: '502',
          value: Buffer.from(
            JSON.stringify({
              ...validPayload,
              eventId: testReplayEventId,
              originalEventId,
              isReplay: true,
              replayedFromDlqId: dlqResult.eventId,
            })
          ),
        },
      });

      // 4. Verify Guardrail was NOT bypassed
      assert.strictEqual(processResult.success, true);
      assert.strictEqual(processResult.guardrailDecision, 'REQUIRE_APPROVAL');
      assert.strictEqual(processResult.outcome, 'pending_review');
      assert.strictEqual(processResult.executionResult, null);
    });

    it('should atomically reconcile all related tables (transactions, decisions, actions, messages)', async () => {
      const [customer] = await db
        .insert(customers)
        .values({
          name: 'Atomic User',
          email: `atomic.${Date.now()}@example.com`,
          phone: '+919876543237',
        })
        .returning();

      const [tx] = await db
        .insert(transactions)
        .values({
          customerId: customer.id,
          amount: '5000.00',
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
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
          reasoning: 'Atomic reconciliation test',
        })
        .returning();

      const [action] = await db
        .insert(actions)
        .values({
          decisionId: decision.id,
          toolName: 'attempt_recovery',
          status: 'pending',
        })
        .returning();

      const outcomePayload = {
        eventId: crypto.randomUUID(),
        eventType: 'recovery.completed',
        occurredAt: new Date().toISOString(),
        transactionId: tx.id,
        caseId: decision.id,
        customerId: customer.id,
        outcome: 'recovered',
        toolName: 'attempt_recovery',
        recoveredAmount: 5000,
        currency: 'INR',
        details: {
          toolOutput: { paymentId: 'pay_reconciled_atomic_123', status: 'captured' },
        },
        version: 1,
      };

      const result = await processOutcomeMessage({
        topic: 'recovery-outcomes',
        partition: 0,
        message: { offset: '601', value: Buffer.from(JSON.stringify(outcomePayload)) },
      });

      assert.strictEqual(result.success, true);

      // Verify Transaction updated
      const [updatedTx] = await db.select().from(transactions).where(eq(transactions.id, tx.id)).limit(1);
      assert.strictEqual(updatedTx.status, 'recovered');
      assert.strictEqual(updatedTx.metadata?.recoveredAmount, 5000);

      // Verify Decision updated
      const [updatedDec] = await db.select().from(decisions).where(eq(decisions.id, decision.id)).limit(1);
      assert.strictEqual(updatedDec.status, 'executed');

      // Verify Action updated
      const [updatedAct] = await db.select().from(actions).where(eq(actions.id, action.id)).limit(1);
      assert.strictEqual(updatedAct.status, 'success');
      assert.strictEqual(updatedAct.result?.outcome, 'recovered');

      // Verify Message/Audit recorded
      const msgRecords = await db.select().from(messages).where(eq(messages.transactionId, tx.id));
      assert.ok(msgRecords.length > 0);
      const auditMsg = msgRecords.find((m) => m.eventTaken === 'resolved');
      assert.ok(auditMsg);
      assert.strictEqual(auditMsg.details.outcomeEventId, outcomePayload.eventId);
    });
  });
});
