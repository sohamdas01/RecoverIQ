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

  try {
    const producer = await getProducer();
    const recordMetadata = await producer.send({
      topic: config.kafka.paymentEventsTopic,
      messages: [
        {
          key: validatedEvent.transactionId,
          value: serialized,
          headers: {
            eventId: validatedEvent.eventId,
            eventType: validatedEvent.eventType,
            transactionId: validatedEvent.transactionId,
            customerId: validatedEvent.customerId,
            version: String(validatedEvent.version || 1),
          },
        },
      ],
    });

    const meta = recordMetadata[0] || {};
    const offset = meta.baseOffset !== undefined ? String(meta.baseOffset) : (meta.offset !== undefined ? String(meta.offset) : undefined);

    console.log(
      `[Kafka Producer] Published event ${validatedEvent.eventId} (${validatedEvent.eventType}) -> ` +
      `Topic: ${config.kafka.paymentEventsTopic}, Partition: ${meta.partition}, Offset: ${offset}`
    );

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
    console.error(
      `[Kafka Producer Error] Failed to publish event ${validatedEvent.eventId} for transaction ${validatedEvent.transactionId}:`,
      error.message
    );
    error.eventId = validatedEvent.eventId;
    error.transactionId = validatedEvent.transactionId;
    throw error;
  }
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

  try {
    const producer = await getProducer();
    const recordMetadata = await producer.send({
      topic: config.kafka.recoveryOutcomesTopic,
      messages: [
        {
          key: validatedOutcome.transactionId,
          value: serialized,
          headers: {
            eventId: validatedOutcome.eventId,
            eventType: validatedOutcome.eventType,
            transactionId: validatedOutcome.transactionId,
            caseId: validatedOutcome.caseId,
            version: String(validatedOutcome.version || 1),
          },
        },
      ],
    });

    const meta = recordMetadata[0] || {};
    const offset = meta.baseOffset !== undefined ? String(meta.baseOffset) : (meta.offset !== undefined ? String(meta.offset) : undefined);

    console.log(
      `[Kafka Producer] Published outcome ${validatedOutcome.eventId} (${validatedOutcome.eventType}) -> ` +
      `Topic: ${config.kafka.recoveryOutcomesTopic}, Partition: ${meta.partition}, Offset: ${offset}`
    );

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
    console.error(
      `[Kafka Producer Error] Failed to publish outcome ${validatedOutcome.eventId}:`,
      error.message
    );
    throw error;
  }
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

  try {
    const producer = await getProducer();
    const recordMetadata = await producer.send({
      topic: config.kafka.deadLetterTopic,
      messages: [
        {
          key: validatedDLQ.transactionId || validatedDLQ.eventId,
          value: serialized,
          headers: {
            eventId: validatedDLQ.eventId,
            eventType: validatedDLQ.eventType,
            originalTopic: validatedDLQ.originalTopic,
            failureType: validatedDLQ.failureType,
            version: String(validatedDLQ.version || 1),
          },
        },
      ],
    });

    const meta = recordMetadata[0] || {};
    const offset = meta.baseOffset !== undefined ? String(meta.baseOffset) : (meta.offset !== undefined ? String(meta.offset) : undefined);

    console.log(
      `[Kafka Producer] Published DLQ ${validatedDLQ.eventId} -> ` +
      `Topic: ${config.kafka.deadLetterTopic}, Partition: ${meta.partition}, Offset: ${offset}`
    );

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
}
