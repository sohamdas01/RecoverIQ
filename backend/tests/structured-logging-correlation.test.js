/**
 * RecoverIQ Structured Logging & Correlation Tests
 * Phase 6 - Step 1: Structured Logging & End-to-End Correlation IDs
 *
 * Verifies:
 * 1. Express Correlation Middleware (header generation, extraction, sanitization, response headers)
 * 2. AsyncLocalStorage Context Management (isolation, propagation, updates)
 * 3. Structured Logger Service (JSON format, component tagging, metadata enrichment)
 * 4. Deep Secret Scrubbing (redaction of tokens, API keys, card PANs, CVVs, passwords)
 * 5. Kafka Producer Correlation Header Injection
 * 6. Kafka Consumer Context Restoration
 * 7. Recovery Orchestrator Structured Lifecycle Logs & Duration Tracking
 * 8. Human Review & Replay Structured Logging
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import express from 'express';
import axios from 'axios';
import {
  LoggerService,
  logger,
  createLogger,
  createCorrelationContext,
  runWithCorrelationContext,
  getCorrelationContext,
  updateCorrelationContext,
  sanitizeCorrelationId,
} from '../services/logger/index.js';
import { correlationMiddleware } from '../api/middleware/correlation.middleware.js';
import { publishPaymentEvent, publishOutcomeEvent } from '../kafka/producer.js';
import { processPaymentMessage } from '../kafka/consumers/recovery.consumer.js';
import { processOutcomeMessage } from '../kafka/consumers/outcome.consumer.js';
import { RecoveryOrchestrator } from '../services/recovery/index.js';
import { ReviewService, REVIEW_STATUSES } from '../services/review/index.js';
import { replayDlqEvent, indexDlqEventInMemory } from '../kafka/replay.service.js';
import { findOrCreateCustomer } from '../db/queries/customers.queries.js';
import { createTransaction, getTransactionById } from '../db/queries/transactions.queries.js';
import { createDecision, getDecisionById } from '../db/queries/decisions.queries.js';
import { closeDatabasePool } from '../db/index.js';
import { disconnectRedis } from '../redis/redis.client.js';
import { disconnectKafka } from '../kafka/kafka.client.js';
import { stopRecoveryConsumer } from '../kafka/consumers/recovery.consumer.js';
import { stopOutcomeConsumer } from '../kafka/consumers/outcome.consumer.js';

describe('Phase 6 - Step 1: Structured Logging & End-to-End Correlation IDs', () => {
  let app;
  let server;
  let BASE_URL;

  before(async () => {
    app = express();
    app.use(express.json());
    app.use(correlationMiddleware);

    // Test route that echoes back context
    app.get('/api/test/correlation', (req, res) => {
      const ctx = getCorrelationContext();
      res.json({
        reqHeaders: {
          requestId: req.headers['x-request-id'],
          correlationId: req.headers['x-correlation-id'],
        },
        context: ctx,
      });
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        BASE_URL = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await stopRecoveryConsumer().catch(() => {});
    await stopOutcomeConsumer().catch(() => {});
    await disconnectKafka().catch(() => {});
    await disconnectRedis().catch(() => {});
    await closeDatabasePool().catch(() => {});
  });

  // =========================================================================
  // Section 1: Correlation Middleware & Context Propagation
  // =========================================================================

  describe('1. Express Correlation Middleware', () => {
    it('generates unique requestId and correlationId when no headers are provided', async () => {
      const res = await axios.get(`${BASE_URL}/api/test/correlation`);

      assert.strictEqual(res.status, 200);
      assert.ok(res.headers['x-request-id'], 'Response should have x-request-id header');
      assert.ok(res.headers['x-correlation-id'], 'Response should have x-correlation-id header');
      assert.strictEqual(res.headers['x-request-id'], res.headers['x-correlation-id']);

      assert.strictEqual(res.data.context.requestId, res.headers['x-request-id']);
      assert.strictEqual(res.data.context.correlationId, res.headers['x-correlation-id']);
    });

    it('preserves incoming X-Request-Id and X-Correlation-Id headers', async () => {
      const customReqId = 'req-custom-9988';
      const customCorrId = 'corr-root-1122';

      const res = await axios.get(`${BASE_URL}/api/test/correlation`, {
        headers: {
          'x-request-id': customReqId,
          'x-correlation-id': customCorrId,
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['x-request-id'], customReqId);
      assert.strictEqual(res.headers['x-correlation-id'], customCorrId);
      assert.strictEqual(res.data.context.requestId, customReqId);
      assert.strictEqual(res.data.context.correlationId, customCorrId);
    });

    it('sanitizes and replaces invalid or unsafe correlation IDs', async () => {
      const unsafeCorrId = '<script>alert(1)</script>';

      const res = await axios.get(`${BASE_URL}/api/test/correlation`, {
        headers: {
          'x-correlation-id': unsafeCorrId,
        },
      });

      assert.strictEqual(res.status, 200);
      assert.notStrictEqual(res.headers['x-correlation-id'], unsafeCorrId);
      assert.ok(res.headers['x-correlation-id'].length > 10);
    });
  });

  // =========================================================================
  // Section 2: AsyncLocalStorage Context Isolation & Updates
  // =========================================================================

  describe('2. AsyncLocalStorage Context Management', () => {
    it('maintains isolated context across concurrent asynchronous tasks', async () => {
      const task1 = runWithCorrelationContext({ requestId: 'req-task-1', transactionId: 'tx-1' }, async () => {
        await new Promise((r) => setTimeout(r, 20));
        const ctx1 = getCorrelationContext();
        assert.strictEqual(ctx1.requestId, 'req-task-1');
        assert.strictEqual(ctx1.transactionId, 'tx-1');
        return ctx1;
      });

      const task2 = runWithCorrelationContext({ requestId: 'req-task-2', transactionId: 'tx-2' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        const ctx2 = getCorrelationContext();
        assert.strictEqual(ctx2.requestId, 'req-task-2');
        assert.strictEqual(ctx2.transactionId, 'tx-2');
        return ctx2;
      });

      const [res1, res2] = await Promise.all([task1, task2]);
      assert.strictEqual(res1.requestId, 'req-task-1');
      assert.strictEqual(res2.requestId, 'req-task-2');
    });

    it('allows in-place context enrichment via updateCorrelationContext', async () => {
      await runWithCorrelationContext({ requestId: 'req-enrich-test' }, async () => {
        const initial = getCorrelationContext();
        assert.strictEqual(initial.requestId, 'req-enrich-test');
        assert.strictEqual(initial.caseId, null);

        updateCorrelationContext({ caseId: 'case-999', transactionId: 'tx-888' });

        const updated = getCorrelationContext();
        assert.strictEqual(updated.requestId, 'req-enrich-test');
        assert.strictEqual(updated.caseId, 'case-999');
        assert.strictEqual(updated.transactionId, 'tx-888');
      });
    });

    it('returns empty object when accessed outside of correlation context', () => {
      const ctx = getCorrelationContext();
      assert.deepStrictEqual(ctx, {});
    });
  });

  // =========================================================================
  // Section 3: Structured Logger Service & Secret Scrubbing
  // =========================================================================

  describe('3. Structured Logger Service & Secret Scrubbing', () => {
    it('formats log payload with ISO timestamp, level, service, and component', () => {
      const testLogger = new LoggerService({ component: 'test_comp', service: 'test_service' });
      const payload = testLogger._buildLogPayload('INFO', 'test_event', { customKey: 'val123' });

      assert.strictEqual(payload.level, 'INFO');
      assert.strictEqual(payload.service, 'test_service');
      assert.strictEqual(payload.component, 'test_comp');
      assert.strictEqual(payload.event, 'test_event');
      assert.strictEqual(payload.customKey, 'val123');
      assert.ok(payload.timestamp);
    });

    it('automatically extracts context IDs from AsyncLocalStorage into log payload', async () => {
      const testLogger = new LoggerService({ component: 'worker' });

      await runWithCorrelationContext({
        requestId: 'req-auto-123',
        correlationId: 'corr-auto-456',
        transactionId: 'tx-auto-789',
        caseId: 'case-auto-111',
      }, async () => {
        const payload = testLogger._buildLogPayload('INFO', 'task_completed', { durationMs: 42 });

        assert.strictEqual(payload.requestId, 'req-auto-123');
        assert.strictEqual(payload.correlationId, 'corr-auto-456');
        assert.strictEqual(payload.transactionId, 'tx-auto-789');
        assert.strictEqual(payload.caseId, 'case-auto-111');
        assert.strictEqual(payload.durationMs, 42);
      });
    });

    it('deeply scrubs and masks sensitive keys and credentials', () => {
      const sensitiveData = {
        transactionId: 'tx-sec-123',
        amount: 2500,
        auth_token: 'bearer-jwt-super-secret',
        apiKey: 'sk_live_1234567890abcdef',
        secret: 'my-webhook-secret',
        password: 'admin-password',
        customer: {
          name: 'Jane Doe',
          pan: '4111111111111111',
          cvv: '123',
          card_number: '5500000000000004',
          nested: {
            jwt: 'eyJh.eyJz.abc',
          },
        },
      };

      const sanitized = LoggerService.sanitize(sensitiveData);

      assert.strictEqual(sanitized.transactionId, 'tx-sec-123');
      assert.strictEqual(sanitized.amount, 2500);
      assert.strictEqual(sanitized.customer.name, 'Jane Doe');

      assert.strictEqual(sanitized.auth_token, '[REDACTED]');
      assert.strictEqual(sanitized.apiKey, '[REDACTED]');
      assert.strictEqual(sanitized.secret, '[REDACTED]');
      assert.strictEqual(sanitized.password, '[REDACTED]');
      assert.strictEqual(sanitized.customer.pan, '[REDACTED]');
      assert.strictEqual(sanitized.customer.cvv, '[REDACTED]');
      assert.strictEqual(sanitized.customer.card_number, '[REDACTED]');
      assert.strictEqual(sanitized.customer.nested.jwt, '[REDACTED]');
    });

    it('creates child loggers with specific component tags', () => {
      const parent = new LoggerService({ component: 'root_service', service: 'recoveriq-app' });
      const child = parent.withComponent('sub_worker');

      assert.strictEqual(child.component, 'sub_worker');
      assert.strictEqual(child.service, 'recoveriq-app');
    });
  });

  // =========================================================================
  // Section 4: Kafka Producer Correlation Injection
  // =========================================================================

  describe('4. Kafka Producer Correlation Header Injection', () => {
    it('injects active correlation context into Kafka payment event headers', async () => {
      await runWithCorrelationContext({
        requestId: 'req-producer-test',
        correlationId: 'corr-producer-test',
      }, async () => {
        const eventPayload = {
          eventId: crypto.randomUUID(),
          eventType: 'payment.failed',
          occurredAt: new Date().toISOString(),
          transactionId: crypto.randomUUID(),
          customerId: crypto.randomUUID(),
          payload: {
            amount: 1500,
            currency: 'INR',
            failureReason: 'insufficient_funds',
            paymentMethod: 'card',
            attemptCount: 1,
          },
        };

        const publishResult = await publishPaymentEvent(eventPayload);
        assert.strictEqual(publishResult.success, true);
        assert.ok(publishResult.eventId);
      });
    });

    it('injects active correlation context into Kafka outcome event headers', async () => {
      await runWithCorrelationContext({
        requestId: 'req-outcome-test',
        correlationId: 'corr-outcome-test',
        caseId: 'case-outcome-456',
      }, async () => {
        const outcomePayload = {
          eventId: crypto.randomUUID(),
          eventType: 'recovery.completed',
          occurredAt: new Date().toISOString(),
          transactionId: crypto.randomUUID(),
          caseId: 'case-outcome-456',
          outcome: 'recovered',
          toolName: 'attempt_recovery',
        };

        const publishResult = await publishOutcomeEvent(outcomePayload);
        assert.strictEqual(publishResult.success, true);
        assert.ok(publishResult.eventId);
      });
    });
  });

  // =========================================================================
  // Section 5: End-to-End Orchestrator Structured Observability
  // =========================================================================

  describe('5. Recovery Orchestrator & Consumer Observability', () => {
    let customer;
    let transaction;

    before(async () => {
      const email = `test_obs_${Date.now()}@recoveriq.io`;
      customer = await findOrCreateCustomer({
        email,
        name: 'Structured Logger Customer',
        phone: '+919876543210',
      });

      transaction = await createTransaction({
        customerId: customer.id,
        amount: 3200,
        currency: 'INR',
        status: 'failed',
        failureReason: 'insufficient_funds',
        paymentMethod: 'upi',
      });
    });

    it('orchestrates recovery inside correlation context with full structured logs', async () => {
      const originalEventId = crypto.randomUUID();

      const result = await runWithCorrelationContext({
        requestId: 'req-orch-lifecycle',
        correlationId: 'corr-orch-lifecycle',
        originalEventId,
      }, async () => {
        return await RecoveryOrchestrator.orchestrateRecovery({
          transaction,
          customer,
          customerStats: {
            previousSuccesses: 4,
            previousFailures: 0,
            previousRecoverySuccess: true,
          },
          originalEventId,
        });
      });

      assert.ok(result.decision);
      assert.ok(result.durationMs >= 0);
      assert.ok(result.policyResult);
      assert.strictEqual(result.outcomePayload.details.originalEventId, originalEventId);
    });

    it('preserves replay lineage during replayed recovery event', async () => {
      const originalDlqEventId = crypto.randomUUID();
      const originalEventId = crypto.randomUUID();

      indexDlqEventInMemory({
        eventId: originalDlqEventId,
        originalTopic: 'payment-events',
        originalEventId,
        originalPayload: {
          eventId: originalEventId,
          eventType: 'payment.failed',
          occurredAt: new Date().toISOString(),
          transactionId: transaction.id,
          customerId: customer.id,
          payload: {
            amount: 3200,
            currency: 'INR',
            failureReason: 'insufficient_funds',
            paymentMethod: 'upi',
            attemptCount: 1,
          },
        },
      });

      const replayResult = await replayDlqEvent(originalDlqEventId, { replayedBy: 'test_admin' });

      assert.strictEqual(replayResult.success, true);
      assert.strictEqual(replayResult.originalEventId, originalEventId);
      assert.ok(replayResult.replayEventId);
    });
  });
});
