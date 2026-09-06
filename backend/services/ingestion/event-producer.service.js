import crypto from 'crypto';
import { findOrCreateCustomer } from '../../db/queries/customers.queries.js';
import { createTransaction } from '../../db/queries/transactions.queries.js';
import { checkIdempotency } from '../../redis/redis.client.js';
import { publishPaymentEvent } from '../../kafka/producer.js';
import { EVENT_TYPES, FAILURE_REASONS, PAYMENT_METHODS } from '../../kafka/schemas/events.schema.js';

export class EventProducerService {
  /**
   * Ingest a payment failure event, persist to PostgreSQL, and publish to Kafka payment-events topic
   */
  static async ingestAndPublishPaymentFailure(input) {
    // 1. Basic Input Validation
    if (!input) {
      throw new Error('Missing event payload');
    }

    const amount = Number(input.amount);
    if (!amount || isNaN(amount) || amount <= 0) {
      throw new Error('Invalid amount: amount must be a positive number');
    }

    if (!input.customer?.email) {
      throw new Error('Customer email is required for ingestion');
    }

    const paymentMethod = input.paymentMethod || 'card';
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      throw new Error(`Invalid paymentMethod '${paymentMethod}'. Allowed: ${PAYMENT_METHODS.join(', ')}`);
    }

    const failureReason = input.failureReason || 'insufficient_funds';
    if (!FAILURE_REASONS.includes(failureReason)) {
      throw new Error(`Invalid failureReason '${failureReason}'. Allowed: ${FAILURE_REASONS.join(', ')}`);
    }

    // 2. Idempotency Check
    const dedupId = input.idempotencyKey || input.metadata?.razorpayPaymentId || input.eventId;
    if (dedupId) {
      const isFirstOccurrence = await checkIdempotency(`idempotency:ingest:${dedupId}`, 86400);
      if (!isFirstOccurrence) {
        console.warn(`[Ingestion Producer] Duplicate event detected for key: ${dedupId}`);
        return {
          success: true,
          status: 'duplicate',
          isDuplicate: true,
          message: 'Payment failure event already accepted and queued for processing',
          idempotencyKey: dedupId,
        };
      }
    }

    // 3. Persist Customer and Transaction in PostgreSQL (Source of Truth)
    const customer = await findOrCreateCustomer({
      name: input.customer.name || 'Customer',
      email: input.customer.email,
      phone: input.customer.phone || null,
    });

    const transaction = await createTransaction({
      customerId: customer.id,
      amount,
      currency: input.currency || 'INR',
      paymentMethod,
      status: 'failed',
      failureReason,
      attemptCount: input.attemptCount || 1,
      metadata: input.metadata || {},
    });

    // 4. Construct Minimal Normalized Event (NO customer PII in Kafka message)
    const eventId = (input.eventId && input.eventId.length === 36 && input.eventId.includes('-'))
      ? input.eventId
      : crypto.randomUUID();

    const paymentEvent = {
      eventId,
      eventType: input.eventType || (paymentMethod === 'subscription_mandate' ? EVENT_TYPES.SUBSCRIPTION_FAILED : EVENT_TYPES.PAYMENT_FAILED),
      occurredAt: input.timestamp || new Date().toISOString(),
      transactionId: transaction.id,
      customerId: customer.id,
      payload: {
        amount: parseFloat(transaction.amount),
        currency: transaction.currency,
        paymentMethod: transaction.paymentMethod,
        failureReason: transaction.failureReason,
        attemptCount: transaction.attemptCount,
        metadata: transaction.metadata || {},
      },
      version: 1,
    };

    // 5. Publish to Kafka payment-events topic
    try {
      const publishResult = await publishPaymentEvent(paymentEvent);

      return {
        success: true,
        status: 'queued',
        eventId: paymentEvent.eventId,
        transactionId: transaction.id,
        customerId: customer.id,
        topic: publishResult.topic,
        partition: publishResult.partition,
        offset: publishResult.offset,
        transaction,
        customer,
        message: 'Payment failure event successfully queued to Kafka for recovery processing',
      };
    } catch (publishError) {
      console.error(`[Ingestion Producer Error] Failed to publish event ${paymentEvent.eventId} to Kafka:`, publishError.message);
      const error = new Error(`Failed to publish event to message broker: ${publishError.message}`);
      error.eventId = paymentEvent.eventId;
      error.transactionId = transaction.id;
      error.statusCode = 503;
      throw error;
    }
  }
}
