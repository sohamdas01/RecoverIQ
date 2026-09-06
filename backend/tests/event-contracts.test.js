import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import {
  EVENT_TYPES,
  OUTCOME_TYPES,
  PaymentEventSchema,
  OutcomeEventSchema,
  DeadLetterEventSchema,
  validatePaymentEvent,
  validateOutcomeEvent,
  validateDeadLetterEvent,
  serializeEvent,
  deserializeEvent,
} from '../kafka/schemas/events.schema.js';

describe('Event Contracts & Schema Validation Tests', () => {

  describe('1. Payment Event Schema', () => {
    it('should validate a correctly formed payment.failed event (minimal, no PII)', () => {
      const validEvent = {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.PAYMENT_FAILED,
        occurredAt: new Date().toISOString(),
        transactionId: 'txn_test_123',
        customerId: 'cust_test_456',
        payload: {
          amount: 4999.00,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'insufficient_funds',
          attemptCount: 1,
          metadata: { gateway: 'razorpay' },
        },
        version: 1,
      };

      const result = validatePaymentEvent(validEvent);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.transactionId, 'txn_test_123');
      assert.strictEqual(result.data.customerId, 'cust_test_456');
      assert.strictEqual(result.data.payload.amount, 4999.00);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should validate a subscription.failed event', () => {
      const validEvent = {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.SUBSCRIPTION_FAILED,
        occurredAt: new Date().toISOString(),
        transactionId: 'txn_sub_789',
        customerId: 'cust_sub_999',
        payload: {
          amount: 1499.00,
          currency: 'INR',
          paymentMethod: 'subscription_mandate',
          failureReason: 'card_expired',
          attemptCount: 2,
        },
      };

      const result = validatePaymentEvent(validEvent);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.eventType, 'subscription.failed');
    });

    it('should reject payment event with invalid payment method and negative amount', () => {
      const invalidEvent = {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.PAYMENT_FAILED,
        occurredAt: new Date().toISOString(),
        transactionId: 'txn_123',
        customerId: 'cust_123',
        payload: {
          amount: -500, // Invalid: must be positive
          currency: 'INR',
          paymentMethod: 'bitcoin', // Invalid: not supported
          failureReason: 'insufficient_funds',
        },
      };

      const result = validatePaymentEvent(invalidEvent);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.some((e) => e.field === 'payload.amount'));
      assert.ok(result.errors.some((e) => e.field === 'payload.paymentMethod'));
    });

    it('should reject payment event with missing required fields (customerId, transactionId, invalid eventType)', () => {
      const missingFieldsEvent = {
        eventType: 'unsupported.event.type',
        payload: {
          amount: 1000,
          paymentMethod: 'card',
          failureReason: 'bank_outage',
        },
      };

      const result = validatePaymentEvent(missingFieldsEvent);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.some((e) => e.field === 'transactionId'));
      assert.ok(result.errors.some((e) => e.field === 'customerId'));
      assert.ok(result.errors.some((e) => e.field === 'eventType'));
    });
  });

  describe('2. Recovery Outcome Event Schema', () => {
    it('should validate a correctly formed recovery.completed outcome event', () => {
      const validOutcome = {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.RECOVERY_COMPLETED,
        occurredAt: new Date().toISOString(),
        transactionId: 'txn_test_123',
        caseId: 'dec_test_456',
        outcome: OUTCOME_TYPES.RECOVERED,
        toolName: 'attempt_recovery',
        recoveredAmount: 4999.00,
        currency: 'INR',
        details: { captureMethod: 'auto_retry' },
        version: 1,
      };

      const result = validateOutcomeEvent(validOutcome);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.outcome, 'recovered');
      assert.strictEqual(result.data.caseId, 'dec_test_456');
    });

    it('should validate an escalation outcome event', () => {
      const validEscalation = {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.RECOVERY_ESCALATED,
        occurredAt: new Date().toISOString(),
        transactionId: 'txn_fraud_777',
        caseId: 'dec_fraud_888',
        outcome: OUTCOME_TYPES.ESCALATED,
        toolName: 'escalate_to_human',
        details: { ticketId: 'TICK-12345', priority: 'urgent' },
      };

      const result = validateOutcomeEvent(validEscalation);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.outcome, 'escalated');
    });

    it('should reject outcome event with missing caseId and invalid outcome status', () => {
      const invalidOutcome = {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.RECOVERY_COMPLETED,
        occurredAt: new Date().toISOString(),
        transactionId: 'txn_test_123',
        // caseId missing
        outcome: 'invalid_outcome_status',
      };

      const result = validateOutcomeEvent(invalidOutcome);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.some((e) => e.field === 'caseId'));
      assert.ok(result.errors.some((e) => e.field === 'outcome'));
    });
  });

  describe('3. Dead Letter Event Schema', () => {
    it('should validate a valid dead letter event with complete diagnostic context', () => {
      const validDLQ = {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.DEAD_LETTER_RECORDED,
        occurredAt: new Date().toISOString(),
        originalTopic: 'payment-events',
        originalEventId: crypto.randomUUID(),
        transactionId: 'txn_dlq_001',
        partition: 0,
        offset: '142',
        failureReason: 'Downstream ML service timed out after 3 retries',
        failureType: 'transient_exhausted',
        retryCount: 3,
        originalPayload: { raw: 'data' },
        version: 1,
      };

      const result = validateDeadLetterEvent(validDLQ);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.failureType, 'transient_exhausted');
      assert.strictEqual(result.data.retryCount, 3);
    });

    it('should reject DLQ event with invalid failureType and missing failureReason', () => {
      const invalidDLQ = {
        eventId: crypto.randomUUID(),
        originalTopic: 'payment-events',
        // failureReason missing
        failureType: 'non_existent_failure_type',
      };

      const result = validateDeadLetterEvent(invalidDLQ);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.some((e) => e.field === 'failureReason'));
      assert.ok(result.errors.some((e) => e.field === 'failureType'));
    });
  });

  describe('4. Serialization and Deserialization Helpers', () => {
    it('should serialize valid event to JSON string and deserialize Buffer back to object', () => {
      const eventData = {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.PAYMENT_FAILED,
        occurredAt: new Date().toISOString(),
        transactionId: 'txn_ser_001',
        customerId: 'cust_ser_002',
        payload: {
          amount: 2500,
          currency: 'INR',
          paymentMethod: 'upi',
          failureReason: 'bank_outage',
          attemptCount: 1,
        },
      };

      // Serialize
      const serialized = serializeEvent(PaymentEventSchema, eventData);
      assert.strictEqual(typeof serialized, 'string');

      // Deserialize from Buffer (as received from Kafka)
      const buffer = Buffer.from(serialized, 'utf-8');
      const deserialized = deserializeEvent(buffer);

      assert.strictEqual(deserialized.success, true);
      assert.strictEqual(deserialized.data.transactionId, 'txn_ser_001');
      assert.strictEqual(deserialized.data.payload.amount, 2500);
      assert.strictEqual(deserialized.data.payload.paymentMethod, 'upi');
    });

    it('should throw structured error when attempting to serialize invalid event', () => {
      const invalidData = {
        eventType: 'invalid.type',
        payload: { amount: -10 },
      };

      assert.throws(
        () => serializeEvent(PaymentEventSchema, invalidData),
        (err) => {
          assert.ok(err.message.includes('Event serialization failed'));
          assert.ok(Array.isArray(err.validationErrors));
          return true;
        }
      );
    });

    it('should handle deserialization of malformed JSON string gracefully without throwing', () => {
      const malformed = '{ invalid: json }';
      const result = deserializeEvent(malformed);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.data, null);
      assert.ok(result.error.includes('JSON Deserialization Error'));
    });

    it('should handle empty or null inputs in deserializer gracefully', () => {
      const resultNull = deserializeEvent(null);
      assert.strictEqual(resultNull.success, false);
      assert.strictEqual(resultNull.data, null);

      const resultEmpty = deserializeEvent('');
      assert.strictEqual(resultEmpty.success, false);
      assert.strictEqual(resultEmpty.data, null);
    });
  });
});
