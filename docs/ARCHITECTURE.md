# RecoverIQ — Architecture & System Design Document

This document defines the system architecture, component boundaries, data ownership model, failure handling strategies, and security guarantees for RecoverIQ as implemented in **Phase 4: Event-Driven Architecture with Apache Kafka**.

---

## 1. System Components & Technology Stack

```mermaid
graph TB
    subgraph Client["Client Layer"]
        MERCHANT["Merchant Dashboard\n(Next.js App Router)"]
        CUSTOMER["Customer Recovery Portal\n(/recover/[token])"]
        SIMULATE["Simulate Trigger UI\n(/simulate)"]
    end

    subgraph BackendGateway["Backend & API Layer"]
        EXPRESS["RecoverIQ Backend API\n(Node.js / Express / JavaScript)"]
        AUTH["Auth Service\n(JWT / Bearer Tokens)"]
        GUARDRAIL["Policy & Guardrail Engine\n(ALLOW / APPROVE / BLOCK)"]
        MCP_TOOLS["Recovery Action Tools\n(retry / message / escalate)"]
    end

    subgraph EventBackbone["Event Streaming Layer"]
        REDPANDA["Apache Kafka / Redpanda\n(Port 19092)"]
        TOPIC_PAY["payment-events"]
        TOPIC_OUT["recovery-outcomes"]
        TOPIC_DLQ["dead-letter-events"]
        WORKER_REC["recovery-worker-group"]
        WORKER_OUT["outcome-worker-group"]
    end

    subgraph DataLayer["Storage & Cache Layer"]
        POSTGRES[("PostgreSQL 16\n(Source of Truth / Drizzle ORM)")]
        REDIS[("Redis 7\n(Idempotency & Locks)")]
    end

    subgraph ML_Microservice["ML & AI Diagnostic Layer"]
        FASTAPI["ML Inference Service\n(Python / FastAPI / LightGBM)"]
        SHAP["Explainability Engine\n(TreeSHAP Reason Codes)"]
    end

    MERCHANT -->|REST API / JWT| EXPRESS
    CUSTOMER -->|Tokenized Link| EXPRESS
    SIMULATE -->|REST API| EXPRESS

    EXPRESS -->|Idempotency / Locks| REDIS
    EXPRESS -->|Drizzle ORM| POSTGRES
    EXPRESS -->|KafkaJS Producer| REDPANDA

    REDPANDA --> TOPIC_PAY
    REDPANDA --> TOPIC_OUT
    REDPANDA --> TOPIC_DLQ

    TOPIC_PAY --> WORKER_REC
    TOPIC_OUT --> WORKER_OUT

    WORKER_REC -->|State Lookup| POSTGRES
    WORKER_REC -->|REST /predict| FASTAPI
    FASTAPI --> SHAP
    WORKER_REC --> GUARDRAIL
    WORKER_REC --> MCP_TOOLS
    WORKER_REC -->|Produce Outcome| TOPIC_OUT
    WORKER_REC -.->|Poison / Fail| TOPIC_DLQ

    WORKER_OUT -->|Atomic Transaction| POSTGRES
```

### Technology Matrix
- **Backend API & Workers**: Node.js v22+, Express 4.x (ES Modules), KafkaJS 2.x
- **Event Streaming**: Redpanda (Kafka 3.x compatible)
- **Database & ORM**: PostgreSQL 16, Drizzle ORM 0.38+
- **Cache & Distributed Locks**: Redis 7, `ioredis`
- **Frontend Dashboard & Recovery UI**: Next.js 14, React 18, Tailwind CSS
- **ML Diagnostic Microservice**: Python 3.10+, FastAPI, LightGBM, TreeSHAP
- **Testing**: Node.js native test runner (`node --test`), `node:assert/strict`

---

## 2. Service Boundaries & Data Ownership

| Component | Responsibility | Data Ownership |
|---|---|---|
| **PostgreSQL Database** | Authoritative source of truth for all business state. | Owns `customers`, `transactions`, `decisions`, `actions`, `messages`, `overrides`, `recovery_links`. |
| **Kafka Broker** | Durable, ordered event backbone and transport stream. | Stores serialized event streams with retention. Does **NOT** own relational business state. |
| **Redis Cache** | Short-term distributed locks, rate-limits, and idempotency keys. | Owns `idempotency:*`, `lock:*`, `rate_limit:*`, `dlq:event:*`, and `replay:completed:*` keys with TTLs. |
| **Backend Producer** | Validates incoming webhooks, records initial transaction in DB, publishes minimal event to Kafka, and immediately responds HTTP 200. | Does not execute recovery actions directly. |
| **Recovery Consumer (`recovery-worker-group`)** | Consumes from `payment-events`, loads DB context, runs ML prediction, evaluates guardrails, executes recovery tools, and produces to `recovery-outcomes`. | Reads DB; writes decision records and tool results. |
| **Outcome Consumer (`outcome-worker-group`)** | Consumes from `recovery-outcomes` and executes atomic PostgreSQL reconciliation. | Atomic multi-table writer (`transactions`, `decisions`, `actions`, `messages`). |
| **ML Microservice** | Computes statistical recovery probability and TreeSHAP attribution codes. | Pure inference service; does not write to database. |

---

## 3. End-to-End Event Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor Webhook as Payment Gateway / Sim
    participant Backend as Ingestion Producer
    participant Redis as Redis Cache
    participant Postgres as PostgreSQL DB
    participant Kafka as Kafka (payment-events)
    participant RecWorker as Recovery Consumer
    participant ML as ML Service
    participant Guardrail as Guardrail Policy
    participant Tools as Recovery Tools
    participant OutKafka as Kafka (recovery-outcomes)
    participant OutWorker as Outcome Consumer

    Webhook->>Backend: POST /api/webhooks/payment-failed
    Backend->>Redis: Check Idempotency (eventId / payload)
    Backend->>Postgres: Create Initial Transaction (status: failed)
    Backend->>Kafka: Publish PaymentEvent (minimal, no PII)
    Backend-->>Webhook: HTTP 200 OK (Accepted)

    Kafka->>RecWorker: Consume Message from payment-events
    RecWorker->>Redis: Check eventId Idempotency
    RecWorker->>Postgres: Fetch Authoritative Transaction & Customer Stats
    RecWorker->>ML: POST /predict/recovery-probability
    ML-->>RecWorker: Score & SHAP Reason Codes
    RecWorker->>Guardrail: Evaluate Policy Engine
    
    alt Guardrail == ALLOW
        RecWorker->>Tools: Execute Bounded Tool (attempt_recovery / send_link)
        Tools-->>RecWorker: Execution Result
        RecWorker->>OutKafka: Publish Outcome (outcome: recovered / failed)
    else Guardrail == REQUIRE_APPROVAL
        RecWorker->>OutKafka: Publish Outcome (outcome: pending_review)
    else Guardrail == BLOCK
        RecWorker->>OutKafka: Publish Outcome (outcome: blocked)
    end
    
    RecWorker->>Kafka: Commit Offset (Manual)

    OutKafka->>OutWorker: Consume Outcome from recovery-outcomes
    OutWorker->>Postgres: Atomic Transaction: Update Txn + Decision + Action + Audit Message
    OutWorker->>OutKafka: Commit Offset (Manual)
```

---

## 4. Failure Handling & Resilience Architecture

### Error Classification Matrix
```
                            Incoming Message
                                   │
                     ┌─────────────┴─────────────┐
                     ▼                           ▼
            Is Payload Malformed?       Is Contract Schema Valid?
              (JSON SyntaxError)            (Zod safeParse)
                     │                           │
                     ├─ Yes ─────────────────────┼─ No
                     ▼                           ▼
            [POISON MESSAGE]            [SCHEMA ERROR]
                     │                           │
                     └─────────────┬─────────────┘
                                   ▼
                      Route Directly to DLQ Topic
                      Commit Offset (Unblock Lag)
```

1. **Poison Messages & Schema Violations**:
   - Immediate routing to `dead-letter-events` topic with `failureType: 'poison_message'` or `'schema_validation_error'`.
   - Consumer commits offset immediately to avoid head-of-line blocking.
2. **Transient Failures (Downstream 5xx, Network Timeout, DB Deadlock)**:
   - Evaluated by `isTransientError()`.
   - Retried with exponential backoff + jitter up to `config.retry.maxRetries` (default: 3).
   - If retries exhaust $\rightarrow$ routed to `dead-letter-events` as `transient_exhausted` and offset committed.
3. **Database Write Ordering / Race Conditions**:
   - If a referenced `transactionId` or `caseId` is not found immediately in PostgreSQL, `executeWithRetry` performs a bounded recheck (3 attempts with 100ms backoff).
   - If the record appears, processing continues smoothly. If still absent after attempts, it routes to DLQ as `database_error`.

---

## 5. Replay Model & Invariants

```mermaid
flowchart LR
    DLQ_EVENT[("dead-letter-events\nTopic")] --> INSPECT["Admin Inspection\n(GET /api/admin/events/dlq/:id)"]
    INSPECT --> REPLAY_REQ["Replay Request\n(POST /api/admin/events/:id/replay)"]
    REPLAY_REQ --> DUPE_CHECK{"Already Replayed?\n(Redis completed key)"}
    
    DUPE_CHECK -->|Yes| ERR_409["Reject: 409 Conflict"]
    DUPE_CHECK -->|No| VAL_CHECK{"Validate Original\nPayload against Schema"}
    
    VAL_CHECK -->|Invalid| ERR_400["Reject: 400 Bad Request"]
    VAL_CHECK -->|Valid| GEN_NEW["1. Generate new unique eventId\n2. Set originalEventId & isReplay: true\n3. Record Redis replay key"]
    
    GEN_NEW --> PUB_TOPIC["Publish to original topic\n(payment-events)"]
    PUB_TOPIC --> DB_AUDIT["Append Audit Log in PostgreSQL messages\n(eventTaken: event_replayed)"]
    PUB_TOPIC --> CONSUMER["Normal Consumer Pipeline\n(Validates & Evaluates Guardrails)"]
```

### Replay Invariants
- **Original DLQ Immutability**: The original dead-letter record in Kafka remains completely unchanged.
- **Traceable Lineage**: Replayed events carry a new unique `eventId` while explicitly referencing `originalEventId` and `replayedFromDlqId`.
- **Zero Bypass**: Replayed events are processed through the standard consumer group, running feature extraction, ML inference, and guardrails.

---

---

## 6. Security Boundaries

1. **Authority Enforcement**: Machine learning models and GenAI agents provide suggestions only. The backend policy engine in Node.js owns all execution authority and security guardrails.
2. **Internal Service Isolation**: Downstream ML (`recoveriq-ml-service`) and GenAI (`recoveriq-genai-service`) microservices are strictly internal and inaccessible to the browser/public network.
3. **Internal Service Authentication**: All inter-service communications (`Backend -> ML`, `Backend -> GenAI`) require a pre-shared cryptographic service token passed via `x-internal-service-token` or `Authorization: Bearer <token>`. Unauthorized requests are rejected with `401 Unauthorized` / `403 Forbidden`.
4. **Admin Authentication**: All replay, review, and DLQ inspection endpoints require valid JWT authentication via `requireMerchantAuth`.
5. **PII Minimization**: Kafka payloads and internal microservice contexts never transmit unnecessary raw customer PII. Workers resolve customer profile data directly from PostgreSQL using opaque keys.

---

## 7. Service Boundary Topology & Token Flow

```mermaid
flowchart TD
    subgraph PublicHost["Public / Host Layer"]
        BROWSER["Web Browser / Client UI"]
        GATEWAY["Payment Gateway Webhooks"]
    end

    subgraph ApiBoundary["Public API Authority (Port 4000)"]
        BACKEND["RecoverIQ Backend API\n(Node.js / Express)\n- JWT Auth / Merchant Session\n- Idempotency & Rate Limiting\n- Policy Engine Guardrail Gate"]
    end

    subgraph InternalServices["Isolated Internal Microservices (Port 8000 / 8001)"]
        direction TB
        ML["ML Service (FastAPI :8000)\n- POST /predict\n- Validates x-internal-service-token\n- Zero DB Writes"]
        GENAI["GenAI Service (FastAPI :8001)\n- POST /internal/recovery/analyze\n- POST /internal/recovery/plan\n- Validates x-internal-service-token"]
    end

    BROWSER -->|Public HTTPS / REST| BACKEND
    GATEWAY -->|Signed Webhook| BACKEND

    BROWSER -.->|BLOCKED / 401 Unauthorized| ML
    BROWSER -.->|BLOCKED / 401 Unauthorized| GENAI

    BACKEND -->|x-internal-service-token: ML_INTERNAL_TOKEN| ML
    BACKEND -->|x-internal-service-token: GENAI_INTERNAL_TOKEN| GENAI
```

### Internal Token Configuration
| Environment Variable | Description | Default Dev Secret | Protected Endpoints |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | Global shared fallback token for internal microservices | `recoveriq-internal-service-token-dev-secret` | All internal APIs |
| `ML_INTERNAL_TOKEN` | Specific token required by `ml-service` | `recoveriq-internal-service-token-dev-secret` | `/predict` |
| `GENAI_INTERNAL_TOKEN` | Specific token required by `genai-service` | `recoveriq-internal-service-token-dev-secret` | `/internal/recovery/*`, `/analyze` |

Health probes (`/health`, `/health/live`, `/health/ready`) remain open to orchestrator health checks without requiring internal tokens.

