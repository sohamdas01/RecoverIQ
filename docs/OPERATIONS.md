# RecoverIQ — Operations & Troubleshooting Runbook

This runbook provides operational instructions for starting, monitoring, diagnosing, and maintaining the RecoverIQ event-driven platform.

---

## 1. Local Environment Startup

### Required Infrastructure Ports
| Service | Technology | Port(s) | Health Endpoint / Probe |
|---|---|:---:|---|
| **Redpanda (Kafka)** | Redpanda v24.x | `19092` (Kafka API), `8082` (HTTP Proxy) | `GET http://localhost:4000/health/kafka` |
| **PostgreSQL** | PostgreSQL 16 | `5433` | `pg_isready -h localhost -p 5433` |
| **Redis** | Redis 7 | `6379` | `redis-cli -p 6379 ping` |
| **ML Microservice** | FastAPI / LightGBM | `8000` | `GET http://localhost:8000/health` |
| **Backend API** | Node.js / Express | `4000` | `GET http://localhost:4000/health` |
| **Merchant Dashboard** | Next.js 14 | `3000` | `http://localhost:3000` |

---

### Starting Services Step-by-Step

#### 1. Start Docker Containers
```bash
# From project root
docker-compose up -d
```

Verify all containers are healthy:
```bash
docker ps
```
You should see:
- `recoveriq-redpanda` on `0.0.0.0:19092->19092`
- `recoveriq-postgres` on `0.0.0.0:5433->5432`
- `recoveriq-redis` on `0.0.0.0:6379->6379`

#### 2. Start ML Microservice
```bash
cd ml-service
source .venv/bin/activate # or .venv\Scripts\activate on Windows
uvicorn app.main:app --port 8000 --reload
```

#### 3. Start Backend Orchestrator
```bash
cd backend
npm install
npm run dev
```

---

## 2. Health Probes, Readiness & Prometheus Metrics

### A. Health & Readiness Probes

| Endpoint | Method | Probe Type | Success Code | Failure Code | Description |
|---|:---:|:---:|:---:|:---:|---|
| **`/health/live`** | `GET` | **Liveness Probe** | `200 OK` | — | Verifies the Node.js event loop is alive and responsive. Does **not** fail if databases or message brokers are temporarily unreachable. |
| **`/health/ready`** | `GET` | **Readiness Probe** | `200 OK` | `503 Service Unavailable` | Evaluates end-to-end dependency connectivity across PostgreSQL, Redis, and Kafka. Returns `not_ready` if any critical dependency is down. |
| **`/health/kafka`** | `GET` | **Kafka Probe** | `200 OK` | `503 Service Unavailable` | Dedicated cluster connectivity check verifying broker connectivity and topic registration. |
| **`/health`** | `GET` | **Composite Health** | `200 OK` | — | Machine-readable health summary for legacy uptime checkers. |

#### 1. Liveness Probe Check
```bash
curl -s http://localhost:4000/health/live | jq .
```
Expected output:
```json
{
  "status": "ok",
  "service": "recoveriq-backend",
  "uptime": 95.35,
  "timestamp": "2026-09-06T07:00:00.000Z"
}
```

#### 2. Readiness Probe Check
```bash
curl -i http://localhost:4000/health/ready
```
Expected response (`HTTP 200 OK`):
```json
{
  "status": "ok",
  "service": "recoveriq-backend",
  "timestamp": "2026-09-06T07:00:00.000Z",
  "dependencies": {
    "postgres": "ok",
    "redis": "ok",
    "kafka": "ok"
  }
}
```

---

### B. Prometheus Metrics Scraping (`GET /metrics`)

The backend exposes an in-memory Prometheus-compatible exposition format endpoint at `GET /metrics` (`Content-Type: text/plain; version=0.0.4; charset=utf-8`).

```bash
curl -s http://localhost:4000/metrics
```

#### Core Metrics Catalog

| Metric Name | Type | Labels | Description |
|---|:---:|:---:|---|
| `http_requests_total` | Counter | `method`, `route`, `status_code` | Total HTTP requests handled by the backend orchestrator. |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Latency distribution of HTTP requests across standard second buckets. |
| `http_errors_total` | Counter | `method`, `route`, `error_type` | HTTP error distribution categorized into bounded error types (`validation_error`, `auth_error`, `not_found`, `timeout`, `dependency_unavailable`, `unknown`). |
| `kafka_messages_consumed_total` | Counter | `topic`, `consumer_group` | Total messages received by Kafka worker consumer groups. |
| `kafka_messages_processed_total` | Counter | `topic`, `status` | Total Kafka messages successfully processed or failed. |
| `kafka_messages_published_total` | Counter | `topic`, `event_type` | Total events produced to Kafka topics (`payment.failed`, `recovery.completed`, etc.). |
| `kafka_processing_duration_seconds` | Histogram | `topic`, `consumer_group` | End-to-end event handling latency in seconds. |
| `recovery_pipeline_executions_total` | Counter | `status` | Total recovery executions (`recovered`, `scheduled`, `pending_review`, `blocked`). |
| `recovery_outcomes_total` | Counter | `outcome`, `action` | Detailed breakdown of recovery actions taken per outcome. |
| `recovery_pipeline_duration_seconds` | Histogram | `outcome` | Latency distribution of full recovery pipelines. |
| `policy_evaluations_total` | Counter | `decision`, `policy_version` | Total Policy Engine evaluations (`ALLOW`, `REQUIRE_APPROVAL`, `BLOCK`). |
| `policy_evaluation_duration_seconds` | Histogram | `decision` | Pure CPU execution latency of deterministic guardrail rules. |
| `ml_predictions_total` | Counter | `model`, `fallback` | Total ML recovery scoring inferences and fallback counts. |
| `ml_prediction_duration_seconds` | Histogram | `model` | Latency distribution of XGBoost / LightGBM scoring calls. |
| `ml_prediction_failures_total` | Counter | `error_type` | Count of ML service timeouts or connection errors triggering fallback. |
| `agent_invocations_total` | Counter | `agent`, `fallback` | GenAI invocations for `analyst` (Agent 1) vs `executor` (Agent 2). |
| `agent_invocation_duration_seconds` | Histogram | `agent` | Latency distribution of autonomous agent reasoning. |
| `agent_failures_total` | Counter | `agent`, `error_type` | Agent reasoning failures or timeouts triggering deterministic playbooks. |
| `tool_executions_total` | Counter | `action`, `status` | Tool executions dispatched by Execution Gate (`attempt_recovery`, `schedule_retry`, `send_recovery_message`, `offer_discount`, etc.). |
| `tool_execution_duration_seconds` | Histogram | `action` | Latency of downstream payment gateway recovery tool executions. |
| `hitl_reviews_total` | Counter | `review_action`, `status` | Merchant review decisions (`APPROVE`, `MODIFY`, `REJECT`). |
| `hitl_pending_created_total` | Counter | — | Total cases routed to `pending_review` requiring human intervention. |
| `dlq_messages_routed_total` | Counter | `topic`, `failure_type` | Messages routed to `dead-letter-events` by error classification. |
| `dlq_replays_total` | Counter | `target_topic`, `status` | Admin-initiated event replays and execution outcome. |

#### 🛡️ Bounded-Label & Cardinality Rules
1. **Zero Dynamic IDs in Labels**: Dynamic identifiers (`transactionId`, `customerId`, `caseId`, `eventId`, `UUID`s, database IDs) are strictly forbidden in metric labels to prevent Prometheus memory exhaustion.
2. **Normalized Route Templates**: Route labels are automatically normalized (e.g. `/api/transactions/9a0b5f33-4bf1...` $\rightarrow$ `/api/transactions/:transactionId` or `/api/transactions/:id`).
3. **Bounded Error Categorization**: Errors are classified into finite categories (`timeout`, `validation_error`, `dependency_unavailable`, `policy_error`, `tool_error`, `kafka_error`, `database_error`, `auth_error`, `not_found`, `unknown`) rather than arbitrary error strings.
4. **Secret Scrubbing**: Passwords, API keys, tokens, JWTs, and payment card numbers are recursively scrubbed from all metric outputs and probe responses.

---

## 3. Observability Architecture: Logs, Metrics & Traces

RecoverIQ implements the three pillars of observability with strict boundary separation and correlation continuity:

| Pillar | Focus | Question Answered | Implementation in RecoverIQ |
|---|---|---|---|
| **Logs** | Discrete events | *What happened?* | Structured JSON logs enriched with correlation IDs (`requestId`, `correlationId`, `caseId`, `transactionId`, `eventId`, `originalEventId`, `replayEventId`) and active `traceId`/`spanId`. Automatic secret and PII scrubbing. |
| **Metrics** | Aggregated telemetry | *How much / how often?* | Prometheus `/metrics` endpoint measuring throughput, error rates, queue depths, and execution latencies across recovery pipelines, agents, ML models, and Kafka topics. |
| **Traces** | Distributed execution paths | *Where was time spent?* | OpenTelemetry distributed tracing with W3C `traceparent` context propagation across HTTP headers and Kafka message headers. Measures per-span latencies across service boundaries without leaking sensitive data. |

### Core Traced Spans
- **`http.server`**: Incoming HTTP request server span (method, normalized route, status code).
- **`kafka.produce <topic>`**: Producer span with W3C `traceparent` injected into message headers.
- **`kafka.consume <topic>`**: Consumer span with extracted W3C trace context.
- **`recovery.pipeline`**: Top-level recovery orchestration lifecycle.
- **`ml.inference`**: Outbound ML probability inference client span.
- **`agent1.analysis`**: Strategic recovery analysis client span.
- **`agent2.planning`**: Tactical execution planning client span.
- **`policy.evaluation`**: Deterministic backend policy authority evaluation span.
- **`tool.execution`**: Bounded tool execution span.
- **`reconciliation.db`**: Outcome consumer database reconciliation span.
- **`hitl.review`**: Human-in-the-loop review action span.
- **`dlq.replay`**: Dead-letter queue replay execution span.

---

## 4. Dead Letter Queue (DLQ) & Event Replay Runbook

### A. Inspecting a DLQ Event
Using CLI:
```bash
node scripts/replay-event.js <dlqEventId> --inspect
```

Using REST API:
```bash
curl -X GET http://localhost:4000/api/admin/events/dlq/<dlqEventId> \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>"
```

---

### B. Safe Event Replay Procedure

1. **Step 1: Dry-Run Verification**
   Always run a dry run first to validate that the original payload is intact and satisfies schema contracts:
   ```bash
   node scripts/replay-event.js <dlqEventId> --dry-run
   ```

2. **Step 2: Execute Replay**
   Execute the replay with an attribution tag:
   ```bash
   # Using CLI tool
   node scripts/replay-event.js <dlqEventId> --by "ops_analyst_name"

   # OR using npm script shortcut
   npm run replay:event <dlqEventId>
   ```

   Or via authenticated HTTP request:
   ```bash
   curl -X POST http://localhost:4000/api/admin/events/<dlqEventId>/replay \
     -H "Authorization: Bearer <ADMIN_JWT_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"replayedBy": "ops_analyst_name"}'
   ```

3. **Step 3: Verify Output & Lineage**
   - The response will contain the `replayEventId` and confirmed Kafka publication status.
   - The replayed event will be picked up by `recovery-worker-group` and processed through ML scoring and guardrail policies.
   - An audit record with `eventTaken: 'event_replayed'` is recorded in the PostgreSQL `messages` table.

---

## 4. Running the Test Suite

```bash
cd backend

# Run all 26 test suites
npm test

# Run a specific test suite file
node --test tests/kafka-client.test.js
node --test tests/event-contracts.test.js
node --test tests/producer.test.js
node --test tests/recovery-consumer.test.js
node --test tests/outcome-consumer.test.js
node --test tests/dlq-retry.test.js
node --test tests/event-replay.test.js
node --test tests/failure-scenarios-pipeline.test.js
```

---

## 5. Common Failure Scenarios & Troubleshooting

### Scenario 1: Poison Message in `payment-events`
- **Symptom**: Incoming webhook payload contains malformed JSON or invalid schema.
- **System Action**: `recovery-worker-group` rejects event, classifies error as `poison_message` or `schema_validation_error`, routes it to `dead-letter-events`, and commits offset.
- **Action Required**: Inspect DLQ event using `node scripts/replay-event.js <id> --inspect`. If payload format was invalid at source, notify the upstream gateway integration team.

### Scenario 2: Downstream ML Service Outage (HTTP 503)
- **Symptom**: ML microservice on port 8000 is down or timing out.
- **System Action**: Recovery consumer executes exponential backoff retries (up to 3 attempts). If ML service does not recover within retry window, event is safely routed to DLQ as `transient_exhausted`.
- **Action Required**: Restart ML service (`uvicorn app.main:app --port 8000`), then replay the exhausted DLQ event using `node scripts/replay-event.js <id>`.

### Scenario 3: Database Write Ordering / Latency
- **Symptom**: Recovery event arrives before transaction row write completes in PostgreSQL.
- **System Action**: Consumer performs bounded recheck (3 attempts with 100ms backoff). In 99.9% of cases, the row is available on attempt 2 and processing completes normally without routing to DLQ.
- **Action Required**: None (handled autonomously).

### Scenario 4: Duplicate Replay Prevention (HTTP 409 Conflict)
- **Symptom**: An operator attempts to replay an event that has already been successfully replayed.
- **System Action**: Replay service detects existing key in Redis (`replay:completed:<dlqEventId>`) and rejects execution with `409 Conflict` and previous replay timestamp.
- **Action Required**: Verify previous replay outcome in dashboard rather than duplicating execution.
