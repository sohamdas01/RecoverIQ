# RecoverIQ — Kafka Event Contracts & Schema Specification

This document provides a developer reference for all Apache Kafka topics, message contracts, Zod schemas, validation rules, and message formats used across the RecoverIQ event pipeline.

---

## 1. Kafka Topics Overview

| Topic Name | Default Partitions | Replication Factor | Retention Period | Producer(s) | Consumer Group(s) |
|---|:---:|:---:|:---:|---|---|
| **`payment-events`** | 3 | 1 (Local) | 7 days | Ingestion Producer, Event Replay Service | `recovery-worker-group` |
| **`recovery-outcomes`** | 3 | 1 (Local) | 30 days | Recovery Consumer Worker | `outcome-worker-group` |
| **`dead-letter-events`** | 3 | 1 (Local) | 90 days | Recovery Consumer, Outcome Consumer, Retry Handler | Admin CLI / Replay API / Diagnostics |

---

## 2. Topic: `payment-events`

### Schema: `PaymentEventSchema`
Minimal payment failure event. **Strictly contains no customer PII** (no name, email, or phone).

```typescript
{
  eventId: string;          // UUIDv4 (unique per message delivery)
  eventType: string;        // "payment.failed" | "subscription.failed"
  occurredAt: string;       // ISO 8601 UTC timestamp
  transactionId: string;    // Authoritative PostgreSQL transaction ID
  customerId: string;       // Authoritative PostgreSQL customer ID
  payload: {
    amount: number;         // Positive transaction amount
    currency: string;       // 3-letter ISO code (e.g. "INR")
    paymentMethod: string;  // "card" | "upi" | "netbanking" | "subscription_mandate"
    failureReason: string;  // e.g. "insufficient_funds", "card_expired", "bank_outage", "network_timeout", "authentication_failed", "high_risk_fraud"
    attemptCount: number;   // Integer >= 1
    metadata?: object;      // Optional extra gateway metadata
  };
  version: number;          // Default: 1
}
```

### Sanitized Example
```json
{
  "eventId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "eventType": "payment.failed",
  "occurredAt": "2026-09-06T04:15:00.000Z",
  "transactionId": "txn_8ac8691c-849f-4a90-8ed9-a994ec599493",
  "customerId": "cust_c42b50bd-609d-480e-b0e0-06014c1491d0",
  "payload": {
    "amount": 2499.00,
    "currency": "INR",
    "paymentMethod": "card",
    "failureReason": "insufficient_funds",
    "attemptCount": 1,
    "metadata": {
      "gateway": "razorpay",
      "gatewayErrorCode": "BAD_REQUEST_ERROR"
    }
  },
  "version": 1
}
```

### Kafka Message Headers
- `eventId`: UUID
- `eventType`: `payment.failed`
- `transactionId`: string
- `customerId`: string
- `version`: `1`

---

## 3. Topic: `recovery-outcomes`

### Schema: `OutcomeEventSchema`
Published when a recovery action completes, is scheduled, or is queued for merchant sign-off.

```typescript
{
  eventId: string;          // UUIDv4
  eventType: string;        // "recovery.completed" | "recovery.failed" | "recovery.escalated" | "recovery.scheduled"
  occurredAt: string;       // ISO 8601 UTC timestamp
  transactionId: string;    // Authoritative PostgreSQL transaction ID
  caseId: string;           // Authoritative PostgreSQL decision ID
  customerId?: string;      // Optional customer ID
  outcome: string;          // "recovered" | "failed" | "escalated" | "scheduled" | "pending_review" | "blocked" | "rejected"
  toolName?: string;        // e.g. "attempt_recovery", "send_recovery_message", "schedule_retry"
  recoveredAmount?: number; // Amount recovered in INR (0 if failed/pending)
  currency?: string;        // Default: "INR"
  details?: object;         // Diagnostic context (ML scores, reason codes, guardrail rules)
  version: number;          // Default: 1
}
```

### Sanitized Example
```json
{
  "eventId": "f7e8d9c0-b1a2-4f3e-8d7c-6b5a4e3f2d1c",
  "eventType": "recovery.completed",
  "occurredAt": "2026-09-06T04:15:02.150Z",
  "transactionId": "txn_8ac8691c-849f-4a90-8ed9-a994ec599493",
  "caseId": "dec_bd38de70-a5d0-4b4a-9f76-cae88b118e11",
  "customerId": "cust_c42b50bd-609d-480e-b0e0-06014c1491d0",
  "outcome": "recovered",
  "toolName": "attempt_recovery",
  "recoveredAmount": 2499.00,
  "currency": "INR",
  "details": {
    "originalEventId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "guardrailDecision": "ALLOW",
    "guardrailReason": "Action 'attempt_recovery' approved by automated guardrail policy engine.",
    "mlScore": 0.82,
    "mlReasonCodes": ["HIGH_CUSTOMER_LOYALTY", "INSUFFICIENT_FUNDS_FIRST_ATTEMPT"],
    "toolExecutionSuccess": true,
    "toolOutput": {
      "paymentId": "pay_test_capture_987654",
      "status": "captured"
    }
  },
  "version": 1
}
```

---

## 4. Topic: `dead-letter-events`

### Schema: `DeadLetterEventSchema`
Preserves unprocessable, poison, or exhausted retry messages with complete diagnostic context.

```typescript
{
  eventId: string;          // UUIDv4 (Dead-letter record ID)
  eventType: string;        // "dead_letter.recorded"
  occurredAt: string;       // ISO 8601 UTC timestamp
  originalTopic: string;    // "payment-events" | "recovery-outcomes"
  originalEventId?: string; // Original event UUID if parseable
  transactionId?: string;   // Transaction ID if extractable
  customerId?: string;      // Customer ID if extractable
  partition?: number;       // Original Kafka partition
  offset?: string;          // Original Kafka message offset
  failureReason: string;    // Human-readable exception or validation summary
  failureType: string;      // "poison_message" | "schema_validation_error" | "transient_exhausted" | "database_error" | "unhandled_error"
  retryCount: number;       // Number of retry attempts made (default: 0)
  originalPayload: any;     // Raw unparsed buffer or deserialized payload
  version: number;          // Default: 1
}
```

### Sanitized Example: Transient Exhausted Failure
```json
{
  "eventId": "dlq_1c601e7e-cd40-4e5b-a408-33254ea34c87",
  "eventType": "dead_letter.recorded",
  "occurredAt": "2026-09-06T04:15:10.000Z",
  "originalTopic": "payment-events",
  "originalEventId": "fa598f56-1dec-4e6a-827b-46ae979a2f83",
  "transactionId": "txn_8ac8691c-849f-4a90-8ed9-a994ec599493",
  "customerId": "cust_c42b50bd-609d-480e-b0e0-06014c1491d0",
  "partition": 0,
  "offset": "888",
  "failureReason": "Downstream ML service returned HTTP 503 Service Unavailable after 3 attempts",
  "failureType": "transient_exhausted",
  "retryCount": 3,
  "originalPayload": {
    "eventId": "fa598f56-1dec-4e6a-827b-46ae979a2f83",
    "eventType": "payment.failed",
    "transactionId": "txn_8ac8691c-849f-4a90-8ed9-a994ec599493",
    "customerId": "cust_c42b50bd-609d-480e-b0e0-06014c1491d0",
    "payload": {
      "amount": 4999.00,
      "currency": "INR",
      "paymentMethod": "card",
      "failureReason": "bank_outage",
      "attemptCount": 1
    },
    "version": 1
  },
  "version": 1
}
```

---

## 5. Replayed Event Structure

When an event is replayed using the CLI tool or Admin API, it is published to its target topic with an updated unique `eventId` while preserving audit lineage:

```json
{
  "eventId": "e5eb065e-7a93-4621-9203-99281ca368d7",
  "eventType": "payment.failed",
  "occurredAt": "2026-09-06T04:20:00.000Z",
  "transactionId": "txn_8ac8691c-849f-4a90-8ed9-a994ec599493",
  "customerId": "cust_c42b50bd-609d-480e-b0e0-06014c1491d0",
  "originalEventId": "fa598f56-1dec-4e6a-827b-46ae979a2f83",
  "isReplay": true,
  "replayedFromDlqId": "dlq_1c601e7e-cd40-4e5b-a408-33254ea34c87",
  "replayedBy": "merchant_admin_ops",
  "replayedAt": "2026-09-06T04:20:00.000Z",
  "payload": {
    "amount": 4999.00,
    "currency": "INR",
    "paymentMethod": "card",
    "failureReason": "bank_outage",
    "attemptCount": 1
  },
  "version": 1
}
```
