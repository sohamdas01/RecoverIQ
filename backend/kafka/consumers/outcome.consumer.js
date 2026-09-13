import { createConsumer } from '../kafka.client.js';
import { config } from '../../services/config/index.js';
import {
  EVENT_TYPES,
  OUTCOME_TYPES,
  deserializeEvent,
  validateOutcomeEvent,
} from '../schemas/events.schema.js';
import { db } from '../../db/index.js';
import { transactions, decisions, actions, messages } from '../../../drizzle/schema.js';
import { eq } from 'drizzle-orm';
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

const consumerLogger = logger.withComponent('outcome_consumer');

let outcomeConsumerInstance = null;
let isRunning = false;

function getHeaderStr(headers, key) {
  if (!headers || headers[key] === undefined || headers[key] === null) return undefined;
  const val = headers[key];
  return Buffer.isBuffer(val) ? val.toString('utf-8') : String(val);
}

/**
 * Process and atomically reconcile a recovery outcome event with PostgreSQL
 */
export async function processOutcomeMessage({ topic, partition, message, consumer, retryConfig = {} }) {
  const startTime = Date.now();
  let rawPayload = null;
  const headerRequestId = sanitizeCorrelationId(getHeaderStr(message.headers, 'requestId') || getHeaderStr(message.headers, 'x-request-id'));
  const headerCorrelationId = sanitizeCorrelationId(getHeaderStr(message.headers, 'correlationId') || getHeaderStr(message.headers, 'x-correlation-id')) || headerRequestId;
  const headerOriginalEventId = getHeaderStr(message.headers, 'originalEventId');
  const headerReplayEventId = getHeaderStr(message.headers, 'replayEventId');
  let eventId = getHeaderStr(message.headers, 'eventId');
  let transactionId = getHeaderStr(message.headers, 'transactionId');
  let caseId = getHeaderStr(message.headers, 'caseId');

  const initialContext = {
    requestId: headerRequestId,
    correlationId: headerCorrelationId,
    originalEventId: headerOriginalEventId,
    replayEventId: headerReplayEventId,
    eventId,
    transactionId,
    caseId,
  };

  metrics.recordKafkaConsumed(topic, 'outcome-worker-group');

  // Extract W3C trace context from Kafka headers
  const parentTraceContext = extractTraceContext(message.headers, kafkaHeaderGetter);

  return withSpan(`kafka.consume ${topic}`, {
    kind: SpanKind.CONSUMER,
    parentContext: parentTraceContext,
    attributes: {
      'messaging.system': 'kafka',
      'messaging.source': topic,
      'messaging.kafka.partition': partition,
      'messaging.kafka.consumer_group': 'outcome-worker-group',
      'component': 'outcome_consumer',
    },
  }, async (consumerSpan) => {
    return runWithCorrelationContext(initialContext, async () => {

    try {
      // 1. Deserialize message (Poison check)
      const deserialized = deserializeEvent(message.value);
      if (!deserialized.success) {
        metrics.recordKafkaProcessed(topic, 'failed', (Date.now() - startTime) / 1000);
        metrics.recordDlqRouted(topic, 'poison_message');
        consumerLogger.error('Deserialization error on outcome event', {
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
      });

      if (consumer) {
        await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
      }
      return { success: false, routedToDlq: true, failureType: 'poison_message', error: deserialized.error, dlqEventId: dlqResult.eventId };
    }

    rawPayload = deserialized.data;
    eventId = rawPayload?.eventId || eventId;
    transactionId = rawPayload?.transactionId || transactionId;
    caseId = rawPayload?.caseId || caseId;

    updateCorrelationContext({
      eventId,
      transactionId,
      caseId,
      customerId: rawPayload?.customerId,
      originalEventId: rawPayload?.originalEventId || headerOriginalEventId,
      replayEventId: rawPayload?.replayEventId || headerReplayEventId,
    });

    // 2. Validate against Zod OutcomeEventSchema contract
    const validation = validateOutcomeEvent(rawPayload);
    if (!validation.success) {
      metrics.recordKafkaProcessed(topic, 'failed', (Date.now() - startTime) / 1000);
      metrics.recordDlqRouted(topic, 'schema_validation_error');
      consumerLogger.error('Outcome event contract validation rejected', {
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
        customerId: rawPayload?.customerId,
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

    // 3. eventId-Level Idempotency Check (prevent duplicate outcome processing)
    const idempotencyKey = `idempotency:outcome_processed:${event.eventId}`;
    const isFirstProcessing = await checkIdempotency(idempotencyKey, 86400);
    if (!isFirstProcessing) {
      consumerLogger.warn('Duplicate outcome detected, skipping redundant DB reconciliation', {
        eventId: event.eventId,
        caseId: event.caseId,
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
        caseId: event.caseId,
        transactionId: event.transactionId,
      };
    }

    // 4. Bounded Recheck for Authoritative State in PostgreSQL (Correction 1: Account for potential race condition)
    const entityRecheckRetries = retryConfig.entityRecheckRetries !== undefined ? retryConfig.entityRecheckRetries : (config.retry?.entityRecheckRetries || 3);
    const entityRecheckDelayMs = retryConfig.entityRecheckDelayMs !== undefined ? retryConfig.entityRecheckDelayMs : (config.retry?.entityRecheckDelayMs || 100);

    let currentTx = null;
    let currentDecision = null;
    let currentAction = null;

    try {
      const state = await executeWithRetry(
        async (attempt) => {
          const [tx] = await db.select().from(transactions).where(eq(transactions.id, event.transactionId)).limit(1);
          if (!tx) {
            const err = new Error(`Transaction ${event.transactionId} not found in PostgreSQL`);
            err.code = 'TRANSACTION_NOT_FOUND';
            err.isEntityMissing = true;
            throw err;
          }

          const [dec] = await db.select().from(decisions).where(eq(decisions.id, event.caseId)).limit(1);
          if (!dec) {
            const err = new Error(`Decision/Case ${event.caseId} not found in PostgreSQL`);
            err.code = 'DECISION_NOT_FOUND';
            err.isEntityMissing = true;
            throw err;
          }

          const existingActions = await db.select().from(actions).where(eq(actions.decisionId, event.caseId)).limit(1);
          return { tx, dec, act: existingActions[0] || null };
        },
        {
          maxRetries: entityRecheckRetries,
          initialDelayMs: entityRecheckDelayMs,
          backoffMultiplier: 1.5,
          jitter: false,
          shouldRetry: (err) => err.isEntityMissing === true || isTransientError(err),
        }
      );

      currentTx = state.tx;
      currentDecision = state.dec;
      currentAction = state.act;
    } catch (err) {
      if (err.isEntityMissing) {
        metrics.recordKafkaProcessed(topic, 'failed', (Date.now() - startTime) / 1000);
        metrics.recordDlqRouted(topic, 'database_error');
        consumerLogger.error(`Entity not found after ${entityRecheckRetries} bounded checks`, {
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
          error: err.message,
          dlqEventId: dlqResult.eventId,
        };
      }
      throw err;
    }

    // Record previous states for structured audit logging
    const previousState = {
      transactionStatus: currentTx.status,
      decisionStatus: currentDecision.status,
      actionStatus: currentAction?.status || 'none',
    };

    // 5. Determine New Reconciled States
    let newTransactionStatus = currentTx.status;
    let newDecisionStatus = currentDecision.status;
    let actionStatus = 'success';
    let eventTaken = 'resolved';

    const isRecovered = event.outcome === OUTCOME_TYPES.RECOVERED || event.eventType === EVENT_TYPES.RECOVERY_COMPLETED;
    const isEscalated = event.outcome === OUTCOME_TYPES.ESCALATED || event.eventType === EVENT_TYPES.RECOVERY_ESCALATED;
    const isPendingReview = event.outcome === OUTCOME_TYPES.PENDING_REVIEW;
    const isBlocked = event.outcome === OUTCOME_TYPES.BLOCKED;
    const isScheduled = event.outcome === OUTCOME_TYPES.SCHEDULED || event.eventType === EVENT_TYPES.RECOVERY_SCHEDULED;
    const isFailed = event.outcome === OUTCOME_TYPES.FAILED || event.eventType === EVENT_TYPES.RECOVERY_FAILED;

    if (isRecovered) {
      newTransactionStatus = 'recovered';
      newDecisionStatus = 'executed';
      actionStatus = 'success';
      eventTaken = 'resolved';
    } else if (isEscalated) {
      newTransactionStatus = 'escalated';
      newDecisionStatus = 'executed';
      actionStatus = 'success';
      eventTaken = 'escalated';
    } else if (isPendingReview) {
      newTransactionStatus = currentTx.status;
      newDecisionStatus = 'pending_review';
      actionStatus = 'skipped';
      eventTaken = 'review_queued';
    } else if (isBlocked) {
      newTransactionStatus = 'failed';
      newDecisionStatus = 'blocked';
      actionStatus = 'skipped';
      eventTaken = 'blocked';
    } else if (isScheduled) {
      newTransactionStatus = currentTx.status;
      newDecisionStatus = 'executed';
      actionStatus = 'success';
      eventTaken = 'retry_scheduled';
    } else if (isFailed) {
      newTransactionStatus = 'failed';
      newDecisionStatus = 'executed';
      actionStatus = 'failed';
      eventTaken = 'recovery_attempt_failed';
    }

    const newState = {
      transactionStatus: newTransactionStatus,
      decisionStatus: newDecisionStatus,
      actionStatus,
    };

    // 6. Atomic Database Transaction with Transient Retry Wrapper & Tracing
    await withSpan('reconciliation.db', {
      attributes: {
        'component': 'db_reconciliation',
        'db.system': 'postgresql',
      },
    }, async () => {
      await executeWithRetry(
        async (attempt) => {
          await db.transaction(async (tx) => {
            // 6a. Update Transaction Record
            await tx
              .update(transactions)
              .set({
                status: newTransactionStatus,
                metadata: {
                  ...(currentTx.metadata || {}),
                  ...(event.details || {}),
                  recoveredAmount: isRecovered ? (event.recoveredAmount || parseFloat(currentTx.amount)) : (currentTx.metadata?.recoveredAmount || 0),
                  lastOutcomeEventId: event.eventId,
                  lastOutcomeType: event.eventType,
                  lastReconciledAt: new Date().toISOString(),
                },
                updatedAt: new Date(),
              })
              .where(eq(transactions.id, event.transactionId));


          // 6b. Update Decision Record
          await tx
            .update(decisions)
            .set({
              status: newDecisionStatus,
              finalAction: event.toolName || currentDecision.finalAction || currentDecision.recommendedAction,
            })
            .where(eq(decisions.id, event.caseId));

          // 6c. Reconcile / Insert Action Record
          if (currentAction) {
            await tx
              .update(actions)
              .set({
                status: actionStatus,
                result: {
                  ...(currentAction.result || {}),
                  ...(event.details?.toolOutput || {}),
                  outcome: event.outcome,
                  outcomeEventId: event.eventId,
                  reconciledAt: new Date().toISOString(),
                },
              })
              .where(eq(actions.id, currentAction.id));
          } else if (event.toolName) {
            await tx
              .insert(actions)
              .values({
                decisionId: event.caseId,
                toolName: event.toolName,
                toolParams: event.details?.toolParams || {},
                status: actionStatus,
                result: {
                  ...(event.details?.toolOutput || {}),
                  outcome: event.outcome,
                  outcomeEventId: event.eventId,
                  reconciledAt: new Date().toISOString(),
                },
              });
          }

          // 6d. Append Immutable Audit Log in Messages Table
          await tx
            .insert(messages)
            .values({
              transactionId: event.transactionId,
              eventTaken,
              channel: event.toolName === 'send_recovery_message' ? 'email' : 'system_reconciliation',
              details: {
                outcomeEventId: event.eventId,
                eventType: event.eventType,
                outcome: event.outcome,
                toolName: event.toolName,
                recoveredAmount: event.recoveredAmount || 0,
                reconciledAt: new Date().toISOString(),
                details: event.details || {},
              },
            });
        });
      },
      {
        maxRetries: retryConfig.maxRetries !== undefined ? retryConfig.maxRetries : (config.retry?.maxRetries || 3),
        initialDelayMs: retryConfig.initialDelayMs !== undefined ? retryConfig.initialDelayMs : (config.retry?.initialDelayMs || 100),
        maxDelayMs: retryConfig.maxDelayMs !== undefined ? retryConfig.maxDelayMs : (config.retry?.maxDelayMs || 2000),
        backoffMultiplier: retryConfig.backoffMultiplier !== undefined ? retryConfig.backoffMultiplier : (config.retry?.backoffMultiplier || 2),
        jitter: retryConfig.jitter !== false,
      }
    );
    });

    // 7. Safe Manual Offset Commit (Only committed after successful atomic DB transaction)
    if (consumer) {
      await consumer.commitOffsets([
        { topic, partition, offset: (Number(message.offset) + 1).toString() },
      ]);
    }

    // 8. Structured Observability Log
    const durationMs = Date.now() - startTime;
    metrics.recordKafkaProcessed(topic, 'success', durationMs / 1000);
    consumerLogger.info('OUTCOME_RECONCILED', {
      event: 'OUTCOME_RECONCILED',
      eventId: event.eventId,
      caseId: event.caseId,
      transactionId: event.transactionId,
      topic,
      partition,
      offset: message.offset,
      previousState,
      newState,
      outcome: event.outcome,
      recoveredAmount: event.recoveredAmount || 0,
      processingResult: 'reconciled_atomic',
      durationMs,
    });

    return {
      success: true,
      eventId: event.eventId,
      caseId: event.caseId,
      transactionId: event.transactionId,
      previousState,
      newState,
      durationMs,
    };
  } catch (error) {
    // 9. Unhandled or exhausted error -> Route to DLQ & Commit Offset
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
      customerId: rawPayload?.customerId,
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
 * Start the Outcome Worker Consumer (outcome-worker-group)
 */
export async function startOutcomeConsumer(options = {}) {
  if (isRunning && !options.groupId) {
    console.log('[Outcome Consumer] Worker is already running.');
    return outcomeConsumerInstance;
  }

  const groupId = options.groupId || config.kafka.outcomeWorkerGroup;
  const fromBeginning = options.fromBeginning !== undefined ? options.fromBeginning : true;

  const consumer = createConsumer({ groupId });

  await consumer.connect();
  await consumer.subscribe({
    topic: config.kafka.recoveryOutcomesTopic,
    fromBeginning,
  });

  console.log(`[Outcome Consumer] ${groupId} subscribed to topic: ${config.kafka.recoveryOutcomesTopic}`);

  if (!options.groupId) {
    outcomeConsumerInstance = consumer;
    isRunning = true;
  }

  consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      try {
        await processOutcomeMessage({
          topic,
          partition,
          message,
          consumer,
          retryConfig: options.retryConfig || {},
        });
      } catch (err) {
        console.error(`[Outcome Consumer Fatal] Message at ${topic}[${partition}] offset ${message.offset} failed unexpectedly:`, err);
      }
    },
  });

  return consumer;
}

/**
 * Stop the Outcome Worker Consumer cleanly
 */
export async function stopOutcomeConsumer() {
  if (outcomeConsumerInstance) {
    try {
      await outcomeConsumerInstance.stop();
      await outcomeConsumerInstance.disconnect();
      outcomeConsumerInstance = null;
      isRunning = false;
      console.log('[Outcome Consumer] Worker disconnected cleanly.');
    } catch (err) {
      console.error('[Outcome Consumer] Error during disconnect:', err.message);
    }
  }
}
