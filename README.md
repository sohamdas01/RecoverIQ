# RecoverIQ — Autonomous Payment & Subscription Recovery Platform

RecoverIQ is an autonomous agentic platform that detects payment failures, diagnoses root causes, decides bounded recovery interventions, gates every action through a 3-way guardrail engine (`ALLOW` / `REQUIRE_APPROVAL` / `BLOCK`), and closes the recovery loop through a self-service customer recovery portal.

---

## 🏗️ Phase 1 Architecture Overview

```
[Simulate Purchase / Webhook Ingestion]
                   │
                   ▼
       [Decision Agent Layer]
         (Diagnosis & Tool)
                   │
                   ▼
     [Backend Guardrail Engine]
   ┌───────────────┼───────────────┐
   ▼               ▼               ▼
 (ALLOW)     (REQUIRE_APP)      (BLOCK)
   │               │               │
   ▼               ▼               ▼
[Execute MCP]  [Human Review]  [Log Blocked]
(Redis Lock)   (Merchant UI)
```

---

## 📦 Service Breakdown

- **`backend/`** (Node.js + Express + JavaScript):
  - Sole public entry point for all API requests
  - Owns PostgreSQL database access with Drizzle ORM
  - Owns Guardrail & Policy evaluation engine (Rule 3)
  - MCP Tool executors: `attempt_recovery`, `schedule_retry`, `send_recovery_message`, `escalate_to_human`, `log_outcome`
  - Redis distributed locking and rate limiting
- **`drizzle/`** (TypeScript):
  - Drizzle schema (`drizzle/schema.ts`) and migration configs for PostgreSQL
- **`frontend/`** (Next.js + Tailwind CSS):
  - `/simulate`: Demo trigger page to test real-time failure recovery loops
  - `/dashboard`: Merchant command center with live activity feed & Human-in-the-Loop review queue
  - `/recover/[token]`: Public, single-use tokenized Customer Recovery Page
- **`genai-service/`** (Python + FastAPI):
  - Decision agent recommending bounded MCP tool calls
- **`scripts/`**:
  - `synthetic-data/`: Batch failure event simulation script
  - `seed/`: Initial database reference data

---

## 🚀 Running Phase 1 Locally

### 1. Start Infrastructure (Docker Compose)
```bash
docker-compose up -d postgres redis
```

### 2. Run Backend API
```bash
cd backend
npm install
npm run dev
# Backend API runs on http://localhost:4000
```

### 3. Run Frontend UI
```bash
cd frontend
npm install
npm run dev
# Frontend runs on http://localhost:3000
```

### 4. Interactive Simulation & Verification
1. Open **`http://localhost:3000/simulate`** in your browser.
2. Select any quick preset (e.g. *Card Expired*, *Bank Outage*, *High Amount ₹75k*, or *Fraud Flag*).
3. Click **"Simulate Payment Failure"** to inspect the real-time diagnosis, guardrail decision, and tool execution.
4. For *Card Expired* scenarios, click **"Open Customer Recovery Page"** to test the customer-facing payment completion flow!
5. Navigate to **`http://localhost:3000/dashboard`** to view the live activity feed and manage the **Human-in-the-Loop Review Queue**.
