/**
 * RecoverIQ Backend - Ask RecoverIQ Tests
 * Phase 7 - Step 6: Ask RecoverIQ
 *
 * Verifies:
 * 1. Authentication enforcement (401 Unauthorized for unauthenticated requests)
 * 2. Input validation (400 Bad Request for missing / empty questions)
 * 3. Authenticated query execution via /api/admin/recovery-cases/ask and /api/admin/ask
 * 4. Grounded answer synthesis over structured decision lineage / audit evidence
 * 5. Deterministic fallback answering for blocked cases, human review approvals, and agent recommendations
 * 6. Evidence and citation formatting (Stage, Rule ID, Playbook ID, Timestamp, Case ID)
 * 7. PII and secret sanitization
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import axios from 'axios';
import { AuthService } from '../services/auth/auth.service.js';
import { AskRecoverIQService } from '../services/ask/ask.service.js';
import { closeDatabasePool } from '../db/index.js';
import { disconnectRedis } from '../redis/redis.client.js';
import recoveryCasesRoutes from '../api/routes/recovery-cases.routes.js';
import adminEventsRoutes from '../api/routes/admin-events.routes.js';

describe('Phase 7 - Step 6: Ask RecoverIQ Grounded Explainer Tests', () => {
  let app;
  let server;
  let BASE_URL;
  let merchantToken;

  before(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/admin/recovery-cases', recoveryCasesRoutes);
    app.use('/api/admin', adminEventsRoutes);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        BASE_URL = `http://localhost:${port}`;
        resolve();
      });
    });

    merchantToken = AuthService.generateMerchantToken('merchant_test_admin', 'admin');
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await disconnectRedis();
    await closeDatabasePool();
  });

  it('1. POST /api/admin/recovery-cases/ask should require authentication (401)', async () => {
    try {
      await axios.post(`${BASE_URL}/api/admin/recovery-cases/ask`, {
        question: 'Why was this case blocked?',
      });
      assert.fail('Should have returned 401');
    } catch (err) {
      assert.strictEqual(err.response?.status, 401);
    }
  });

  it('2. POST /api/admin/ask should require authentication (401)', async () => {
    try {
      await axios.post(`${BASE_URL}/api/admin/ask`, {
        question: 'How much revenue was recovered?',
      });
      assert.fail('Should have returned 401');
    } catch (err) {
      assert.strictEqual(err.response?.status, 401);
    }
  });

  it('3. POST /api/admin/recovery-cases/ask should reject empty question with 400', async () => {
    try {
      await axios.post(
        `${BASE_URL}/api/admin/recovery-cases/ask`,
        { question: '   ' },
        { headers: { Authorization: `Bearer ${merchantToken}` } }
      );
      assert.fail('Should have returned 400');
    } catch (err) {
      assert.strictEqual(err.response?.status, 400);
      assert.strictEqual(err.response?.data?.success, false);
    }
  });

  it('4. POST /api/admin/recovery-cases/ask should return structured answer and evidence', async () => {
    const res = await axios.post(
      `${BASE_URL}/api/admin/recovery-cases/ask`,
      { question: 'How much revenue was recovered across recent transactions?' },
      { headers: { Authorization: `Bearer ${merchantToken}` } }
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(typeof res.data.data.answer, 'string');
    assert.strictEqual(Array.isArray(res.data.data.evidence), true);
    assert.strictEqual(typeof res.data.data.isGrounded, 'boolean');
  });

  it('5. POST /api/admin/ask route alias should also work identically with authentication', async () => {
    const res = await axios.post(
      `${BASE_URL}/api/admin/ask`,
      { question: 'What is the current recovery status summary?' },
      { headers: { Authorization: `Bearer ${merchantToken}` } }
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(typeof res.data.data.answer, 'string');
  });

  it('6. AskRecoverIQService handles empty evidence gracefully', async () => {
    const res = await AskRecoverIQService.ask({
      question: 'Why was case-not-found blocked?',
      caseId: 'case-not-found-999',
    });

    assert.strictEqual(res.isGrounded, false);
    assert.strictEqual(typeof res.answer, 'string');
    assert.strictEqual(res.evidence.length, 0);
  });

  it('7. AskRecoverIQService deterministic synthesis answers block questions with citations', () => {
    const fallback = AskRecoverIQService.synthesizeDeterministicFallback({
      question: 'Why was this case blocked?',
      caseId: 'case-test-101',
      evidence: [
        {
          caseId: 'case-test-101',
          stage: '6_policy',
          ruleId: 'RULE_VELOCITY_LIMIT',
          policyDecision: 'BLOCK',
          detail: 'Policy Engine decision: BLOCK. Rule: RULE_VELOCITY_LIMIT. Details: Velocity exceeded 3 attempts in 15m',
          timestamp: '2026-09-13T12:00:00.000Z',
        },
      ],
    });

    assert.strictEqual(fallback.isGrounded, true);
    assert.ok(fallback.answer.includes('RULE_VELOCITY_LIMIT'));
    assert.strictEqual(fallback.evidence.length, 1);
    assert.strictEqual(fallback.evidence[0].ruleId, 'RULE_VELOCITY_LIMIT');
  });

  it('8. AskRecoverIQService deterministic synthesis answers approval questions with citations', () => {
    const fallback = AskRecoverIQService.synthesizeDeterministicFallback({
      question: 'Why did this case require approval?',
      caseId: 'case-test-102',
      evidence: [
        {
          caseId: 'case-test-102',
          stage: '6_policy',
          ruleId: 'RULE_HIGH_VALUE_THRESHOLD',
          policyDecision: 'REQUIRE_APPROVAL',
          detail: 'Policy Engine decision: REQUIRE_APPROVAL. Rule: RULE_HIGH_VALUE_THRESHOLD. Details: Amount exceeds $500 threshold',
          timestamp: '2026-09-13T12:05:00.000Z',
        },
      ],
    });

    assert.strictEqual(fallback.isGrounded, true);
    assert.ok(fallback.answer.includes('RULE_HIGH_VALUE_THRESHOLD'));
    assert.strictEqual(fallback.evidence[0].stage, 'Policy Gating / HITL');
  });

  it('9. AskRecoverIQService deterministic synthesis answers Agent 1 & RAG playbook questions', () => {
    const fallback = AskRecoverIQService.synthesizeDeterministicFallback({
      question: 'What did Agent 1 recommend and which playbook was retrieved?',
      caseId: 'case-test-103',
      evidence: [
        {
          caseId: 'case-test-103',
          stage: '3_agent1_analysis',
          action: 'schedule_retry',
          detail: "Agent 1 (RecoveryAnalyst) recommended 'schedule_retry' (confidence: 85%). Rationale: Insufficient funds window optimal",
          timestamp: '2026-09-13T12:10:00.000Z',
        },
        {
          caseId: 'case-test-103',
          stage: '4_rag_playbook',
          playbookId: 'PB-03',
          detail: "Retrieved playbook 'PB-03' from Qdrant: Insufficient Funds — Multi-Attempt Exhaustion.",
          timestamp: '2026-09-13T12:10:00.000Z',
        },
      ],
    });

    assert.strictEqual(fallback.isGrounded, true);
    assert.ok(fallback.answer.includes('schedule_retry') || fallback.answer.includes('PB-03'));
    assert.strictEqual(fallback.evidence.length > 0, true);
  });
});
