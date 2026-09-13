import crypto from 'crypto';
import { createConsumer } from '../kafka.client.js';
import { config } from '../../services/config/index.js';
import {
  EVENT_TYPES,
  OUTCOME_TYPES,
  deserializeEvent,
  validatePaymentEvent,
} from '../schemas/events.schema.js';
import { publishOutcomeEvent } from '../producer.js';
import { getTransactionById, getCustomerStats } from '../../db/queries/transactions.queries.js';
import { RecoveryOrchestrator } from '../../services/recovery/index.js';
import { checkIdempotency } from '../../redis/redis.client.js';
import {
  isTransientError,
  classifyError,
  executeWithRetry,
  routeToDlq,
} from '../dlq.service.js';
import {
  logger,
  runWithCorrelationContext,
  updateCorrelationContext,
  sanitizeCorrelationId,
} from '../../services/logger/index.js';
import { metrics } from '../../services/metrics/index.js';
import { withSpan, extractTraceContext, kafkaHeaderGetter } from '../../services/observability/tracing.service.js';
import { SpanKind } from '@opentelemetry/api';

const consumerLogger = logger.withComponent('recovery_consumer');

let recoveryConsumerInstance = null;
let isRunning = false;

function getHeaderStr(headers, key) {
  if (!headers || headers[key] === undefined || headers[key] === null) return undefined;
  const val = headers[key];
  return Buffer.isBuffer(val) ? val.toString('utf-8') : String(val);
}

/**
 * Process a single payment failure event from payment-events topic
 */
export async function processPaymentMessage({ topic, partition, message, consumer, retryConfig = {} }) {
  const startTime = Date.now();
  let rawPayload = null;
  const headerRequestId = sanitizeCorrelationId(getHeaderStr(message.headers, 'requestId') || getHeaderStr(message.headers, 'x-request-id'));
  const headerCorrelationId = sanitizeCorrelationId(getHeaderStr(message.headers, 'correlationId') || getHeaderStr(message.headers, 'x-correlation-id')) || headerRequestId;
  const headerOriginalEventId = getHeaderStr(message.headers, 'originalEventId');
  const headerReplayEventId = getHeaderStr(message.headers, 'replayEventId');
  let eventId = getHeaderStr(message.headers, 'eventId');
  let transactionId = getHeaderStr(message.headers, 'transactionId');
  let customerId = getHeaderStr(message.headers, 'customerId');

  const initialContext = {
    requestId: headerRequestId,
    correlationId: headerCorrelationId,
    originalEventId: headerOriginalEventId,
    replayEventId: headerReplayEventId,
    eventId,
    transactionId,
    customerId,
  };

  metrics.recordKafkaConsumed(topic, 'recovery-worker-group');

  // Extract W3C trace context from Kafka headers
  const parentTraceContext = extractTraceContext(message.headers, kafkaHeaderGetter);

  return withSpan(`kafka.consume ${topic}`, {
    kind: SpanKind.CONSUMER,
    parentContext: parentTraceContext,
    attributes: {
      'messaging.system': 'kafka',
      'messaging.source': topic,
      'messaging.kafka.partition': partition,
      'messaging.kafka.consumer_group': 'recovery-worker-group',
      'component': 'recovery_consumer',
    },
  }, async (consumerSpan) => {
    return runWithCorrelationContext(initialContext, async () => {

    try {
      // 1. Deserialize message (Poison message check)
      const deserialized = deserializeEvent(message.value);
      if (!deserialized.success) {
        metrics.recordKafkaProcessed(topic, 'failed', (Date.now() - startTime) / 1000);
        metrics.recordDlqRouted(topic, 'poison_message');
        consumerLogger.error('Deserialization error on payment event', {
          topic,
          partition,
          offset: message.offset,
          error: deserialized.error,
        });
        const dlqResult = await routeToDlq({
        topic,
        partition,
        offset: message.offset,
        error: new Error(deserialized.error),
        failureType: 'poison_message',
        retryCount: 0,
        originalPayload: message.value ? (Buffer.isBuffer(message.value) ? message.value.toString('utf-8') : String(message.value)) : null,
        originalEventId: eventId,
        transactionId,
        customerId,
      });

      if (consumer) {
        await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
      }
      return { success: false, routedToDlq: true, failureType: 'poison_message', error: deserialized.error, dlqEventId: dlqResult.eventId };
    }

    rawPayload = deserialized.data;
    eventId = rawPayload?.eventId || eventId;
    transactionId = rawPayload?.transactionId || transactionId;
    customerId = rawPayload?.customerId || customerId;

    updateCorrelationContext({
      eventId,
      transactionId,
      customerId,
      originalEventId: rawPayload?.originalEventId || headerOriginalEventId,
      replayEventId: rawPayload?.replayEventId || headerReplayEventId,
    });

    // 2. Validate against Zod PaymentEventSchema contract
    const validation = validatePaymentEvent(rawPayload);
    if (!validation.success) {
      metrics.recordKafkaProcessed(topic, 'failed', (Date.now() - startTime) / 1000);
      metrics.recordDlqRouted(topic, 'schema_validation_error');
      consumerLogger.error('Payment event contract validation rejected', {
        topic,
        partition,
        offset: message.offset,
        error: validation.errorMessage,
        validationErrors: validation.errors,
      });
      const dlqResult = await routeToDlq({
        topic,
        partition,
        offset: message.offset,
        error: new Error(validation.errorMessage),
        failureType: 'schema_validation_error',
        retryCount: 0,
        originalPayload: rawPayload,
        originalEventId: eventId,
        transactionId,
        customerId,
      });

      if (consumer) {
        await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
      }
      return {
        success: false,
        routedToDlq: true,
        failureType: 'schema_validation_error',
        error: validation.errorMessage,
        validationErrors: validation.errors,
        dlqEventId: dlqResult.eventId,
      };
    }

    const event = validation.data;

    // 3. Event-Level Idempotency Check (primarily on eventId)
    const idempotencyKey = `idempotency:recovery_processed:${event.eventId}`;
    const isFirstProcessing = await checkIdempotency(idempotencyKey, 86400);
    if (!isFirstProcessing) {
      consumerLogger.warn('Duplicate event detected, skipping redundant recovery execution', {
        eventId: event.eventId,
        transactionId: event.transactionId,
      });
      if (consumer) {
        await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
      }
      return {
        success: true,
        skipped: true,
        reason: 'duplicate_event_id',
        eventId: event.eventId,
        transactionId: event.transactionId,
      };
    }

    // 4. Bounded Recheck for Authoritative State in PostgreSQL
    const entityRecheckRetries = retryConfig.entityRecheckRetries !== undefined ? retryConfig.entityRecheckRetries : (config.retry?.entityRecheckRetries || 3);
    const entityRecheckDelayMs = retryConfig.entityRecheckDelayMs !== undefined ? retryConfig.entityRecheckDelayMs : (config.retry?.entityRecheckDelayMs || 100);

    let txData = null;
    try {
      txData = await executeWithRetry(
        async (attempt) => {
          const data = await getTransactionById(event.transactionId);
          if (!data) {
            const notFoundErr = new Error(`Transaction ${event.transactionId} not found in PostgreSQL`);
            notFoundErr.code = 'TRANSACTION_NOT_FOUND';
            notFoundErr.isEntityMissing = true;
            throw notFoundErr;
          }
          return data;
        },
        {
          maxRetries: entityRecheckRetries,
          initialDelayMs: entityRecheckDelayMs,
          backoffMultiplier: 1.5,
          jitter: false,
          shouldRetry: (err) => err.isEntityMissing === true || isTransientError(err),
        }
      );
    } catch (err) {
      if (err.isEntityMissing) {
        consumerLogger.error(`Transaction ${event.transactionId} not found after ${entityRecheckRetries} bounded checks. Routing to DLQ.`, {
          error: err.message,
          retryCount: entityRecheckRetries,
        });
        const dlqResult = await routeToDlq({
          topic,
          partition,
          offset: message.offset,
          error: err,
          failureType: 'database_error',
          retryCount: err.retryCount || entityRecheckRetries,
          originalPayload: event,
          originalEventId: event.eventId,
          transactionId: event.transactionId,
          customerId: event.customerId,
        });

        if (consumer) {
          await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
        }

        return {
          success: false,
          routedToDlq: true,
          failureType: 'database_error',
          error: `Transaction ${event.transactionId} not found after bounded rechecks`,
          dlqEventId: dlqResult.eventId,
        };
      }
      throw err;
    }

    const { transaction, customer } = txData;

    // 5. Execute Recovery Pipeline via RecoveryOrchestrator with Transient Error Retries
    const pipelineResult = await executeWithRetry(
      async (attempt) => {
        const customerStats = await getCustomerStats(customer.id);

        const orchestration = await RecoveryOrchestrator.orchestrateRecovery({
          transaction,
          customer,
          customerStats,
          originalEventId: event.eventId,
        });

        // Publish Outcome Event to recovery-outcomes topic
        await publishOutcomeEvent(orchestration.outcomePayload);

        return orchestration;
      },
      {
        maxRetries: retryConfig.maxRetries !== undefined ? retryConfig.maxRetries : (config.retry?.maxRetries || 3),
        initialDelayMs: retryConfig.initialDelayMs !== undefined ? retryConfig.initialDelayMs : (config.retry?.initialDelayMs || 100),
        maxDelayMs: retryConfig.maxDelayMs !== undefined ? retryConfig.maxDelayMs : (config.retry?.maxDelayMs || 2000),
        backoffMultiplier: retryConfig.backoffMultiplier !== undefined ? retryConfig.backoffMultiplier : (config.retry?.backoffMultiplier || 2),
        jitter: retryConfig.jitter !== false,
      }
    );

    // 6. Commit Kafka Offset (Safe manual commit after complete processing)
    if (consumer) {
      await consumer.commitOffsets([
        { topic, partition, offset: (Number(message.offset) + 1).toString() },
      ]);
    }

    // 7. Structured Observability Log
    const durationMs = Date.now() - startTime;
    updateCorrelationContext({ caseId: pipelineResult.decision.id });

    metrics.recordKafkaProcessed(topic, 'success', durationMs / 1000);

    consumerLogger.info('RECOVERY_PROCESSED', {
      event: 'RECOVERY_PROCESSED',
      eventId: event.eventId,
      transactionId: transaction.id,
      customerId: customer.id,
      caseId: pipelineResult.decision.id,
      topic,
      partition,
      offset: message.offset,
      guardrailDecision: pipelineResult.policyResult.decision,
      decision: pipelineResult.policyResult.decision,
      outcome: pipelineResult.outcomeStatus,
      outcomeEventId: pipelineResult.outcomePayload.eventId,
      durationMs,
    });

    return {
      success: true,
      eventId: event.eventId,
      transactionId: transaction.id,
      decisionId: pipelineResult.decision.id,
      guardrailDecision: pipelineResult.policyResult.decision,
      outcome: pipelineResult.outcomeStatus,
      outcomeEventId: pipelineResult.outcomePayload.eventId,
      decision: pipelineResult.decision,
      executionResult: pipelineResult.executionResult,
      durationMs,
    };
  } catch (error) {
    // 8. Unhandled or exhausted error -> Route to DLQ & Commit Offset
    const failureType = classifyError(error);
    const retryCount = error.retryCount || 0;

    metrics.recordKafkaProcessed(topic, 'failed', (Date.now() - startTime) / 1000);
    metrics.recordDlqRouted(topic, failureType);

    consumerLogger.error(`Routing event to DLQ due to ${failureType}`, {
      error: error.message,
      failureType,
      retryCount,
      topic,
      partition,
      offset: message.offset,
    });

    const dlqResult = await routeToDlq({
      topic,
      partition,
      offset: message.offset,
      error,
      failureType,
      retryCount,
      originalPayload: rawPayload || (message.value ? (Buffer.isBuffer(message.value) ? message.value.toString('utf-8') : String(message.value)) : null),
      originalEventId: eventId,
      transactionId,
      customerId,
    });

    if (consumer) {
      await consumer.commitOffsets([
        { topic, partition, offset: (Number(message.offset) + 1).toString() },
      ]);
    }

      return {
        success: false,
        routedToDlq: true,
        failureType,
        error: error.message,
        dlqEventId: dlqResult.eventId,
        retryCount,
      };
    }
    });
  });
}

/**
 * Start the Recovery Worker Consumer (recovery-worker-group)
 */
export async function startRecoveryConsumer(options = {}) {
  if (isRunning && !options.groupId) {
    console.log('[Recovery Consumer] Worker is already running.');
    return recoveryConsumerInstance;
  }

  const groupId = options.groupId || config.kafka.recoveryWorkerGroup;
  const fromBeginning = options.fromBeginning !== undefined ? options.fromBeginning : true;

  const consumer = createConsumer({ groupId });

  await consumer.connect();
  await consumer.subscribe({
    topic: config.kafka.paymentEventsTopic,
    fromBeginning,
  });

  console.log(`[Recovery Consumer] ${groupId} subscribed to topic: ${config.kafka.paymentEventsTopic}`);

  if (!options.groupId) {
    recoveryConsumerInstance = consumer;
    isRunning = true;
  }

  consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      try {
        await processPaymentMessage({
          topic,
          partition,
          message,
          consumer,
          retryConfig: options.retryConfig || {},
        });
      } catch (err) {
        console.error(`[Recovery Consumer Fatal] Message at ${topic}[${partition}] offset ${message.offset} failed unexpectedly:`, err);
      }
    },
  });

  return consumer;
}

/**
 * Stop the Recovery Worker Consumer cleanly
 */
export async function stopRecoveryConsumer() {
  if (recoveryConsumerInstance) {
    try {
      await recoveryConsumerInstance.stop();
      await recoveryConsumerInstance.disconnect();
      recoveryConsumerInstance = null;
      isRunning = false;
      console.log('[Recovery Consumer] Worker disconnected cleanly.');
    } catch (err) {
      console.error('[Recovery Consumer] Error during disconnect:', err.message);
    }
  }
}
