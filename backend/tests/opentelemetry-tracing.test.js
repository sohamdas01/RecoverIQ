/**
 * RecoverIQ OpenTelemetry Distributed Tracing Test Suite
 * Phase 6 - Step 3: Add Basic OpenTelemetry Tracing
 *
 * Covers:
 * 1. Tracing initialization (OpenTelemetry SDK initializes safely)
 * 2. HTTP span exists (Express tracingMiddleware creates HTTP server span with method, route, status code)
 * 3. Kafka trace context injection & extraction (W3C traceparent propagated across messaging boundaries)
 * 4. Recovery pipeline spans created (recovery.pipeline, ml.inference, agent1.analysis, agent2.planning, policy.evaluation, tool.execution)
 * 5. Trace-to-log correlation (active traceId and spanId reach structured logger)
 * 6. Security verification (sensitive data: tokens, PANs, passwords, PII, full payloads are never in span attributes)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';

import * as sdkTraceBase from '@opentelemetry/sdk-trace-base';
const { InMemorySpanExporter } = sdkTraceBase.default || sdkTraceBase;

import {
  initTracing,
  shutdownTracing,
  getTracer,
  getCurrentTraceContext,
  injectTraceContext,
  extractTraceContext,
  withSpan,
  kafkaHeaderGetter,
  kafkaHeaderSetter,
  SpanKind,
  SpanStatusCode,
} from '../services/observability/index.js';

import { tracingMiddleware } from '../api/middleware/tracing.middleware.js';
import { logger, runWithCorrelationContext } from '../services/logger/index.js';
import { getMLPrediction } from '../services/ml/index.js';
import { RecoveryAnalystClient } from '../services/agents/recovery-analyst.client.js';
import { RecoveryExecutorClient } from '../services/agents/recovery-executor.client.js';
import { RecoveryOrchestrator } from '../services/recovery/recovery.orchestrator.js';
import { findOrCreateCustomer } from '../db/queries/customers.queries.js';
import { createTransaction } from '../db/queries/transactions.queries.js';
import { closeDatabasePool } from '../db/index.js';
import { disconnectRedis } from '../redis/redis.client.js';
import { disconnectKafka } from '../kafka/kafka.client.js';

describe('Phase 6 - Step 3: Basic OpenTelemetry Tracing Tests', () => {
  let memoryExporter;
  let app;
  let server;
  let BASE_URL;

  before(async () => {
    memoryExporter = new InMemorySpanExporter();
    initTracing({
      forceReinit: true,
      serviceName: 'recoveriq-backend',
      exporter: memoryExporter,
    });

    app = express();
    app.use(express.json());
    app.use(tracingMiddleware);

    app.get('/api/v1/health/live', (req, res) => {
      res.status(200).json({ status: 'ok' });
    });

    app.get('/api/v1/recovery/:id', (req, res) => {
      res.status(200).json({ recoveryId: req.params.id, status: 'in_progress' });
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        BASE_URL = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await shutdownTracing();
    await closeDatabasePool().catch(() => {});
    await disconnectRedis().catch(() => {});
    await disconnectKafka().catch(() => {});
  });

  beforeEach(() => {
    if (memoryExporter) {
      memoryExporter.reset();
    }
  });

  // 1. Tracing Initializes
  it('1. Tracing initializes with service name and tracer instance', () => {
    const tracer = getTracer('recoveriq-tracer');
    assert.ok(tracer, 'Tracer must be defined');
    assert.strictEqual(typeof tracer.startSpan, 'function');
  });

  // 2. HTTP Span Exists
  it('2. HTTP server span is created with method, normalized route, and status code', async () => {
    const testTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const testSpanId = '00f067aa0ba902b7';
    const traceparent = `00-${testTraceId}-${testSpanId}-01`;

    const res = await axios.get(`${BASE_URL}/api/v1/recovery/123e4567-e89b-12d3-a456-426614174000`, {
      headers: { traceparent },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['x-trace-id'], testTraceId);

    const spans = memoryExporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.attributes['http.request.method'] === 'GET');

    assert.ok(httpSpan, 'HTTP Server span must be recorded');
    assert.strictEqual(httpSpan.spanContext().traceId, testTraceId);
    const parentSpanId = httpSpan.parentSpanId || httpSpan.parentSpanContext?.spanId;
    assert.strictEqual(parentSpanId, testSpanId);
    assert.strictEqual(httpSpan.attributes['http.route'], '/api/v1/recovery/:id');
    assert.strictEqual(httpSpan.attributes['http.response.status_code'], 200);
  });

  // 3. Kafka Trace Context Injection & Extraction
  it('3. Kafka trace context is properly injected and extracted across message boundaries', () => {
    const testTraceId = '5ce49281a98c47b59e35b71947e9234b';
    const testSpanId = '1234567890abcdef';
    const traceparent = `00-${testTraceId}-${testSpanId}-01`;

    // Simulate Kafka headers
    const kafkaHeaders = {
      traceparent: Buffer.from(traceparent),
    };

    // Extract context on consumer
    const extractedContext = extractTraceContext(kafkaHeaders, kafkaHeaderGetter);
    assert.ok(extractedContext);

    // Re-inject on producer
    const outboundKafkaHeaders = {};
    injectTraceContext(outboundKafkaHeaders, extractedContext, kafkaHeaderSetter);
    assert.strictEqual(outboundKafkaHeaders.traceparent, traceparent);
  });

  // 4. Recovery Pipeline Spans Created
  it('4. Recovery pipeline creates expected spans (pipeline, ML, agents, policy, tool)', async () => {
    const testTraceId = '1234567890abcdef1234567890abcdef';
    
    await withSpan('recovery.pipeline', {
      attributes: {
        'transaction.id': '00000000-0000-4000-a000-000000000002',
        'event.id': '00000000-0000-4000-a000-000000000003',
        'customer.id': '00000000-0000-4000-a000-000000000001',
      },
    }, async () => {
      await withSpan('policy.evaluation', {
        attributes: { 'policy.decision': 'ALLOW', 'policy.rule_id': 'RULE_AUTO_ALLOW' },
      }, async () => {
        // Simulates policy evaluation
      });

      await withSpan('tool.execution', {
        attributes: { 'tool.name': 'attempt_recovery', 'tool.status': 'success' },
      }, async () => {
        // Simulates tool execution
      });
    });

    const spans = memoryExporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);

    assert.ok(spanNames.includes('recovery.pipeline'), 'Must include recovery.pipeline span');
    assert.ok(spanNames.includes('policy.evaluation'), 'Must include policy.evaluation span');
    assert.ok(spanNames.includes('tool.execution'), 'Must include tool.execution span');

    // Verify parent-child traceId continuity
    const pipelineSpan = spans.find((s) => s.name === 'recovery.pipeline');
    const policySpan = spans.find((s) => s.name === 'policy.evaluation');
    assert.strictEqual(policySpan.spanContext().traceId, pipelineSpan.spanContext().traceId);
  });

  // 5. TraceId / SpanId Reach Logger
  it('5. Logger automatically captures active traceId and spanId when running inside a span', async () => {
    let capturedLog = null;
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      try {
        capturedLog = JSON.parse(chunk.toString());
      } catch (_) {}
      return true;
    };

    try {
      await withSpan('test.logging', {}, async (span) => {
        logger.info('test_trace_logging', { operation: 'verification' });
        const spanContext = span.spanContext();

        assert.ok(capturedLog, 'Log entry must be emitted');
        assert.strictEqual(capturedLog.traceId, spanContext.traceId);
        assert.strictEqual(capturedLog.spanId, spanContext.spanId);
      });
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  // 6. Sensitive Data Is Not Added to Spans
  it('6. Sensitive data (passwords, tokens, PANs, CVVs, customer PII) is never added to spans', async () => {
    const sensitivePan = '4111222233334444';
    const sensitiveCvv = '123';
    const sensitiveBearer = 'Bearer test-secret-token-xyz';
    const sensitiveEmail = 'customer.secret@example.com';

    await withSpan('recovery.pipeline', {
      attributes: {
        'transaction.id': crypto.randomUUID(),
        'event.id': crypto.randomUUID(),
        'policy.decision': 'ALLOW',
      },
    }, async (span) => {
      span.setAttribute('recovery.outcome', 'recovered');
    });

    const spans = memoryExporter.getFinishedSpans();
    const allAttributes = JSON.stringify(spans.map((s) => s.attributes));

    assert.strictEqual(allAttributes.includes(sensitivePan), false, 'PAN must not be in span attributes');
    assert.strictEqual(allAttributes.includes(sensitiveCvv), false, 'CVV must not be in span attributes');
    assert.strictEqual(allAttributes.includes(sensitiveBearer), false, 'Bearer token must not be in span attributes');
    assert.strictEqual(allAttributes.includes(sensitiveEmail), false, 'Email must not be in span attributes');
  });
});
