/**
 * RecoverIQ Core Metrics Service
 * Phase 6 - Step 2: Metrics, Health Checks & Readiness Probes
 *
 * Defines all production Prometheus metrics and provides clean, bounded
 * helper recording methods with strict label cardinality guards.
 */

import { defaultRegistry } from './registry.js';

export const ERROR_TYPES = {
  TIMEOUT: 'timeout',
  VALIDATION_ERROR: 'validation_error',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  POLICY_ERROR: 'policy_error',
  TOOL_ERROR: 'tool_error',
  KAFKA_ERROR: 'kafka_error',
  DATABASE_ERROR: 'database_error',
  AUTH_ERROR: 'auth_error',
  NOT_FOUND: 'not_found',
  UNKNOWN: 'unknown',
};

export class MetricsService {
  constructor(registry = defaultRegistry) {
    this.registry = registry;

    // 1. HTTP Metrics
    this.httpRequestsTotal = this.registry.createCounter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests processed by RecoverIQ backend',
      labelNames: ['method', 'route', 'status_code'],
    });

    this.httpRequestDurationSeconds = this.registry.createHistogram({
      name: 'http_request_duration_seconds',
      help: 'Latency distribution of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });

    this.httpErrorsTotal = this.registry.createCounter({
      name: 'http_errors_total',
      help: 'Total number of HTTP errors categorized by bounded error type',
      labelNames: ['method', 'route', 'error_type'],
    });

    // 2. Kafka Metrics
    this.kafkaMessagesConsumedTotal = this.registry.createCounter({
      name: 'kafka_messages_consumed_total',
      help: 'Total messages consumed from Kafka topics',
      labelNames: ['topic', 'consumer_group'],
    });

    this.kafkaMessagesProcessedTotal = this.registry.createCounter({
      name: 'kafka_messages_processed_total',
      help: 'Total messages processed by worker consumers',
      labelNames: ['topic', 'status'],
    });

    this.kafkaMessagesPublishedTotal = this.registry.createCounter({
      name: 'kafka_messages_published_total',
      help: 'Total messages published to Kafka topics',
      labelNames: ['topic', 'event_type'],
    });

    this.kafkaProcessingDurationSeconds = this.registry.createHistogram({
      name: 'kafka_processing_duration_seconds',
      help: 'End-to-end Kafka message processing duration in seconds',
      labelNames: ['topic', 'consumer_group'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    });

    // 3. Recovery Pipeline Metrics
    this.recoveryPipelineExecutionsTotal = this.registry.createCounter({
      name: 'recovery_pipeline_executions_total',
      help: 'Total recovery pipeline executions categorized by terminal status',
      labelNames: ['status'],
    });

    this.recoveryPipelineDurationSeconds = this.registry.createHistogram({
      name: 'recovery_pipeline_duration_seconds',
      help: 'Total recovery pipeline execution duration in seconds',
      labelNames: ['outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    });

    this.recoveryOutcomesTotal = this.registry.createCounter({
      name: 'recovery_outcomes_total',
      help: 'Total recovery outcomes categorized by outcome type and action',
      labelNames: ['outcome', 'action'],
    });

    // 4. Policy Engine Metrics
    this.policyEvaluationsTotal = this.registry.createCounter({
      name: 'policy_evaluations_total',
      help: 'Total policy evaluations categorized by decision and policy version',
      labelNames: ['decision', 'policy_version'],
    });

    this.policyEvaluationDurationSeconds = this.registry.createHistogram({
      name: 'policy_evaluation_duration_seconds',
      help: 'Latency distribution of deterministic policy evaluations',
      labelNames: ['decision'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
    });

    // 5. ML Service Metrics
    this.mlPredictionsTotal = this.registry.createCounter({
      name: 'ml_predictions_total',
      help: 'Total ML recovery predictions made',
      labelNames: ['model', 'fallback'],
    });

    this.mlPredictionDurationSeconds = this.registry.createHistogram({
      name: 'ml_prediction_duration_seconds',
      help: 'Latency distribution of ML inference calls in seconds',
      labelNames: ['model'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    });

    this.mlPredictionFailuresTotal = this.registry.createCounter({
      name: 'ml_prediction_failures_total',
      help: 'Total ML inference failures requiring fallback',
      labelNames: ['error_type'],
    });

    // 6. Agent 1 & Agent 2 Metrics
    this.agentInvocationsTotal = this.registry.createCounter({
      name: 'agent_invocations_total',
      help: 'Total GenAI agent invocations',
      labelNames: ['agent', 'fallback'],
    });

    this.agentInvocationDurationSeconds = this.registry.createHistogram({
      name: 'agent_invocation_duration_seconds',
      help: 'Latency distribution of GenAI agent invocations in seconds',
      labelNames: ['agent'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    });

    this.agentFailuresTotal = this.registry.createCounter({
      name: 'agent_failures_total',
      help: 'Total agent invocation failures or timeouts',
      labelNames: ['agent', 'error_type'],
    });

    // 7. Tool Execution Metrics
    this.toolExecutionsTotal = this.registry.createCounter({
      name: 'tool_executions_total',
      help: 'Total tool executions executed through execution gate',
      labelNames: ['action', 'status'],
    });

    this.toolExecutionDurationSeconds = this.registry.createHistogram({
      name: 'tool_execution_duration_seconds',
      help: 'Latency distribution of tool execution in seconds',
      labelNames: ['action'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    });

    // 8. Human-in-the-Loop Review Metrics
    this.hitlReviewsTotal = this.registry.createCounter({
      name: 'hitl_reviews_total',
      help: 'Total Human-in-the-Loop review actions submitted by merchants',
      labelNames: ['review_action', 'status'],
    });

    this.hitlPendingCreatedTotal = this.registry.createCounter({
      name: 'hitl_pending_created_total',
      help: 'Total recovery cases queued into pending_review state',
      labelNames: [],
    });

    // 9. DLQ & Replay Metrics
    this.dlqMessagesRoutedTotal = this.registry.createCounter({
      name: 'dlq_messages_routed_total',
      help: 'Total messages routed to dead-letter-events topic',
      labelNames: ['topic', 'failure_type'],
    });

    this.dlqReplaysTotal = this.registry.createCounter({
      name: 'dlq_replays_total',
      help: 'Total DLQ event replay attempts executed',
      labelNames: ['target_topic', 'status'],
    });
  }

  /**
   * Normalizes incoming Express request route to prevent high-cardinality URL templates
   */
  static normalizeRoute(req) {
    if (!req) return 'unknown';

    // 1. If Express matched a route definition, compose baseUrl + route.path
    if (req.route && req.route.path) {
      const baseUrl = req.baseUrl || '';
      const path = req.route.path === '/' && baseUrl ? '' : req.route.path;
      return `${baseUrl}${path}` || '/';
    }

    // 2. Fallback normalization on raw path (strip UUIDs and numeric IDs)
    const rawPath = (req.originalUrl || req.url || '').split('?')[0];
    if (!rawPath) return 'unknown';

    return rawPath
      .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, ':id')
      .replace(/\/[0-9a-fA-F]{24,32}(?=\/|$)/g, '/:id')
      .replace(/\/\d+(?=\/|$)/g, '/:id');
  }

  /**
   * Classifies arbitrary Error instances into bounded low-cardinality error categories
   */
  static classifyError(err) {
    if (!err) return ERROR_TYPES.UNKNOWN;
    const msg = String(err.message || '').toLowerCase();
    const code = String(err.code || '').toLowerCase();

    if (
      code === 'econnaborted' ||
      code === 'etimedout' ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('etimedout') ||
      msg.includes('econnaborted')
    ) {
      return ERROR_TYPES.TIMEOUT;
    }
    if (err.name === 'ZodError' || msg.includes('validation') || msg.includes('invalid') || code.includes('validation')) {
      return ERROR_TYPES.VALIDATION_ERROR;
    }
    if (
      code.includes('econnrefused') ||
      code.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('unavailable') ||
      msg.includes('unreachable') ||
      msg.includes('network error')
    ) {
      return ERROR_TYPES.DEPENDENCY_UNAVAILABLE;
    }
    if (msg.includes('policy') || code.includes('policy')) {
      return ERROR_TYPES.POLICY_ERROR;
    }
    if (msg.includes('tool') || code.includes('tool')) {
      return ERROR_TYPES.TOOL_ERROR;
    }
    if (msg.includes('kafka') || code.includes('kafka')) {
      return ERROR_TYPES.KAFKA_ERROR;
    }
    if (msg.includes('postgres') || msg.includes('database') || code.includes('pg') || err.isEntityMissing) {
      return ERROR_TYPES.DATABASE_ERROR;
    }
    if (msg.includes('unauthorized') || msg.includes('forbidden') || code === 'unauthorized') {
      return ERROR_TYPES.AUTH_ERROR;
    }
    if (msg.includes('not found') || code.includes('not_found')) {
      return ERROR_TYPES.NOT_FOUND;
    }
    return ERROR_TYPES.UNKNOWN;
  }

  // ---------------------------------------------------------------------------
  // Metric Recording Helper Methods
  // ---------------------------------------------------------------------------

  recordHttpRequest(method, route, statusCode, durationSeconds) {
    const safeMethod = String(method || 'GET').toUpperCase();
    const safeRoute = String(route || 'unknown');
    const safeStatus = String(statusCode || 200);

    this.httpRequestsTotal.inc({ method: safeMethod, route: safeRoute, status_code: safeStatus });
    if (typeof durationSeconds === 'number' && durationSeconds >= 0) {
      this.httpRequestDurationSeconds.observe({ method: safeMethod, route: safeRoute, status_code: safeStatus }, durationSeconds);
    }
  }

  recordHttpError(method, route, errorType) {
    const safeMethod = String(method || 'GET').toUpperCase();
    const safeRoute = String(route || 'unknown');
    const safeErr = String(errorType || ERROR_TYPES.UNKNOWN);
    this.httpErrorsTotal.inc({ method: safeMethod, route: safeRoute, error_type: safeErr });
  }

  recordKafkaConsumed(topic, consumerGroup) {
    this.kafkaMessagesConsumedTotal.inc({
      topic: String(topic || 'unknown'),
      consumer_group: String(consumerGroup || 'default'),
    });
  }

  recordKafkaProcessed(topic, status, durationSeconds) {
    const safeTopic = String(topic || 'unknown');
    const safeStatus = String(status || 'success');
    this.kafkaMessagesProcessedTotal.inc({ topic: safeTopic, status: safeStatus });

    if (typeof durationSeconds === 'number' && durationSeconds >= 0) {
      this.kafkaProcessingDurationSeconds.observe({ topic: safeTopic, consumer_group: 'default' }, durationSeconds);
    }
  }

  recordKafkaPublished(topic, eventType) {
    this.kafkaMessagesPublishedTotal.inc({
      topic: String(topic || 'unknown'),
      event_type: String(eventType || 'unknown'),
    });
  }

  recordRecoveryPipeline(outcome, action, durationSeconds) {
    const safeOutcome = String(outcome || 'unknown');
    const safeAction = String(action || 'none');

    this.recoveryPipelineExecutionsTotal.inc({ status: safeOutcome });
    this.recoveryOutcomesTotal.inc({ outcome: safeOutcome, action: safeAction });

    if (typeof durationSeconds === 'number' && durationSeconds >= 0) {
      this.recoveryPipelineDurationSeconds.observe({ outcome: safeOutcome }, durationSeconds);
    }
  }

  recordPolicyEvaluation(decision, policyVersion = 'v1', durationSeconds) {
    const safeDecision = String(decision || 'ALLOW');
    const safeVersion = String(policyVersion || 'v1');

    this.policyEvaluationsTotal.inc({ decision: safeDecision, policy_version: safeVersion });
    if (typeof durationSeconds === 'number' && durationSeconds >= 0) {
      this.policyEvaluationDurationSeconds.observe({ decision: safeDecision }, durationSeconds);
    }
  }

  recordMLPrediction(model = 'recoveriq-xgboost', isFallback = false, durationSeconds) {
    const safeModel = String(model || 'recoveriq-xgboost');
    const fallbackStr = String(!!isFallback);

    this.mlPredictionsTotal.inc({ model: safeModel, fallback: fallbackStr });
    if (typeof durationSeconds === 'number' && durationSeconds >= 0) {
      this.mlPredictionDurationSeconds.observe({ model: safeModel }, durationSeconds);
    }
  }

  recordMLFailure(errorType) {
    this.mlPredictionFailuresTotal.inc({ error_type: String(errorType || ERROR_TYPES.UNKNOWN) });
  }

  recordAgentInvocation(agent, isFallback = false, durationSeconds) {
    const safeAgent = String(agent || 'analyst');
    const fallbackStr = String(!!isFallback);

    this.agentInvocationsTotal.inc({ agent: safeAgent, fallback: fallbackStr });
    if (typeof durationSeconds === 'number' && durationSeconds >= 0) {
      this.agentInvocationDurationSeconds.observe({ agent: safeAgent }, durationSeconds);
    }
  }

  recordAgentFailure(agent, errorType) {
    const safeAgent = String(agent || 'analyst');
    const safeErr = String(errorType || ERROR_TYPES.UNKNOWN);
    this.agentFailuresTotal.inc({ agent: safeAgent, error_type: safeErr });
  }

  recordToolExecution(action, isSuccess, durationSeconds) {
    const safeAction = String(action || 'unknown');
    const status = isSuccess ? 'success' : 'failed';

    this.toolExecutionsTotal.inc({ action: safeAction, status });
    if (typeof durationSeconds === 'number' && durationSeconds >= 0) {
      this.toolExecutionDurationSeconds.observe({ action: safeAction }, durationSeconds);
    }
  }

  recordHitlReview(reviewAction, isSuccess) {
    const safeAction = String(reviewAction || 'APPROVE');
    const status = isSuccess ? 'success' : 'failed';
    this.hitlReviewsTotal.inc({ review_action: safeAction, status });
  }

  recordHitlPendingCreated() {
    this.hitlPendingCreatedTotal.inc();
  }

  recordDlqRouted(topic, failureType) {
    this.dlqMessagesRoutedTotal.inc({
      topic: String(topic || 'unknown'),
      failure_type: String(failureType || 'unhandled_error'),
    });
  }

  recordDlqReplay(targetTopic, status) {
    this.dlqReplaysTotal.inc({
      target_topic: String(targetTopic || 'unknown'),
      status: String(status || 'success'),
    });
  }

  reset() {
    this.registry.reset();
  }
}

export const metrics = new MetricsService(defaultRegistry);
