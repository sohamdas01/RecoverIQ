import crypto from 'crypto';
import { config } from '../services/config/index.js';
import { publishDeadLetterEvent } from './producer.js';
import { DLQ_FAILURE_TYPES } from './schemas/events.schema.js';
import { redis } from '../redis/redis.client.js';

// Transient error codes and status codes
const TRANSIENT_SYSTEM_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  // PostgreSQL transient / deadlock / connection codes
  '40P01', // deadlock_detected
  '57P01', // admin_shutdown
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
]);

const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504, 429]);

const TRANSIENT_MESSAGE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /connection refused/i,
  /connection reset/i,
  /deadlock detected/i,
  /lock timeout/i,
  /service unavailable/i,
  /gateway timeout/i,
  /too many connections/i,
  /fetch failed/i,
  /network error/i,
  /rate limit/i,
  /pool is full/i,
  /client has encountered a connection error/i,
];

/**
 * Determine if an error is transient and eligible for retries
 */
export function isTransientError(error) {
  if (!error) return false;

  // 1. Explicit flag or status check
  if (error.isTransient === true) return true;
  if (error.isTransient === false || error.isPermanent === true) return false;

  // 2. HTTP Status code check
  const statusCode = error.statusCode || error.status || error.response?.status;
  if (statusCode && TRANSIENT_HTTP_STATUSES.has(Number(statusCode))) {
    return true;
  }

  // 3. System / Node / DB Error code check
  if (error.code && TRANSIENT_SYSTEM_CODES.has(String(error.code))) {
    return true;
  }

  // 4. Message pattern matching
  const message = error.message || String(error);
  for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return true;
    }
  }

  return false;
}

/**
 * Classify error into a valid DLQ_FAILURE_TYPE
 */
export function classifyError(error) {
  if (!error) return 'unhandled_error';

  // If already classified explicitly
  if (error.failureType && DLQ_FAILURE_TYPES.includes(error.failureType)) {
    return error.failureType;
  }

  const message = error.message || String(error);

  // 1. Poison / Deserialization error
  if (
    error.name === 'SyntaxError' ||
    message.includes('JSON') ||
    message.includes('Deserialization') ||
    message.includes('Unexpected token') ||
    message.includes('Malformed')
  ) {
    return 'poison_message';
  }

  // 2. Schema validation error
  if (
    error.name === 'ZodError' ||
    error.validationErrors ||
    message.includes('validation failed') ||
    message.includes('Event contract validation rejected') ||
    message.includes('Required') ||
    message.includes('Invalid enum')
  ) {
    return 'schema_validation_error';
  }

  // 3. Database error or missing entity
  if (
    error.code?.startsWith?.('42') ||
    error.code?.startsWith?.('23') ||
    error.isEntityMissing ||
    error.code === 'TRANSACTION_NOT_FOUND' ||
    error.code === 'DECISION_NOT_FOUND' ||
    message.includes('not found in PostgreSQL') ||
    message.includes('database error') ||
    message.includes('QueryFailedError') ||
    message.includes('drizzle')
  ) {
    return 'database_error';
  }

  // 4. Transient error that exhausted retries
  if (error.isExhausted || isTransientError(error)) {
    return 'transient_exhausted';
  }

  return 'unhandled_error';
}

/**
 * Calculate exponential backoff with optional jitter
 */
export function calculateBackoff(attempt, options = {}) {
  const initialDelayMs = options.initialDelayMs || config.retry?.initialDelayMs || 100;
  const maxDelayMs = options.maxDelayMs || config.retry?.maxDelayMs || 2000;
  const backoffMultiplier = options.backoffMultiplier || config.retry?.backoffMultiplier || 2;
  const useJitter = options.jitter !== false;

  const baseDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  const cappedDelay = Math.min(baseDelay, maxDelayMs);

  if (!useJitter) {
    return Math.floor(cappedDelay);
  }

  // Full jitter: between 0.5 * delay and 1.5 * delay
  const jitterFactor = 0.5 + Math.random();
  return Math.floor(cappedDelay * jitterFactor);
}

/**
 * Execute an operation with bounded retries and exponential backoff
 */
export async function executeWithRetry(operationFn, options = {}) {
  const maxRetries = options.maxRetries !== undefined ? options.maxRetries : (config.retry?.maxRetries || 3);
  const shouldRetryFn = options.shouldRetry || isTransientError;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operationFn(attempt);
    } catch (error) {
      lastError = error;
      lastError.retryCount = attempt;

      const canRetry = attempt < maxRetries && shouldRetryFn(error, attempt);
      if (!canRetry) {
        if (attempt >= maxRetries && shouldRetryFn(error, attempt)) {
          lastError.isExhausted = true;
          lastError.failureType = 'transient_exhausted';
        }
        throw lastError;
      }

      const delayMs = calculateBackoff(attempt, options);
      console.warn(
        `[Retry Handler] Attempt ${attempt}/${maxRetries} failed: "${error.message}". Retrying in ${delayMs}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Route an unprocessable, invalid, or exhausted event to the dead-letter-events topic
 */
export async function routeToDlq({
  topic,
  partition,
  offset,
  error,
  failureType,
  retryCount = 0,
  originalPayload = null,
  originalEventId = null,
  transactionId = null,
  customerId = null,
}) {
  const eventId = crypto.randomUUID();
  const classifiedType = failureType || classifyError(error);
  const failureReason = error?.message || (typeof error === 'string' ? error : 'Unknown error');

  // Extract identifiers from originalPayload if not explicitly passed
  let resolvedEventId = originalEventId;
  let resolvedTxId = transactionId;
  let resolvedCustomerId = customerId;

  if (originalPayload && typeof originalPayload === 'object') {
    resolvedEventId = resolvedEventId || originalPayload.eventId || originalPayload.originalEventId;
    resolvedTxId = resolvedTxId || originalPayload.transactionId;
    resolvedCustomerId = resolvedCustomerId || originalPayload.customerId;
  }

  const dlqPayload = {
    eventId,
    eventType: 'dead_letter.recorded',
    occurredAt: new Date().toISOString(),
    originalTopic: topic || 'unknown',
    originalEventId: resolvedEventId || undefined,
    transactionId: resolvedTxId || undefined,
    customerId: resolvedCustomerId || undefined,
    partition: partition !== undefined ? Number(partition) : undefined,
    offset: offset !== undefined ? String(offset) : undefined,
    failureReason,
    failureType: classifiedType,
    retryCount: Number(retryCount) || 0,
    originalPayload: originalPayload || null,
    version: 1,
  };

  try {
    const publishResult = await publishDeadLetterEvent(dlqPayload);

    // Index in Redis for fast O(1) DLQ lookup & replay
    try {
      if (redis && redis.status === 'ready') {
        await redis.set(`dlq:event:${eventId}`, JSON.stringify(dlqPayload), 'EX', 7 * 86400);
      }
    } catch (cacheErr) {
      console.warn(`[DLQ Service] Failed to cache DLQ record in Redis:`, cacheErr.message);
    }

    console.warn(
      JSON.stringify({
        level: 'WARN',
        event: 'DLQ_ROUTED',
        dlqEventId: eventId,
        originalTopic: topic,
        partition,
        offset,
        originalEventId: resolvedEventId,
        transactionId: resolvedTxId,
        failureType: classifiedType,
        failureReason,
        retryCount,
      })
    );

    return {
      success: true,
      eventId,
      dlqPayload,
      publishResult,
    };
  } catch (publishErr) {
    console.error(
      `[DLQ Critical Error] Failed to publish event to DLQ topic:`,
      publishErr.message,
      dlqPayload
    );
    throw publishErr;
  }
}
