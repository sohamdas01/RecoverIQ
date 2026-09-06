import { z } from 'zod';
import crypto from 'crypto';

// Supported Event Types
export const EVENT_TYPES = {
  PAYMENT_FAILED: 'payment.failed',
  SUBSCRIPTION_FAILED: 'subscription.failed',
  RECOVERY_COMPLETED: 'recovery.completed',
  RECOVERY_FAILED: 'recovery.failed',
  RECOVERY_ESCALATED: 'recovery.escalated',
  RECOVERY_SCHEDULED: 'recovery.scheduled',
  DEAD_LETTER_RECORDED: 'dead_letter.recorded',
};

// Supported Outcomes
export const OUTCOME_TYPES = {
  RECOVERED: 'recovered',
  FAILED: 'failed',
  ESCALATED: 'escalated',
  SCHEDULED: 'scheduled',
  PENDING_REVIEW: 'pending_review',
  REJECTED: 'rejected',
  BLOCKED: 'blocked',
};

// Supported Failure Reasons
export const FAILURE_REASONS = [
  'insufficient_funds',
  'card_expired',
  'bank_outage',
  'network_timeout',
  'authentication_failed',
  'high_risk_fraud',
];

// Supported Payment Methods
export const PAYMENT_METHODS = [
  'card',
  'upi',
  'netbanking',
  'subscription_mandate',
];

// DLQ Failure Types
export const DLQ_FAILURE_TYPES = [
  'poison_message',
  'schema_validation_error',
  'transient_exhausted',
  'database_error',
  'unhandled_error',
];

/**
 * 1. Payment Event Schema (payment-events topic)
 * Strictly minimal: Contains IDs and payment parameters. No customer PII (no name, email, phone).
 */
export const PaymentEventSchema = z.object({
  eventId: z.string().uuid({ message: 'eventId must be a valid UUID' }).default(() => crypto.randomUUID()),
  eventType: z.enum([EVENT_TYPES.PAYMENT_FAILED, EVENT_TYPES.SUBSCRIPTION_FAILED]),
  occurredAt: z.string().datetime({ message: 'occurredAt must be a valid ISO 8601 datetime string' }).default(() => new Date().toISOString()),
  transactionId: z.string().min(1, { message: 'transactionId is required' }),
  customerId: z.string().min(1, { message: 'customerId is required' }),
  payload: z.object({
    amount: z.number().positive({ message: 'amount must be a positive number' }),
    currency: z.string().length(3, { message: 'currency must be a 3-letter ISO code (e.g. INR)' }).default('INR'),
    paymentMethod: z.enum(PAYMENT_METHODS, { message: `paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}` }),
    failureReason: z.enum(FAILURE_REASONS, { message: `failureReason must be one of: ${FAILURE_REASONS.join(', ')}` }),
    attemptCount: z.number().int().min(1, { message: 'attemptCount must be an integer >= 1' }).default(1),
    metadata: z.record(z.any()).optional().default({}),
  }),
  version: z.number().int().min(1).default(1),
});

/**
 * 2. Recovery Outcome Event Schema (recovery-outcomes topic)
 * Published when a recovery action or merchant review completes.
 */
export const OutcomeEventSchema = z.object({
  eventId: z.string().uuid({ message: 'eventId must be a valid UUID' }).default(() => crypto.randomUUID()),
  eventType: z.enum([
    EVENT_TYPES.RECOVERY_COMPLETED,
    EVENT_TYPES.RECOVERY_FAILED,
    EVENT_TYPES.RECOVERY_ESCALATED,
    EVENT_TYPES.RECOVERY_SCHEDULED,
  ]),
  occurredAt: z.string().datetime({ message: 'occurredAt must be a valid ISO 8601 datetime string' }).default(() => new Date().toISOString()),
  transactionId: z.string().min(1, { message: 'transactionId is required' }),
  caseId: z.string().min(1, { message: 'caseId / decisionId is required' }),
  customerId: z.string().min(1).optional(),
  outcome: z.enum(Object.values(OUTCOME_TYPES)),
  toolName: z.string().optional(),
  recoveredAmount: z.number().min(0).optional(),
  currency: z.string().length(3).optional().default('INR'),
  details: z.record(z.any()).optional().default({}),
  version: z.number().int().min(1).default(1),
});

/**
 * 3. Dead Letter Event Schema (dead-letter-events topic)
 * Preserves unprocessable or exhausted retry events with diagnostic context.
 */
export const DeadLetterEventSchema = z.object({
  eventId: z.string().uuid({ message: 'eventId must be a valid UUID' }).default(() => crypto.randomUUID()),
  eventType: z.literal(EVENT_TYPES.DEAD_LETTER_RECORDED).default(EVENT_TYPES.DEAD_LETTER_RECORDED),
  occurredAt: z.string().datetime({ message: 'occurredAt must be a valid ISO 8601 datetime string' }).default(() => new Date().toISOString()),
  originalTopic: z.string().min(1, { message: 'originalTopic is required' }),
  originalEventId: z.string().optional(),
  transactionId: z.string().optional(),
  customerId: z.string().optional(),
  partition: z.number().int().min(0).optional(),
  offset: z.string().optional(),
  failureReason: z.string().min(1, { message: 'failureReason is required' }),
  failureType: z.enum(DLQ_FAILURE_TYPES),
  retryCount: z.number().int().min(0).default(0),
  originalPayload: z.any(),
  version: z.number().int().min(1).default(1),
});

/**
 * Format Zod validation errors into structured, user-friendly details
 */
export function formatZodErrors(error) {
  if (!error || !error.issues) {
    return [{ field: 'root', message: error?.message || 'Unknown validation error' }];
  }
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || 'root',
    code: issue.code,
    message: issue.message,
    received: issue.received,
  }));
}

/**
 * Validate a payment event against PaymentEventSchema
 */
export function validatePaymentEvent(data) {
  const result = PaymentEventSchema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      data: null,
      errors: formatZodErrors(result.error),
      errorMessage: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return {
    success: true,
    data: result.data,
    errors: [],
  };
}

/**
 * Validate an outcome event against OutcomeEventSchema
 */
export function validateOutcomeEvent(data) {
  const result = OutcomeEventSchema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      data: null,
      errors: formatZodErrors(result.error),
      errorMessage: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return {
    success: true,
    data: result.data,
    errors: [],
  };
}

/**
 * Validate a dead letter event against DeadLetterEventSchema
 */
export function validateDeadLetterEvent(data) {
  const result = DeadLetterEventSchema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      data: null,
      errors: formatZodErrors(result.error),
      errorMessage: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return {
    success: true,
    data: result.data,
    errors: [],
  };
}

/**
 * Serialize an event object to JSON string with schema validation
 */
export function serializeEvent(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const errorDetails = formatZodErrors(parsed.error);
    const err = new Error(`Event serialization failed: ${errorDetails.map(e => `${e.field}: ${e.message}`).join(', ')}`);
    err.validationErrors = errorDetails;
    throw err;
  }
  return JSON.stringify(parsed.data);
}

/**
 * Safely deserialize Kafka message buffer or string into an object
 */
export function deserializeEvent(rawMessage) {
  try {
    if (!rawMessage) {
      throw new Error('Message is empty or null');
    }
    const text = Buffer.isBuffer(rawMessage) ? rawMessage.toString('utf-8') : String(rawMessage);
    return {
      success: true,
      data: JSON.parse(text),
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: `JSON Deserialization Error: ${error.message}`,
    };
  }
}
