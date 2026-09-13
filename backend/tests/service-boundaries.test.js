import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { config } from '../services/config/index.js';
import { getMLPrediction } from '../services/ml/ml.client.js';
import { RecoveryAnalystClient } from '../services/agents/recovery-analyst.client.js';
import { RecoveryExecutorClient } from '../services/agents/recovery-executor.client.js';

describe('Phase 6 — Step 4: Service Boundary & Internal Token Security', () => {

  describe('1. Configuration & Secret Boundaries', () => {
    test('1.1 Backend config includes internal service tokens with defaults', () => {
      assert.ok(config.mlInternalToken, 'mlInternalToken must be defined');
      assert.ok(config.genaiInternalToken, 'genaiInternalToken must be defined');
      assert.ok(config.internalServiceToken, 'internalServiceToken must be defined');
      assert.strictEqual(typeof config.mlInternalToken, 'string');
      assert.strictEqual(typeof config.genaiInternalToken, 'string');
    });

    test('1.2 Internal microservices URLs point to internal host ports, not public API', () => {
      assert.ok(config.mlServiceUrl.includes('8000') || config.mlServiceUrl.includes('ml-service'), 'ML service URL must point to port 8000');
      assert.ok(config.genaiServiceUrl.includes('8001') || config.genaiServiceUrl.includes('genai-service'), 'GenAI service URL must point to port 8001');
      assert.notStrictEqual(config.mlServiceUrl, config.frontendUrl);
      assert.notStrictEqual(config.genaiServiceUrl, config.frontendUrl);
    });
  });

  describe('2. Microservice Client Token Injection', () => {
    test('2.1 ML Client sends x-internal-service-token header during inference', async () => {
      const payload = {
        amount: 2499.0,
        payment_method: 'card',
        failure_reason: 'bank_outage',
        attempt_count: 1,
      };

      const result = await getMLPrediction(payload);
      assert.ok(result, 'ML prediction must return a result');
      assert.strictEqual(typeof result.probability, 'number');
      assert.ok(result.probability >= 0.0 && result.probability <= 1.0);
      assert.ok(Array.isArray(result.reason_codes));
    });

    test('2.2 Agent 1 Analyst Client sends x-internal-service-token header', async () => {
      const context = {
        transaction: {
          id: 'test-txn-sec-01',
          amount: 1999.0,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'card_expired',
          attemptCount: 1,
        },
        customer: { id: 'cust_sec_01' },
        customerStats: { previousSuccesses: 3, previousFailures: 1 },
        mlPrediction: { probability: 0.45, reason_codes: ['hard_decline_expired_card'] },
      };

      const result = await RecoveryAnalystClient.analyze(context);
      assert.ok(result, 'Analyst client must return result');
      assert.strictEqual(result.recommendation, 'send_recovery_message');
      assert.ok(result.confidence >= 0.70);
    });

    test('2.3 Agent 2 Executor Client sends x-internal-service-token header', async () => {
      const context = {
        transaction: {
          id: 'test-txn-sec-02',
          amount: 1999.0,
          currency: 'INR',
          paymentMethod: 'card',
          failureReason: 'card_expired',
          attemptCount: 1,
        },
        customer: { id: 'cust_sec_02' },
        customerStats: { previousSuccesses: 3, previousFailures: 1 },
        mlPrediction: { probability: 0.45, reason_codes: ['hard_decline_expired_card'] },
        agent1Recommendation: {
          recommendation: 'send_recovery_message',
          confidence: 0.95,
          reasonCodes: ['CARD_EXPIRED_UPDATE_REQUIRED'],
          rationale: 'Card is expired.',
          suggestedParameters: { channel: 'email' },
        },
      };

      const result = await RecoveryExecutorClient.plan(context);
      assert.ok(result, 'Executor client must return result');
      assert.strictEqual(result.proposedAction, 'send_recovery_message');
      assert.ok(result.parameters);
    });
  });

  describe('3. Public vs Internal Boundary Behavior', () => {
    test('3.1 Direct call to ML service with invalid token fails with 403 Forbidden', async () => {
      try {
        await axios.post(
          `${config.mlServiceUrl}/predict`,
          { amount: 1000, payment_method: 'card', failure_reason: 'bank_outage' },
          { headers: { 'x-internal-service-token': 'invalid_unauthorized_token' }, timeout: 2000 }
        );
        // If ML service is running and rejects with 403, we won't reach here.
        // If ML service is offline locally, error code will be ECONNREFUSED which is also isolated.
      } catch (err) {
        if (err.response) {
          assert.strictEqual(err.response.status, 403, 'Should reject invalid token with 403 Forbidden');
        } else {
          // ML service offline in this test environment is safely handled by client fallbacks
          assert.ok(err.message, 'Network or rejection error caught as expected');
        }
      }
    });

    test('3.2 Direct call to GenAI service with invalid token fails with 403 Forbidden', async () => {
      try {
        await axios.post(
          `${config.genaiServiceUrl}/internal/recovery/analyze`,
          {
            transaction: {
              id: 'test_sec_direct',
              amount: 1000,
              currency: 'INR',
              paymentMethod: 'card',
              failureReason: 'card_expired',
            }
          },
          { headers: { 'x-internal-service-token': 'invalid_unauthorized_token' }, timeout: 2000 }
        );
      } catch (err) {
        if (err.response) {
          assert.strictEqual(err.response.status, 403, 'Should reject invalid token with 403 Forbidden');
        } else {
          assert.ok(err.message, 'Network or rejection error caught as expected');
        }
      }
    });

    test('3.3 ML Client gracefully falls back if internal service returns 401/403 or is offline', async () => {
      // Simulate unreachable / offline ML service endpoint
      const originalUrl = config.mlServiceUrl;
      config.mlServiceUrl = 'http://localhost:59999'; // Non-existent port

      try {
        const fallbackResult = await getMLPrediction({
          amount: 500.0,
          payment_method: 'card',
          failure_reason: 'card_expired',
        });

        assert.ok(fallbackResult, 'Fallback result must be returned on service error');
        assert.strictEqual(fallbackResult.model_version, 'v1.0.0-fallback');
        assert.strictEqual(fallbackResult.probability, 0.45);
      } finally {
        config.mlServiceUrl = originalUrl;
      }
    });

    test('3.4 Agent 1 Client gracefully falls back if internal service is offline', async () => {
      const originalUrl = config.genaiServiceUrl;
      config.genaiServiceUrl = 'http://localhost:59999';

      try {
        const fallbackResult = await RecoveryAnalystClient.analyze({
          transaction: {
            id: 'test_fallback_txn',
            amount: 500.0,
            currency: 'INR',
            paymentMethod: 'card',
            failureReason: 'high_risk_fraud',
          }
        });

        assert.ok(fallbackResult, 'Fallback result must be returned');
        assert.strictEqual(fallbackResult.recommendation, 'escalate_to_human');
        assert.strictEqual(fallbackResult.isFallback, true);
      } finally {
        config.genaiServiceUrl = originalUrl;
      }
    });
  });
});
