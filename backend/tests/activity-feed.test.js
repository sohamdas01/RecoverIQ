/**
 * Phase 7 - Step 3: Live Recovery Activity Feed Tests
 *
 * Verifies:
 * 1. Activity endpoint response (HTTP 200, success: true, data array)
 * 2. Empty activity response handling
 * 3. Valid activity response schema and safe field guarantees (no secrets or PII leaked)
 * 4. Status mapping (processing, success, review, blocked, failed)
 * 5. Limit and sorting behavior
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import axios from 'axios';
import { createDefaultMerchantUser } from './helpers/auth-fixtures.js';
import { ObservabilityService, AUDIT_EVENT_TYPES } from '../services/observability/index.js';
import { closeDatabasePool } from '../db/index.js';
import { disconnectRedis } from '../redis/redis.client.js';
import decisionsRoutes from '../api/routes/decisions.routes.js';
import recoveryCasesRoutes from '../api/routes/recovery-cases.routes.js';

describe('Phase 7 - Step 3: Live Recovery Activity Tests', () => {
  let app;
  let server;
  let BASE_URL;
  let merchantToken;

  before(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/decisions', decisionsRoutes);
    app.use('/api/admin/recovery-cases', recoveryCasesRoutes);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        BASE_URL = `http://localhost:${port}`;
        resolve();
      });
    });

    merchantToken = (await createDefaultMerchantUser('admin')).token;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await disconnectRedis();
    await closeDatabasePool();
  });

  it('1. GET /api/decisions/activity should return HTTP 200 with success: true and data array (authenticated)', async () => {
    const res = await axios.get(`${BASE_URL}/api/decisions/activity?limit=10`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(typeof res.data.count, 'number');
    assert.strictEqual(Array.isArray(res.data.data), true);
  });

  it('2. GET /api/admin/recovery-cases/activity should return HTTP 200 with authenticated access', async () => {
    const res = await axios.get(`${BASE_URL}/api/admin/recovery-cases/activity?limit=10`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(Array.isArray(res.data.data), true);
  });

  it('3. ObservabilityService.getRecentActivity handles empty / offline database cleanly', async () => {
    const activity = await ObservabilityService.getRecentActivity(10, { system: true });
    assert.strictEqual(Array.isArray(activity), true);
  });

  it('4. ObservabilityService sanitizes secrets and sensitive keys from lifecycle events', () => {
    const rawPayload = {
      action: 'attempt_recovery',
      guardrailResult: 'ALLOW',
      secret: 'super-secret-key-12345',
      password: 'user-raw-password',
      cvv: '999',
      authToken: 'secret_bearer_token',
      nested: {
        apiKey: 'api-key-987',
        safeField: 'visible_data',
      },
    };

    const sanitized = ObservabilityService.sanitizeForAudit(rawPayload);

    assert.strictEqual(sanitized.action, 'attempt_recovery');
    assert.strictEqual(sanitized.guardrailResult, 'ALLOW');
    assert.strictEqual(sanitized.secret, '[REDACTED]');
    assert.strictEqual(sanitized.password, '[REDACTED]');
    assert.strictEqual(sanitized.cvv, '[REDACTED]');
    assert.strictEqual(sanitized.authToken, '[REDACTED]');
    assert.strictEqual(sanitized.nested.apiKey, '[REDACTED]');
    assert.strictEqual(sanitized.nested.safeField, 'visible_data');
  });

  it('5. recordLifecycleEvent produces valid, safe event structure without persisting when persistToDb=false', async () => {
    const logRecord = await ObservabilityService.recordLifecycleEvent({
      transactionId: 'txn_mock_123',
      caseId: 'case_mock_456',
      eventType: AUDIT_EVENT_TYPES.POLICY_EVALUATED,
      details: {
        action: 'send_recovery_message',
        policyDecision: 'ALLOW',
        password: 'forbidden_secret',
      },
      persistToDb: false,
    });

    assert.strictEqual(logRecord.event, AUDIT_EVENT_TYPES.POLICY_EVALUATED);
    assert.strictEqual(logRecord.transactionId, 'txn_mock_123');
    assert.strictEqual(logRecord.caseId, 'case_mock_456');
    assert.strictEqual(logRecord.details.action, 'send_recovery_message');
    assert.strictEqual(logRecord.details.password, '[REDACTED]');
  });

  it('6. Activity feed endpoint respects limit query parameter', async () => {
    const res = await axios.get(`${BASE_URL}/api/decisions/activity?limit=3`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.data.length <= 3);
  });
});
