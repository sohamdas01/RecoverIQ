/**
 * RecoverIQ Metrics & Health Test Suite
 * Phase 6 - Step 2: Metrics, Health Checks & Readiness Probes
 *
 * Comprehensive unit and integration verification for:
 * A. Liveness Probes (/health/live)
 * B. Readiness Probes (/health/ready) with dependency checks and failure mocking
 * C. Prometheus Metrics Endpoint (/metrics)
 * D. HTTP Metrics & Middleware (rates, latencies, status codes, route normalization)
 * E. Recovery Pipeline Metrics (ALLOW, REQUIRE_APPROVAL, BLOCK outcomes)
 * F. Multi-Agent Metrics (Agent 1: Analyst vs Agent 2: Executor, fallbacks, latencies)
 * G. Machine Learning Metrics (predictions, fallbacks, latencies, failure counters)
 * H. Tool Execution Metrics (bounded actions, latencies, success/failure)
 * I. Human-in-the-Loop (HITL) Metrics (APPROVE, MODIFY, REJECT, pending queues)
 * J. Kafka, DLQ & Replay Metrics (consumed, processed, published, DLQ routed, replay)
 * K. Policy Engine Metrics (deterministic evaluations, policy versions, latencies)
 * L. Secret & Credential Safety (no leaked passwords, tokens, API keys, card PANs)
 * M. Cardinality Protection (no raw UUIDs, transactionIds, dynamic routes, or raw error strings in labels)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import axios from 'axios';

import {
  MetricsRegistry,
  MetricsService,
  defaultRegistry,
  metrics,
  classifyError,
  ERROR_TYPES,
  Counter,
  Gauge,
  Histogram,
} from '../services/metrics/index.js';
import { metricsMiddleware } from '../api/middleware/metrics.middleware.js';
import healthRoutes, { checkDependenciesHealth } from '../api/routes/health.routes.js';
import metricsRoutes from '../api/routes/metrics.routes.js';
import { closeDatabasePool } from '../db/index.js';
import { disconnectRedis } from '../redis/redis.client.js';
import { disconnectKafka } from '../kafka/kafka.client.js';

describe('Phase 6 - Step 2: Metrics, Health Checks & Readiness Probes', () => {
  let app;
  let server;
  let BASE_URL;
  let testRegistry;
  let testMetrics;

  before(async () => {
    testRegistry = new MetricsRegistry();
    testMetrics = new MetricsService(testRegistry);

    app = express();
    app.use(express.json());

    // Inject isolated test metrics and registry into app.locals
    app.locals.metricsService = testMetrics;
    app.locals.metricsRegistry = testRegistry;

    // Apply metrics middleware
    app.use(metricsMiddleware);

    // Mount health and metrics routes
    app.use('/health', healthRoutes);
    app.use('/metrics', metricsRoutes);

    // Mock API routes for HTTP metric verification
    app.get('/api/test/ok', (req, res) => {
      res.status(200).json({ status: 'ok' });
    });

    app.get('/api/test/slow', async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      res.status(200).json({ status: 'slow_ok' });
    });

    app.get('/api/test/bad-request', (req, res) => {
      res.status(400).json({ error: 'Bad Request' });
    });

    app.get('/api/test/not-found', (req, res) => {
      res.status(404).json({ error: 'Not Found' });
    });

    app.get('/api/test/unauthorized', (req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
    });

    app.get('/api/test/server-error', (req, res) => {
      res.status(500).json({ error: 'Internal Server Error' });
    });

    app.get('/api/transactions/:transactionId', (req, res) => {
      res.status(200).json({ transactionId: req.params.transactionId });
    });

    app.post('/api/admin/events/:eventId/replay', (req, res) => {
      res.status(200).json({ replayed: true, eventId: req.params.eventId });
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
    await disconnectKafka().catch(() => {});
    await disconnectRedis().catch(() => {});
    await closeDatabasePool().catch(() => {});
  });

  beforeEach(() => {
    testRegistry.reset();
    defaultRegistry.reset();
    // Reset app locals mocks
    delete app.locals.healthOptions;
    delete app.locals.kafkaChecker;
  });

  // =========================================================================
  // Section A: Liveness Probes
  // =========================================================================
  describe('A. Liveness Probe (GET /health/live)', () => {
    it('returns HTTP 200 with small, machine-readable JSON', async () => {
      const res = await axios.get(`${BASE_URL}/health/live`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'ok');
      assert.strictEqual(res.data.service, 'recoveriq-backend');
      assert.strictEqual(typeof res.data.uptime, 'number');
      assert.ok(res.data.timestamp);
      assert.ok(new Date(res.data.timestamp).getTime() > 0);
    });

    it('liveness remains HTTP 200 when PostgreSQL is simulated unavailable', async () => {
      // Liveness probe should only check that the Node.js event loop is operational
      app.locals.healthOptions = {
        pgChecker: async () => {
          throw new Error('Database connection lost');
        },
      };

      const res = await axios.get(`${BASE_URL}/health/live`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'ok');
    });

    it('liveness remains HTTP 200 when Redis is simulated unavailable', async () => {
      app.locals.healthOptions = {
        redisChecker: async () => {
          throw new Error('Redis connection refused');
        },
      };

      const res = await axios.get(`${BASE_URL}/health/live`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'ok');
    });

    it('liveness remains HTTP 200 when Kafka is simulated unreachable', async () => {
      app.locals.kafkaChecker = async () => ({
        status: 'unreachable',
        error: 'Broker connection timeout',
      });

      const res = await axios.get(`${BASE_URL}/health/live`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'ok');
    });
  });

  // =========================================================================
  // Section B: Readiness Probes
  // =========================================================================
  describe('B. Readiness Probe (GET /health/ready)', () => {
    it('returns HTTP 200 when all dependencies are healthy', async () => {
      app.locals.healthOptions = {
        pgChecker: async () => ({ rowCount: 1 }),
        redisChecker: async () => 'PONG',
        kafkaChecker: async () => ({ status: 'healthy', brokers: ['redpanda:19092'], topics: ['payment-events'] }),
      };

      const res = await axios.get(`${BASE_URL}/health/ready`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'ok');
      assert.strictEqual(res.data.service, 'recoveriq-backend');
      assert.deepStrictEqual(res.data.dependencies, {
        postgres: 'ok',
        redis: 'ok',
        kafka: 'ok',
      });
    });

    it('returns HTTP 503 when PostgreSQL is unavailable', async () => {
      app.locals.healthOptions = {
        pgChecker: async () => {
          throw new Error('PG connection timeout');
        },
        redisChecker: async () => 'PONG',
        kafkaChecker: async () => ({ status: 'healthy' }),
      };

      try {
        await axios.get(`${BASE_URL}/health/ready`);
        assert.fail('Expected HTTP 503');
      } catch (err) {
        assert.strictEqual(err.response.status, 503);
        assert.strictEqual(err.response.data.status, 'not_ready');
        assert.strictEqual(err.response.data.dependencies.postgres, 'unavailable');
        assert.strictEqual(err.response.data.dependencies.redis, 'ok');
        assert.strictEqual(err.response.data.dependencies.kafka, 'ok');
      }
    });

    it('returns HTTP 503 when Redis is unavailable', async () => {
      app.locals.healthOptions = {
        pgChecker: async () => ({ rowCount: 1 }),
        redisChecker: async () => {
          throw new Error('Redis ECONNREFUSED');
        },
        kafkaChecker: async () => ({ status: 'healthy' }),
      };

      try {
        await axios.get(`${BASE_URL}/health/ready`);
        assert.fail('Expected HTTP 503');
      } catch (err) {
        assert.strictEqual(err.response.status, 503);
        assert.strictEqual(err.response.data.status, 'not_ready');
        assert.strictEqual(err.response.data.dependencies.postgres, 'ok');
        assert.strictEqual(err.response.data.dependencies.redis, 'unavailable');
        assert.strictEqual(err.response.data.dependencies.kafka, 'ok');
      }
    });

    it('returns HTTP 503 when Kafka is unavailable', async () => {
      app.locals.healthOptions = {
        pgChecker: async () => ({ rowCount: 1 }),
        redisChecker: async () => 'PONG',
        kafkaChecker: async () => ({ status: 'unreachable', error: 'No brokers available' }),
      };

      try {
        await axios.get(`${BASE_URL}/health/ready`);
        assert.fail('Expected HTTP 503');
      } catch (err) {
        assert.strictEqual(err.response.status, 503);
        assert.strictEqual(err.response.data.status, 'not_ready');
        assert.strictEqual(err.response.data.dependencies.postgres, 'ok');
        assert.strictEqual(err.response.data.dependencies.redis, 'ok');
        assert.strictEqual(err.response.data.dependencies.kafka, 'unavailable');
      }
    });

    it('returns HTTP 503 when multiple dependencies fail simultaneously', async () => {
      app.locals.healthOptions = {
        pgChecker: async () => {
          throw new Error('Postgres down');
        },
        redisChecker: async () => {
          throw new Error('Redis down');
        },
        kafkaChecker: async () => {
          throw new Error('Kafka down');
        },
      };

      try {
        await axios.get(`${BASE_URL}/health/ready`);
        assert.fail('Expected HTTP 503');
      } catch (err) {
        assert.strictEqual(err.response.status, 503);
        assert.strictEqual(err.response.data.status, 'not_ready');
        assert.strictEqual(err.response.data.dependencies.postgres, 'unavailable');
        assert.strictEqual(err.response.data.dependencies.redis, 'unavailable');
        assert.strictEqual(err.response.data.dependencies.kafka, 'unavailable');
      }
    });

    it('checkDependenciesHealth helper isolates errors and never throws unhandled exceptions', async () => {
      const result = await checkDependenciesHealth({
        timeoutMs: 50,
        pgChecker: async () => {
          throw new Error('Fatal socket failure');
        },
        redisChecker: async () => {
          throw new Error('Redis crashed');
        },
        kafkaChecker: async () => {
          throw new Error('Kafka partition offline');
        },
      });

      assert.strictEqual(result.isReady, false);
      assert.strictEqual(result.status, 'not_ready');
      assert.strictEqual(result.dependencies.postgres, 'unavailable');
      assert.strictEqual(result.dependencies.redis, 'unavailable');
      assert.strictEqual(result.dependencies.kafka, 'unavailable');
    });
  });

  // =========================================================================
  // Section C: Prometheus Metrics Endpoint
  // =========================================================================
  describe('C. Prometheus Metrics Endpoint (GET /metrics)', () => {
    it('returns HTTP 200 with standard Prometheus Content-Type', async () => {
      const res = await axios.get(`${BASE_URL}/metrics`);

      assert.strictEqual(res.status, 200);
      assert.ok(
        res.headers['content-type'].includes('text/plain'),
        `Content-Type should be text/plain, got: ${res.headers['content-type']}`
      );
      assert.ok(
        res.headers['content-type'].includes('version=0.0.4'),
        `Content-Type should include version=0.0.4, got: ${res.headers['content-type']}`
      );
    });

    it('exposes all core production metric definitions with HELP and TYPE lines', async () => {
      const res = await axios.get(`${BASE_URL}/metrics`);
      const body = res.data;

      const expectedMetrics = [
        'http_requests_total',
        'http_request_duration_seconds',
        'http_errors_total',
        'kafka_messages_consumed_total',
        'kafka_messages_processed_total',
        'kafka_messages_published_total',
        'kafka_processing_duration_seconds',
        'recovery_pipeline_executions_total',
        'recovery_pipeline_duration_seconds',
        'recovery_outcomes_total',
        'policy_evaluations_total',
        'policy_evaluation_duration_seconds',
        'ml_predictions_total',
        'ml_prediction_duration_seconds',
        'ml_prediction_failures_total',
        'agent_invocations_total',
        'agent_invocation_duration_seconds',
        'agent_failures_total',
        'tool_executions_total',
        'tool_execution_duration_seconds',
        'hitl_reviews_total',
        'hitl_pending_created_total',
        'dlq_messages_routed_total',
        'dlq_replays_total',
      ];

      for (const metricName of expectedMetrics) {
        assert.ok(
          body.includes(`# HELP ${metricName}`),
          `Prometheus output missing # HELP for ${metricName}`
        );
        assert.ok(
          body.includes(`# TYPE ${metricName}`),
          `Prometheus output missing # TYPE for ${metricName}`
        );
      }
    });

    it('metrics text is syntactically parseable into Prometheus series format', async () => {
      testMetrics.recordPolicyEvaluation('ALLOW', 'v1', 0.002);
      testMetrics.recordRecoveryPipeline('recovered', 'attempt_recovery', 0.12);

      const res = await axios.get(`${BASE_URL}/metrics`);
      const lines = res.data.split('\n');

      let foundPolicyEvaluation = false;
      let foundRecoveryExecution = false;

      for (const line of lines) {
        if (line.startsWith('#') || !line.trim()) continue;

        // Verify standard metric{labels} value or metric value syntax
        const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+([0-9eE.+-]+)$/);
        assert.ok(match, `Invalid Prometheus metric line format: "${line}"`);

        if (line.includes('policy_evaluations_total{decision="ALLOW",policy_version="v1"} 1')) {
          foundPolicyEvaluation = true;
        }
        if (line.includes('recovery_pipeline_executions_total{status="recovered"} 1')) {
          foundRecoveryExecution = true;
        }
      }

      assert.ok(foundPolicyEvaluation, 'Expected policy_evaluations_total series in metrics text');
      assert.ok(foundRecoveryExecution, 'Expected recovery_pipeline_executions_total series in metrics text');
    });
  });

  // =========================================================================
  // Section D: HTTP Metrics & Middleware
  // =========================================================================
  describe('D. HTTP Metrics & Route Normalization', () => {
    it('records incoming request counts and duration histograms', async () => {
      await axios.get(`${BASE_URL}/api/test/ok`);
      await axios.get(`${BASE_URL}/api/test/slow`);

      const reqCount = testMetrics.httpRequestsTotal.get({
        method: 'GET',
        route: '/api/test/ok',
        status_code: '200',
      });
      assert.strictEqual(reqCount, 1);

      const slowCount = testMetrics.httpRequestsTotal.get({
        method: 'GET',
        route: '/api/test/slow',
        status_code: '200',
      });
      assert.strictEqual(slowCount, 1);

      const histText = testMetrics.httpRequestDurationSeconds.toPrometheusText();
      assert.ok(histText.includes('http_request_duration_seconds_count{method="GET",route="/api/test/slow",status_code="200"} 1'));
    });

    it('classifies HTTP errors into bounded error types without cardinality explosion', async () => {
      try {
        await axios.get(`${BASE_URL}/api/test/bad-request`);
      } catch (_) {}

      try {
        await axios.get(`${BASE_URL}/api/test/not-found`);
      } catch (_) {}

      try {
        await axios.get(`${BASE_URL}/api/test/unauthorized`);
      } catch (_) {}

      try {
        await axios.get(`${BASE_URL}/api/test/server-error`);
      } catch (_) {}

      assert.strictEqual(
        testMetrics.httpErrorsTotal.get({
          method: 'GET',
          route: '/api/test/bad-request',
          error_type: ERROR_TYPES.VALIDATION_ERROR,
        }),
        1
      );

      assert.strictEqual(
        testMetrics.httpErrorsTotal.get({
          method: 'GET',
          route: '/api/test/not-found',
          error_type: ERROR_TYPES.NOT_FOUND,
        }),
        1
      );

      assert.strictEqual(
        testMetrics.httpErrorsTotal.get({
          method: 'GET',
          route: '/api/test/unauthorized',
          error_type: ERROR_TYPES.AUTH_ERROR,
        }),
        1
      );

      assert.strictEqual(
        testMetrics.httpErrorsTotal.get({
          method: 'GET',
          route: '/api/test/server-error',
          error_type: ERROR_TYPES.UNKNOWN,
        }),
        1
      );
    });

    it('normalizes dynamic route parameters (:transactionId, :eventId, UUIDs) to prevent high-cardinality label pollution', async () => {
      const uuid1 = '9a0b5f33-4bf1-4eda-909f-fb3e55c4a7b2';
      const uuid2 = 'c46387ae-386e-4cb4-a6ec-6595efe3e3cd';

      await axios.get(`${BASE_URL}/api/transactions/${uuid1}`);
      await axios.get(`${BASE_URL}/api/transactions/${uuid2}`);
      await axios.post(`${BASE_URL}/api/admin/events/${uuid1}/replay`);

      const txRouteCount = testMetrics.httpRequestsTotal.get({
        method: 'GET',
        route: '/api/transactions/:transactionId',
        status_code: '200',
      });
      assert.strictEqual(txRouteCount, 2, 'Dynamic transaction IDs should map to normalized template');

      const replayRouteCount = testMetrics.httpRequestsTotal.get({
        method: 'POST',
        route: '/api/admin/events/:eventId/replay',
        status_code: '200',
      });
      assert.strictEqual(replayRouteCount, 1, 'Replay event route should normalize :eventId parameter');

      // Verify raw UUIDs never appear in metrics text
      const metricsText = testRegistry.getMetrics();
      assert.ok(!metricsText.includes(uuid1), `Metric output leaked raw UUID ${uuid1}`);
      assert.ok(!metricsText.includes(uuid2), `Metric output leaked raw UUID ${uuid2}`);
    });
  });

  // =========================================================================
  // Section E: Recovery Pipeline Metrics
  // =========================================================================
  describe('E. Recovery Pipeline Execution Metrics', () => {
    it('records ALLOW, REQUIRE_APPROVAL, and BLOCK pipeline outcomes', () => {
      testMetrics.recordRecoveryPipeline('recovered', 'attempt_recovery', 0.15);
      testMetrics.recordRecoveryPipeline('scheduled', 'schedule_retry', 0.08);
      testMetrics.recordRecoveryPipeline('pending_review', 'none', 0.04);
      testMetrics.recordRecoveryPipeline('blocked', 'none', 0.02);

      assert.strictEqual(testMetrics.recoveryPipelineExecutionsTotal.get({ status: 'recovered' }), 1);
      assert.strictEqual(testMetrics.recoveryPipelineExecutionsTotal.get({ status: 'scheduled' }), 1);
      assert.strictEqual(testMetrics.recoveryPipelineExecutionsTotal.get({ status: 'pending_review' }), 1);
      assert.strictEqual(testMetrics.recoveryPipelineExecutionsTotal.get({ status: 'blocked' }), 1);

      assert.strictEqual(testMetrics.recoveryOutcomesTotal.get({ outcome: 'recovered', action: 'attempt_recovery' }), 1);
      assert.strictEqual(testMetrics.recoveryOutcomesTotal.get({ outcome: 'scheduled', action: 'schedule_retry' }), 1);
      assert.strictEqual(testMetrics.recoveryOutcomesTotal.get({ outcome: 'pending_review', action: 'none' }), 1);
      assert.strictEqual(testMetrics.recoveryOutcomesTotal.get({ outcome: 'blocked', action: 'none' }), 1);

      const histOutput = testMetrics.recoveryPipelineDurationSeconds.toPrometheusText();
      assert.ok(histOutput.includes('recovery_pipeline_duration_seconds_count{outcome="recovered"} 1'));
    });
  });

  // =========================================================================
  // Section F: Multi-Agent Metrics (Agent 1: Analyst vs Agent 2: Executor)
  // =========================================================================
  describe('F. Multi-Agent Metrics (Agent 1 & Agent 2)', () => {
    it('distinguishes Agent 1 (Analyst) and Agent 2 (Executor) invocations and latencies', () => {
      testMetrics.recordAgentInvocation('analyst', false, 0.45);
      testMetrics.recordAgentInvocation('analyst', true, 0.01);
      testMetrics.recordAgentInvocation('executor', false, 0.32);

      assert.strictEqual(testMetrics.agentInvocationsTotal.get({ agent: 'analyst', fallback: 'false' }), 1);
      assert.strictEqual(testMetrics.agentInvocationsTotal.get({ agent: 'analyst', fallback: 'true' }), 1);
      assert.strictEqual(testMetrics.agentInvocationsTotal.get({ agent: 'executor', fallback: 'false' }), 1);
      assert.strictEqual(testMetrics.agentInvocationsTotal.get({ agent: 'executor', fallback: 'true' }), 0);

      const analystHist = testMetrics.agentInvocationDurationSeconds.toPrometheusText();
      assert.ok(analystHist.includes('agent_invocation_duration_seconds_count{agent="analyst"} 2'));
      assert.ok(analystHist.includes('agent_invocation_duration_seconds_count{agent="executor"} 1'));
    });

    it('records agent failure and timeout events with bounded classification', () => {
      testMetrics.recordAgentFailure('analyst', ERROR_TYPES.TIMEOUT);
      testMetrics.recordAgentFailure('analyst', ERROR_TYPES.VALIDATION_ERROR);
      testMetrics.recordAgentFailure('executor', ERROR_TYPES.DEPENDENCY_UNAVAILABLE);

      assert.strictEqual(testMetrics.agentFailuresTotal.get({ agent: 'analyst', error_type: 'timeout' }), 1);
      assert.strictEqual(testMetrics.agentFailuresTotal.get({ agent: 'analyst', error_type: 'validation_error' }), 1);
      assert.strictEqual(testMetrics.agentFailuresTotal.get({ agent: 'executor', error_type: 'dependency_unavailable' }), 1);
    });
  });

  // =========================================================================
  // Section G: Machine Learning Metrics
  // =========================================================================
  describe('G. Machine Learning Service Metrics', () => {
    it('records ML predictions, fallback flags, and latency distribution', () => {
      testMetrics.recordMLPrediction('recoveriq-xgboost', false, 0.035);
      testMetrics.recordMLPrediction('recoveriq-xgboost', false, 0.042);
      testMetrics.recordMLPrediction('recoveriq-xgboost', true, 0.001);

      assert.strictEqual(testMetrics.mlPredictionsTotal.get({ model: 'recoveriq-xgboost', fallback: 'false' }), 2);
      assert.strictEqual(testMetrics.mlPredictionsTotal.get({ model: 'recoveriq-xgboost', fallback: 'true' }), 1);

      const mlHist = testMetrics.mlPredictionDurationSeconds.toPrometheusText();
      assert.ok(mlHist.includes('ml_prediction_duration_seconds_count{model="recoveriq-xgboost"} 3'));
    });

    it('records ML inference failure counters categorized by error type', () => {
      testMetrics.recordMLFailure(ERROR_TYPES.TIMEOUT);
      testMetrics.recordMLFailure(ERROR_TYPES.DEPENDENCY_UNAVAILABLE);

      assert.strictEqual(testMetrics.mlPredictionFailuresTotal.get({ error_type: 'timeout' }), 1);
      assert.strictEqual(testMetrics.mlPredictionFailuresTotal.get({ error_type: 'dependency_unavailable' }), 1);
    });
  });

  // =========================================================================
  // Section H: Tool Execution Metrics
  // =========================================================================
  describe('H. Tool Execution Metrics', () => {
    it('records tool executions, statuses, and latencies across bounded recovery tools', () => {
      testMetrics.recordToolExecution('attempt_recovery', true, 0.25);
      testMetrics.recordToolExecution('schedule_retry', true, 0.05);
      testMetrics.recordToolExecution('send_recovery_message', true, 0.12);
      testMetrics.recordToolExecution('attempt_recovery', false, 0.50);

      assert.strictEqual(testMetrics.toolExecutionsTotal.get({ action: 'attempt_recovery', status: 'success' }), 1);
      assert.strictEqual(testMetrics.toolExecutionsTotal.get({ action: 'schedule_retry', status: 'success' }), 1);
      assert.strictEqual(testMetrics.toolExecutionsTotal.get({ action: 'send_recovery_message', status: 'success' }), 1);
      assert.strictEqual(testMetrics.toolExecutionsTotal.get({ action: 'attempt_recovery', status: 'failed' }), 1);

      const toolHist = testMetrics.toolExecutionDurationSeconds.toPrometheusText();
      assert.ok(toolHist.includes('tool_execution_duration_seconds_count{action="attempt_recovery"} 2'));
      assert.ok(toolHist.includes('tool_execution_duration_seconds_count{action="schedule_retry"} 1'));
    });
  });

  // =========================================================================
  // Section I: Human-in-the-Loop (HITL) Metrics
  // =========================================================================
  describe('I. Human-in-the-Loop (HITL) Metrics', () => {
    it('tracks APPROVE, MODIFY, REJECT merchant reviews and pending case creations', () => {
      testMetrics.recordHitlPendingCreated();
      testMetrics.recordHitlPendingCreated();
      testMetrics.recordHitlReview('APPROVE', true);
      testMetrics.recordHitlReview('MODIFY', true);
      testMetrics.recordHitlReview('REJECT', true);
      testMetrics.recordHitlReview('APPROVE', false);

      assert.strictEqual(testMetrics.hitlPendingCreatedTotal.get(), 2);
      assert.strictEqual(testMetrics.hitlReviewsTotal.get({ review_action: 'APPROVE', status: 'success' }), 1);
      assert.strictEqual(testMetrics.hitlReviewsTotal.get({ review_action: 'MODIFY', status: 'success' }), 1);
      assert.strictEqual(testMetrics.hitlReviewsTotal.get({ review_action: 'REJECT', status: 'success' }), 1);
      assert.strictEqual(testMetrics.hitlReviewsTotal.get({ review_action: 'APPROVE', status: 'failed' }), 1);
    });
  });

  // =========================================================================
  // Section J: Kafka, DLQ & Replay Metrics
  // =========================================================================
  describe('J. Kafka, DLQ & Replay Metrics', () => {
    it('records Kafka message consumption, processing, and publishing counts', () => {
      testMetrics.recordKafkaConsumed('payment-events', 'recovery-worker-group');
      testMetrics.recordKafkaConsumed('payment-events', 'recovery-worker-group');
      testMetrics.recordKafkaProcessed('payment-events', 'success', 0.04);
      testMetrics.recordKafkaPublished('payment-events', 'payment.failed');
      testMetrics.recordKafkaPublished('recovery-outcomes', 'recovery.completed');

      assert.strictEqual(
        testMetrics.kafkaMessagesConsumedTotal.get({
          topic: 'payment-events',
          consumer_group: 'recovery-worker-group',
        }),
        2
      );

      assert.strictEqual(
        testMetrics.kafkaMessagesProcessedTotal.get({
          topic: 'payment-events',
          status: 'success',
        }),
        1
      );

      assert.strictEqual(
        testMetrics.kafkaMessagesPublishedTotal.get({
          topic: 'payment-events',
          event_type: 'payment.failed',
        }),
        1
      );

      assert.strictEqual(
        testMetrics.kafkaMessagesPublishedTotal.get({
          topic: 'recovery-outcomes',
          event_type: 'recovery.completed',
        }),
        1
      );
    });

    it('records DLQ routing and DLQ event replay counters', () => {
      testMetrics.recordDlqRouted('payment-events', 'poison_message');
      testMetrics.recordDlqRouted('payment-events', 'transient_exhausted');
      testMetrics.recordDlqReplay('payment-events', 'success');
      testMetrics.recordDlqReplay('payment-events', 'failed');

      assert.strictEqual(
        testMetrics.dlqMessagesRoutedTotal.get({
          topic: 'payment-events',
          failure_type: 'poison_message',
        }),
        1
      );

      assert.strictEqual(
        testMetrics.dlqMessagesRoutedTotal.get({
          topic: 'payment-events',
          failure_type: 'transient_exhausted',
        }),
        1
      );

      assert.strictEqual(
        testMetrics.dlqReplaysTotal.get({
          target_topic: 'payment-events',
          status: 'success',
        }),
        1
      );

      assert.strictEqual(
        testMetrics.dlqReplaysTotal.get({
          target_topic: 'payment-events',
          status: 'failed',
        }),
        1
      );
    });
  });

  // =========================================================================
  // Section K: Policy Engine Metrics
  // =========================================================================
  describe('K. Policy Engine Metrics', () => {
    it('records policy evaluations with bounded decisions and version labels', () => {
      testMetrics.recordPolicyEvaluation('ALLOW', 'v1', 0.001);
      testMetrics.recordPolicyEvaluation('REQUIRE_APPROVAL', 'v1', 0.002);
      testMetrics.recordPolicyEvaluation('BLOCK', 'v1', 0.001);

      assert.strictEqual(testMetrics.policyEvaluationsTotal.get({ decision: 'ALLOW', policy_version: 'v1' }), 1);
      assert.strictEqual(testMetrics.policyEvaluationsTotal.get({ decision: 'REQUIRE_APPROVAL', policy_version: 'v1' }), 1);
      assert.strictEqual(testMetrics.policyEvaluationsTotal.get({ decision: 'BLOCK', policy_version: 'v1' }), 1);

      const policyHist = testMetrics.policyEvaluationDurationSeconds.toPrometheusText();
      assert.ok(policyHist.includes('policy_evaluation_duration_seconds_count{decision="ALLOW"} 1'));
      assert.ok(policyHist.includes('policy_evaluation_duration_seconds_count{decision="BLOCK"} 1'));
    });
  });

  // =========================================================================
  // Section L: Secret & Credential Safety
  // =========================================================================
  describe('L. Secret & Credential Safety in Metrics & Health', () => {
    it('metrics text output contains zero sensitive tokens, passwords, keys, or PANs', () => {
      // Simulate multiple metrics recordings with varied labels
      testMetrics.recordHttpRequest('GET', '/api/test/ok', 200, 0.01);
      testMetrics.recordPolicyEvaluation('ALLOW', 'v1', 0.002);
      testMetrics.recordAgentInvocation('analyst', false, 0.2);
      testMetrics.recordRecoveryPipeline('recovered', 'attempt_recovery', 0.1);

      const metricsOutput = testRegistry.getMetrics();

      const forbiddenTokens = [
        'password',
        'secret',
        'bearer',
        'token',
        'apikey',
        'authorization',
        'jwt',
        'cvv',
        'pan',
        'card_number',
      ];

      const lowerOutput = metricsOutput.toLowerCase();
      for (const token of forbiddenTokens) {
        // Confirm forbidden credential words are not present as label keys or values
        assert.ok(
          !lowerOutput.includes(`${token}=`),
          `Metrics output should not contain sensitive key: ${token}=`
        );
      }
    });

    it('health probes NEVER leak database connection strings or passwords in failure details', async () => {
      const result = await checkDependenciesHealth({
        pgChecker: async () => {
          throw new Error('connection to server at "postgres://admin:super_secret_password_123@db:5432/recoveriq" failed');
        },
      });

      assert.strictEqual(result.isReady, false);
      assert.strictEqual(result.dependencies.postgres, 'unavailable');

      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes('super_secret_password_123'), 'Health probe response leaked database password!');
      assert.ok(!serialized.includes('postgres://'), 'Health probe response leaked connection string!');
    });
  });

  // =========================================================================
  // Section M: Cardinality Guard Tests
  // =========================================================================
  describe('M. Cardinality Guard & Error Classification', () => {
    it('MetricsService.normalizeRoute handles complex dynamic URLs cleanly', () => {
      const cases = [
        {
          req: { baseUrl: '/api/transactions', route: { path: '/:transactionId' } },
          expected: '/api/transactions/:transactionId',
        },
        {
          req: { originalUrl: '/api/transactions/4bc600fe-14af-4be0-b1ff-95b9c9bc7170' },
          expected: '/api/transactions/:id',
        },
        {
          req: { originalUrl: '/api/admin/events/123456789/replay' },
          expected: '/api/admin/events/:id/replay',
        },
        {
          req: { originalUrl: '/api/customers/507f1f77bcf86cd799439011' },
          expected: '/api/customers/:id',
        },
        {
          req: { originalUrl: '/health/live?verbose=true&check=all' },
          expected: '/health/live',
        },
        {
          req: null,
          expected: 'unknown',
        },
      ];

      for (const testCase of cases) {
        const normalized = MetricsService.normalizeRoute(testCase.req);
        assert.strictEqual(normalized, testCase.expected);
      }
    });

    it('classifyError maps arbitrary error messages into strictly bounded categories', () => {
      const testCases = [
        { err: new Error('connect ETIMEDOUT 10.0.0.1:8000'), expected: ERROR_TYPES.TIMEOUT },
        { err: new Error('Request timed out after 5000ms'), expected: ERROR_TYPES.TIMEOUT },
        { err: { name: 'ZodError', message: 'amount: Required' }, expected: ERROR_TYPES.VALIDATION_ERROR },
        { err: new Error('Invalid schema contract payload'), expected: ERROR_TYPES.VALIDATION_ERROR },
        { err: new Error('connect ECONNREFUSED 127.0.0.1:6379'), expected: ERROR_TYPES.DEPENDENCY_UNAVAILABLE },
        { err: new Error('Policy rule evaluation failed'), expected: ERROR_TYPES.POLICY_ERROR },
        { err: new Error('Tool execution failed on Razorpay retry'), expected: ERROR_TYPES.TOOL_ERROR },
        { err: new Error('Kafka broker connection closed'), expected: ERROR_TYPES.KAFKA_ERROR },
        { err: new Error('Postgres query error in transactions table'), expected: ERROR_TYPES.DATABASE_ERROR },
        { err: new Error('Unauthorized merchant credentials'), expected: ERROR_TYPES.AUTH_ERROR },
        { err: new Error('Requested resource not found'), expected: ERROR_TYPES.NOT_FOUND },
        { err: new Error('Uncategorized strange runtime exception'), expected: ERROR_TYPES.UNKNOWN },
        { err: null, expected: ERROR_TYPES.UNKNOWN },
      ];

      for (const { err, expected } of testCases) {
        assert.strictEqual(classifyError(err), expected);
      }
    });

    it('Counter, Gauge, and Histogram registries correctly escape and serialize bounded labels', () => {
      const counter = new Counter({ name: 'test_counter', help: 'Test counter metric', labelNames: ['env', 'status'] });
      counter.inc({ env: 'prod"quote', status: 'ok\nnewline' }, 5);

      const prometheusText = counter.toPrometheusText();
      assert.ok(prometheusText.includes('test_counter{env="prod\\"quote",status="ok\\nnewline"} 5'));

      const gauge = new Gauge({ name: 'test_gauge', help: 'Test gauge metric', labelNames: ['state'] });
      gauge.set({ state: 'active' }, 42);
      assert.strictEqual(gauge.get({ state: 'active' }), 42);
      gauge.inc({ state: 'active' }, 3);
      assert.strictEqual(gauge.get({ state: 'active' }), 45);
      gauge.dec({ state: 'active' }, 5);
      assert.strictEqual(gauge.get({ state: 'active' }), 40);

      const hist = new Histogram({ name: 'test_hist', help: 'Test histogram metric', labelNames: ['route'] });
      hist.observe({ route: '/test' }, 0.05);
      hist.observe({ route: '/test' }, 0.25);
      const histText = hist.toPrometheusText();
      assert.ok(histText.includes('test_hist_count{route="/test"} 2'));
      assert.ok(histText.includes('test_hist_sum{route="/test"} 0.300000'));
    });
  });
});
