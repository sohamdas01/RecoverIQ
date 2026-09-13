import { getProducer } from './kafka.client.js';
import { config } from '../services/config/index.js';
import {
  PaymentEventSchema,
  OutcomeEventSchema,
  DeadLetterEventSchema,
  validatePaymentEvent,
  validateOutcomeEvent,
  validateDeadLetterEvent,
  serializeEvent,
} from './schemas/events.schema.js';
import { logger, getCorrelationContext } from '../services/logger/index.js';
import { metrics } from '../services/metrics/index.js';
import { withSpan, injectTraceContext } from '../services/observability/tracing.service.js';
import { SpanKind } from '@opentelemetry/api';

const producerLogger = logger.withComponent('kafka_producer');

/**
 * Publish a validated payment event to the payment-events Kafka topic
 */
export async function publishPaymentEvent(eventData) {
  const validation = validatePaymentEvent(eventData);
  if (!validation.success) {
    const error = new Error(`Payment event validation failed: ${validation.errorMessage}`);
    error.validationErrors = validation.errors;
    error.statusCode = 400;
    throw error;
  }

  const validatedEvent = validation.data;
  const serialized = serializeEvent(PaymentEventSchema, validatedEvent);
  const context = getCorrelationContext();

  const requestId = eventData.requestId || context.requestId || undefined;
  const correlationId = eventData.correlationId || context.correlationId || requestId || undefined;
  const originalEventId = eventData.originalEventId || validatedEvent.details?.originalEventId || context.originalEventId || undefined;
  const replayEventId = eventData.replayEventId || validatedEvent.details?.replayEventId || context.replayEventId || undefined;

  return withSpan(`kafka.produce ${config.kafka.paymentEventsTopic}`, {
    kind: SpanKind.PRODUCER,
    attributes: {
      'messaging.system': 'kafka',
      'messaging.destination': config.kafka.paymentEventsTopic,
      'messaging.destination.name': config.kafka.paymentEventsTopic,
      'messaging.destination_kind': 'topic',
      'messaging.operation': 'publish',
      'messaging.message.id': validatedEvent.eventId,
      'messaging.kafka.event_type': validatedEvent.eventType,
      'component': 'kafka_producer',
    },
  }, async (span) => {
    try {
      const producer = await getProducer();
      const headers = {
        eventId: validatedEvent.eventId,
        eventType: validatedEvent.eventType,
        transactionId: validatedEvent.transactionId,
        customerId: validatedEvent.customerId,
        version: String(validatedEvent.version || 1),
      };

      if (requestId) headers.requestId = String(requestId);
      if (correlationId) headers.correlationId = String(correlationId);
      if (originalEventId) headers.originalEventId = String(originalEventId);
      if (replayEventId) headers.replayEventId = String(replayEventId);

      // Inject W3C trace context into Kafka message headers
      injectTraceContext(headers);

      const recordMetadata = await producer.send({
        topic: config.kafka.paymentEventsTopic,
        messages: [
          {
            key: validatedEvent.transactionId,
            value: serialized,
            headers,
          },
        ],
      });


    const meta = recordMetadata[0] || {};
    const offset = meta.baseOffset !== undefined ? String(meta.baseOffset) : (meta.offset !== undefined ? String(meta.offset) : undefined);

    producerLogger.info('payment_event_published', {
      topic: config.kafka.paymentEventsTopic,
      partition: meta.partition,
      offset,
      eventId: validatedEvent.eventId,
      eventType: validatedEvent.eventType,
      transactionId: validatedEvent.transactionId,
      customerId: validatedEvent.customerId,
      requestId,
      correlationId,
      originalEventId,
      replayEventId,
    });

    metrics.recordKafkaPublished(config.kafka.paymentEventsTopic, validatedEvent.eventType);

    return {
      success: true,
      eventId: validatedEvent.eventId,
      eventType: validatedEvent.eventType,
      transactionId: validatedEvent.transactionId,
      customerId: validatedEvent.customerId,
      topic: config.kafka.paymentEventsTopic,
      partition: meta.partition,
      offset,
    };
  } catch (error) {
    producerLogger.error('payment_event_publish_failed', {
      eventId: validatedEvent.eventId,
      transactionId: validatedEvent.transactionId,
      error: error.message,
    });
    error.eventId = validatedEvent.eventId;
    error.transactionId = validatedEvent.transactionId;
    throw error;
  }
  });
}

/**
 * Publish a validated outcome event to the recovery-outcomes Kafka topic
 */
export async function publishOutcomeEvent(outcomeData) {
  const validation = validateOutcomeEvent(outcomeData);
  if (!validation.success) {
    const error = new Error(`Outcome event validation failed: ${validation.errorMessage}`);
    error.validationErrors = validation.errors;
    error.statusCode = 400;
    throw error;
  }

  const validatedOutcome = validation.data;
  const serialized = serializeEvent(OutcomeEventSchema, validatedOutcome);
  const context = getCorrelationContext();

  const requestId = outcomeData.requestId || context.requestId || undefined;
  const correlationId = outcomeData.correlationId || context.correlationId || requestId || undefined;
  const originalEventId = outcomeData.originalEventId || validatedOutcome.details?.originalEventId || context.originalEventId || undefined;
  const replayEventId = outcomeData.replayEventId || validatedOutcome.details?.replayEventId || context.replayEventId || undefined;

  return withSpan(`kafka.produce ${config.kafka.recoveryOutcomesTopic}`, {
    kind: SpanKind.PRODUCER,
    attributes: {
      'messaging.system': 'kafka',
      'messaging.destination': config.kafka.recoveryOutcomesTopic,
      'messaging.destination.name': config.kafka.recoveryOutcomesTopic,
      'messaging.destination_kind': 'topic',
      'messaging.operation': 'publish',
      'messaging.message.id': validatedOutcome.eventId,
      'messaging.kafka.event_type': validatedOutcome.eventType,
      'recovery.outcome': validatedOutcome.outcome,
      'component': 'kafka_producer',
    },
  }, async (span) => {
    try {
      const producer = await getProducer();
      const headers = {
        eventId: validatedOutcome.eventId,
        eventType: validatedOutcome.eventType,
        transactionId: validatedOutcome.transactionId,
        caseId: validatedOutcome.caseId,
        version: String(validatedOutcome.version || 1),
      };

      if (requestId) headers.requestId = String(requestId);
      if (correlationId) headers.correlationId = String(correlationId);
      if (originalEventId) headers.originalEventId = String(originalEventId);
      if (replayEventId) headers.replayEventId = String(replayEventId);

      // Inject W3C trace context into Kafka message headers
      injectTraceContext(headers);

      const recordMetadata = await producer.send({
        topic: config.kafka.recoveryOutcomesTopic,
        messages: [
          {
            key: validatedOutcome.transactionId,
            value: serialized,
            headers,
          },
        ],
      });

      const meta = recordMetadata[0] || {};
      const offset = meta.baseOffset !== undefined ? String(meta.baseOffset) : (meta.offset !== undefined ? String(meta.offset) : undefined);

      producerLogger.info('outcome_event_published', {
        topic: config.kafka.recoveryOutcomesTopic,
        partition: meta.partition,
        offset,
        eventId: validatedOutcome.eventId,
        eventType: validatedOutcome.eventType,
        transactionId: validatedOutcome.transactionId,
        caseId: validatedOutcome.caseId,
        outcome: validatedOutcome.outcome,
        requestId,
        correlationId,
      });

      metrics.recordKafkaPublished(config.kafka.recoveryOutcomesTopic, validatedOutcome.eventType);

      return {
        success: true,
        eventId: validatedOutcome.eventId,
        eventType: validatedOutcome.eventType,
        transactionId: validatedOutcome.transactionId,
        caseId: validatedOutcome.caseId,
        topic: config.kafka.recoveryOutcomesTopic,
        partition: meta.partition,
        offset,
      };
    } catch (error) {
      producerLogger.error('outcome_event_publish_failed', {
        eventId: validatedOutcome.eventId,
        caseId: validatedOutcome.caseId,
        transactionId: validatedOutcome.transactionId,
        error: error.message,
      });
      throw error;
    }
  });
}

/**
 * Publish a validated dead-letter event to the dead-letter-events Kafka topic
 */
export async function publishDeadLetterEvent(dlqData) {
  const validation = validateDeadLetterEvent(dlqData);
  if (!validation.success) {
    const error = new Error(`DLQ event validation failed: ${validation.errorMessage}`);
    error.validationErrors = validation.errors;
    error.statusCode = 400;
    throw error;
  }

  const validatedDLQ = validation.data;
  const serialized = serializeEvent(DeadLetterEventSchema, validatedDLQ);

  return withSpan(`kafka.produce ${config.kafka.deadLetterTopic}`, {
    kind: SpanKind.PRODUCER,
    attributes: {
      'messaging.system': 'kafka',
      'messaging.destination': config.kafka.deadLetterTopic,
      'messaging.destination_kind': 'topic',
      'messaging.kafka.event_type': validatedDLQ.eventType,
      'dlq.failure_type': validatedDLQ.failureType,
      'component': 'kafka_producer',
    },
  }, async (span) => {
    try {
      const producer = await getProducer();
      const headers = {
        eventId: validatedDLQ.eventId,
        eventType: validatedDLQ.eventType,
        originalTopic: validatedDLQ.originalTopic,
        failureType: validatedDLQ.failureType,
        version: String(validatedDLQ.version || 1),
      };

      // Inject W3C trace context into Kafka message headers
      injectTraceContext(headers);

      const recordMetadata = await producer.send({
        topic: config.kafka.deadLetterTopic,
        messages: [
          {
            key: validatedDLQ.transactionId || validatedDLQ.eventId,
            value: serialized,
            headers,
          },
        ],
      });

      const meta = recordMetadata[0] || {};
      const offset = meta.baseOffset !== undefined ? String(meta.baseOffset) : (meta.offset !== undefined ? String(meta.offset) : undefined);

      console.log(
        `[Kafka Producer] Published DLQ ${validatedDLQ.eventId} -> ` +
        `Topic: ${config.kafka.deadLetterTopic}, Partition: ${meta.partition}, Offset: ${offset}`
      );

      metrics.recordKafkaPublished(config.kafka.deadLetterTopic, validatedDLQ.eventType);

      return {
        success: true,
        eventId: validatedDLQ.eventId,
        topic: config.kafka.deadLetterTopic,
        partition: meta.partition,
        offset,
      };
    } catch (error) {
      console.error(
        `[Kafka Producer Error] Failed to publish DLQ event ${validatedDLQ.eventId}:`,
        error.message
      );
      throw error;
    }
  });
}

