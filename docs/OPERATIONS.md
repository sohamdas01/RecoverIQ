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

## 2. Health Probes & Monitoring

### Standard Service Health Check
```bash
curl -s http://localhost:4000/health | jq .
```
Expected output:
```json
{
  "status": "healthy",
  "service": "recoveriq-backend",
  "version": "1.0.0",
  "timestamp": "2026-09-06T04:20:00.000Z",
  "kafka": {
    "status": "healthy",
    "topics": ["payment-events", "recovery-outcomes", "dead-letter-events"]
  }
}
```

### Dedicated Kafka Cluster Health Probe
```bash
curl -i http://localhost:4000/health/kafka
```
- Returns `HTTP 200` if connected to Kafka brokers with required topics active.
- Returns `HTTP 503` if Kafka broker is unavailable.

---

## 3. Dead-Letter Queue (DLQ) Management

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
