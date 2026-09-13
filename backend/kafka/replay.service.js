import crypto from 'crypto';
import { config } from '../services/config/index.js';
import { redis } from '../redis/redis.client.js';
import { db } from '../db/index.js';
import { transactions, messages } from '../../drizzle/schema.js';
import { eq } from 'drizzle-orm';
import {
  validatePaymentEvent,
  validateOutcomeEvent,
  deserializeEvent,
} from './schemas/events.schema.js';
import { publishPaymentEvent, publishOutcomeEvent } from './producer.js';
import { createConsumer } from './kafka.client.js';
import { logger } from '../services/logger/index.js';
import { metrics } from '../services/metrics/index.js';
import { withSpan } from '../services/observability/index.js';

const replayLogger = logger.withComponent('replay_service');

// In-memory fallback cache for test environments without Redis
const memoryDlqStore = new Map();
const memoryReplayHistory = new Map();

/**
 * Store/index DLQ event in memory fallback cache
 */
export function indexDlqEventInMemory(dlqEvent) {
  if (dlqEvent && dlqEvent.eventId) {
    memoryDlqStore.set(dlqEvent.eventId, dlqEvent);
  }
}

/**
 * Find DLQ event by ID from Redis, in-memory cache, or Kafka topic scan
 */
export async function findDlqEvent(dlqEventId) {
  if (!dlqEventId) return null;

  // 1. Try Redis cache
  try {
    if (redis && redis.status === 'ready') {
      const cached = await redis.get(`dlq:event:${dlqEventId}`);
      if (cached) {
        return JSON.parse(cached);
      }
    }
  } catch (err) {
    console.warn(`[Replay Service] Redis lookup warning: ${err.message}`);
  }

  // 2. Try In-memory store
  if (memoryDlqStore.has(dlqEventId)) {
    return memoryDlqStore.get(dlqEventId);
  }

  // 3. Fallback: Scan dead-letter-events Kafka topic
  try {
    const scanConsumer = createConsumer({
      groupId: `dlq-finder-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    });

    await scanConsumer.connect();
    await scanConsumer.subscribe({
      topic: config.kafka.deadLetterTopic,
      fromBeginning: true,
    });

    let foundEvent = null;
    let scanTimeout = null;

    await new Promise((resolve) => {
      scanTimeout = setTimeout(async () => {
        resolve();
      }, 1500);

      scanConsumer.run({
        autoCommit: false,
        eachMessage: async ({ message }) => {
          const deserialized = deserializeEvent(message.value);
          if (deserialized.success && deserialized.data?.eventId === dlqEventId) {
            foundEvent = deserialized.data;
            clearTimeout(scanTimeout);
            resolve();
          }
        },
      });
    });

    try {
      await scanConsumer.stop();
      await scanConsumer.disconnect();
    } catch (_) {}

    if (foundEvent) {
      // Cache for future lookups
      try {
        if (redis && redis.status === 'ready') {
          await redis.set(`dlq:event:${dlqEventId}`, JSON.stringify(foundEvent), 'EX', 7 * 86400);
        }
      } catch (_) {}
      memoryDlqStore.set(dlqEventId, foundEvent);
      return foundEvent;
    }
  } catch (kafkaErr) {
    console.warn(`[Replay Service] Kafka DLQ scan error: ${kafkaErr.message}`);
  }

  return null;
}

/**
 * Safely inspect and replay a DLQ event back into the normal Kafka processing pipeline
 */
export async function replayDlqEvent(dlqEventId, options = {}) {
  const replayedBy = options.replayedBy || 'admin';
  const dryRun = options.dryRun === true;

  return withSpan('dlq.replay', {
    attributes: {
      'dlq.event_id': dlqEventId,
      'replay.by': replayedBy,
      'replay.dry_run': dryRun,
    },
  }, async (replaySpan) => {
    // 1. Verify DLQ record exists
    const dlqRecord = await findDlqEvent(dlqEventId);
    if (!dlqRecord) {
      const notFoundError = new Error(`DLQ event not found: ${dlqEventId}`);
      notFoundError.statusCode = 404;
      throw notFoundError;
    }

  // 2. Prevent duplicate replay (Idempotency)
  let alreadyReplayed = false;
  let previousReplayMeta = null;

  try {
    if (redis && redis.status === 'ready') {
      const history = await redis.get(`replay:completed:${dlqEventId}`);
      if (history) {
        alreadyReplayed = true;
        previousReplayMeta = JSON.parse(history);
      }
    }
  } catch (_) {}

  if (!alreadyReplayed && memoryReplayHistory.has(dlqEventId)) {
    alreadyReplayed = true;
    previousReplayMeta = memoryReplayHistory.get(dlqEventId);
  }

  if (alreadyReplayed && !options.force) {
    const conflictError = new Error(
      `DLQ event ${dlqEventId} has already been replayed on ${previousReplayMeta?.replayedAt || 'previously'} (Replay ID: ${previousReplayMeta?.replayEventId || 'unknown'})`
    );
    conflictError.statusCode = 409;
    conflictError.previousReplay = previousReplayMeta;
    throw conflictError;
  }

  // 3. Verify original topic is supported
  const originalTopic = dlqRecord.originalTopic;
  const isPaymentTopic = originalTopic === config.kafka.paymentEventsTopic;
  const isOutcomeTopic = originalTopic === config.kafka.recoveryOutcomesTopic;

  if (!isPaymentTopic && !isOutcomeTopic) {
    const topicError = new Error(
      `Unsupported replay target topic "${originalTopic}". Only "${config.kafka.paymentEventsTopic}" and "${config.kafka.recoveryOutcomesTopic}" are allowed.`
    );
    topicError.statusCode = 400;
    throw topicError;
  }

  // 4. Extract and validate original payload
  let parsedPayload = dlqRecord.originalPayload;
  if (typeof parsedPayload === 'string') {
    try {
      parsedPayload = JSON.parse(parsedPayload);
    } catch (e) {
      const parseError = new Error(`Original payload is invalid JSON and cannot be replayed: ${e.message}`);
      parseError.statusCode = 400;
      throw parseError;
    }
  }

  if (!parsedPayload || typeof parsedPayload !== 'object') {
    const invalidError = new Error('Original payload is empty or not an object; cannot be replayed');
    invalidError.statusCode = 400;
    throw invalidError;
  }

  // 5. Construct new replay event preserving original eventId reference
  const newReplayEventId = crypto.randomUUID();
  const originalEventId = dlqRecord.originalEventId || parsedPayload.eventId || dlqRecord.eventId;
  const replayedAt = new Date().toISOString();

  const replayedPayload = {
    ...parsedPayload,
    eventId: newReplayEventId,
    occurredAt: replayedAt,
    // Preserve audit trace
    originalEventId,
    isReplay: true,
    replayedFromDlqId: dlqEventId,
    replayedBy,
    replayedAt,
  };

  // 6. Validate reconstructed event against target schema contract
  if (isPaymentTopic) {
    const validation = validatePaymentEvent(replayedPayload);
    if (!validation.success) {
      const contractErr = new Error(`Replay event schema validation failed: ${validation.errorMessage}`);
      contractErr.statusCode = 400;
      contractErr.validationErrors = validation.errors;
      throw contractErr;
    }
  } else if (isOutcomeTopic) {
    const validation = validateOutcomeEvent(replayedPayload);
    if (!validation.success) {
      const contractErr = new Error(`Replay outcome schema validation failed: ${validation.errorMessage}`);
      contractErr.statusCode = 400;
      contractErr.validationErrors = validation.errors;
      throw contractErr;
    }
  }

  // If dryRun, return inspection preview without publishing
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      dlqEventId,
      originalEventId,
      targetTopic: originalTopic,
      replayedPayload,
      message: 'Replay payload validated successfully (dry run, not published)',
    };
  }

  // 7. Publish Replayed Event to its target Kafka Topic
  let publishResult = null;
  if (isPaymentTopic) {
    publishResult = await publishPaymentEvent(replayedPayload);
  } else if (isOutcomeTopic) {
    publishResult = await publishOutcomeEvent(replayedPayload);
  }

  // 8. Record Replay History for Duplicate Prevention & Audit
  const replayRecord = {
    dlqEventId,
    originalEventId,
    replayEventId: newReplayEventId,
    targetTopic: originalTopic,
    transactionId: replayedPayload.transactionId,
    replayedAt,
    replayedBy,
    status: 'success',
  };

  try {
    if (redis && redis.status === 'ready') {
      await redis.set(`replay:completed:${dlqEventId}`, JSON.stringify(replayRecord), 'EX', 30 * 86400);
    }
  } catch (_) {}
  memoryReplayHistory.set(dlqEventId, replayRecord);

  // 9. Append Immutable Audit Record in PostgreSQL messages Table (if transaction exists)
  if (replayedPayload.transactionId) {
    try {
      const [tx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, replayedPayload.transactionId))
        .limit(1);

      if (tx) {
        await db.insert(messages).values({
          transactionId: tx.id,
          eventTaken: 'event_replayed',
          channel: 'admin_replay',
          details: {
            dlqEventId,
            originalEventId,
            replayEventId: newReplayEventId,
            targetTopic: originalTopic,
            replayedAt,
            replayedBy,
            status: 'replayed',
            publishResult,
          },
        });
      }
    } catch (auditErr) {
      console.warn('[Replay Service] PostgreSQL audit entry warning:', auditErr.message);
    }
  }

  // 10. Structured Observability Log
  metrics.recordDlqReplay(originalTopic, 'success');
  replayLogger.info('DLQ_EVENT_REPLAYED', {
    event: 'DLQ_EVENT_REPLAYED',
    dlqEventId,
    originalEventId,
    replayEventId: newReplayEventId,
    targetTopic: originalTopic,
    transactionId: replayedPayload.transactionId,
    replayedBy,
    replayedAt,
  });

  replaySpan.setAttribute('original.event_id', originalEventId);
  replaySpan.setAttribute('replay.event_id', newReplayEventId);
  replaySpan.setAttribute('target.topic', originalTopic);

  return {
    success: true,
    dlqEventId,
    originalEventId,
    replayEventId: newReplayEventId,
    targetTopic: originalTopic,
    transactionId: replayedPayload.transactionId,
    replayedAt,
    replayedBy,
    status: 'replayed',
    publishResult,
  };
  });
}
