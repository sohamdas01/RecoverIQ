/**
 * Phase 8 - Razorpay Webhook Authentication Tests
 *
 * The webhook used to accept any POST. It now requires a valid HMAC-SHA256 signature computed over
 * the raw body with the target merchant's own webhook secret, and attributes the event to that merchant.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import axios from 'axios';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.js';
import { db, closeDatabasePool } from '../db/index.js';
import { customers, transactions } from '../../drizzle/schema.js';
import { setMerchantStatus } from '../db/queries/merchants.queries.js';
import { verifyRazorpaySignature } from '../api/controllers/webhooks.controller.js';
import { disconnectRedis } from '../redis/redis.client.js';
import { checkKafkaHealth, disconnectKafka } from '../kafka/kafka.client.js';
import { createTestMerchant } from './helpers/auth-fixtures.js';

const uniq = () => crypto.randomBytes(4).toString('hex');
const sign = (raw, secret) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

describe('Phase 8 - Webhook Signature & Tenant Attribution', () => {
  let server;
  let http;
  let A;
  let B;
  let kafkaUp = false;

  const failedEvent = (email, paymentId = `pay_${uniq()}`) => ({
    id: `evt_${uniq()}`,
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: `order_${uniq()}`,
          amount: 250000, // paise -> INR 2500
          currency: 'INR',
          method: 'card',
          email,
          contact: '+919999999999',
          error_code: 'BAD_REQUEST_ERROR',
          error_reason: 'payment_failed_insufficient_funds',
          notes: { customer_name: 'Webhook Customer' },
        },
      },
    },
  });

  /** POST the raw JSON string exactly as signed. */
  const deliver = (merchantId, bodyObj, { secret, signature, rawOverride } = {}) => {
    const raw = rawOverride ?? JSON.stringify(bodyObj);
    const headers = { 'Content-Type': 'application/json' };
    const sig = signature !== undefined ? signature : (secret ? sign(raw, secret) : undefined);
    if (sig !== undefined) headers['X-Razorpay-Signature'] = sig;
    return http.post(`/api/webhooks/razorpay/${merchantId}`, raw, { headers });
  };

  const customerRowsFor = (email) => db.select().from(customers).where(eq(customers.email, email));

  before(async () => {
    const app = createApp();
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });
    A = await createTestMerchant('Webhook A');
    B = await createTestMerchant('Webhook B');
    try { kafkaUp = (await checkKafkaHealth()).status === 'healthy'; } catch { kafkaUp = false; }
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectKafka().catch(() => {});
    await disconnectRedis();
    await closeDatabasePool();
  });

  describe('A. Signature verification (nothing is processed unless it verifies)', () => {
    it('missing signature header -> 401 and nothing is persisted', async () => {
      const email = `nosig.${uniq()}@example.com`;
      const res = await deliver(A.id, failedEvent(email));
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.data.status, 'error');
      assert.strictEqual((await customerRowsFor(email)).length, 0);
    });

    it('wrong, truncated, non-hex or empty signatures -> 401', async () => {
      const email = `badsig.${uniq()}@example.com`;
      const body = failedEvent(email);
      const raw = JSON.stringify(body);
      const good = sign(raw, A.webhookSecret);
      const bad = [
        crypto.randomBytes(32).toString('hex'),
        good.slice(0, -2),
        `${good}00`,
        'zzzz-not-hex',
        '',
        good.toUpperCase(),
      ];
      for (const signature of bad) {
        const res = await deliver(A.id, body, { signature, rawOverride: raw });
        assert.strictEqual(res.status, 401, `signature "${signature.slice(0, 12)}..." must be rejected`);
      }
      assert.strictEqual((await customerRowsFor(email)).length, 0);
    });

    it('a body altered after signing is rejected', async () => {
      const email = `tamper.${uniq()}@example.com`;
      const original = failedEvent(email);
      const signature = sign(JSON.stringify(original), A.webhookSecret);
      const tampered = { ...original, payload: { payment: { entity: { ...original.payload.payment.entity, amount: 1 } } } };
      const res = await deliver(A.id, tampered, { signature });
      assert.strictEqual(res.status, 401);
      assert.strictEqual((await customerRowsFor(email)).length, 0);
    });

    it('secrets are per merchant: B\'s secret does not work on A\'s endpoint and vice versa', async () => {
      const email = `cross.${uniq()}@example.com`;
      const body = failedEvent(email);
      assert.strictEqual((await deliver(A.id, body, { secret: B.webhookSecret })).status, 401);
      assert.strictEqual((await deliver(B.id, body, { secret: A.webhookSecret })).status, 401);
      assert.strictEqual((await customerRowsFor(email)).length, 0);
    });

    it('an unknown merchant id is indistinguishable from a bad signature', async () => {
      const body = failedEvent(`unknown.${uniq()}@example.com`);
      const unknown = await deliver(crypto.randomUUID(), body, { secret: A.webhookSecret });
      const badSig = await deliver(A.id, body, { signature: 'f'.repeat(64) });
      assert.strictEqual(unknown.status, 401);
      assert.deepStrictEqual(unknown.data, badSig.data);
    });

    it('the old unscoped endpoint no longer exists', async () => {
      const body = failedEvent(`legacy.${uniq()}@example.com`);
      const res = await http.post('/api/webhooks/razorpay', JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sign(JSON.stringify(body), A.webhookSecret) },
      });
      assert.strictEqual(res.status, 404);
    });

    it('verifyRazorpaySignature handles degenerate input without throwing', () => {
      const raw = Buffer.from('{"a":1}');
      const secret = 's3cret';
      assert.strictEqual(verifyRazorpaySignature(raw, sign(raw, secret), secret), true);
      assert.strictEqual(verifyRazorpaySignature(raw, sign(raw, secret), 'other'), false);
      assert.strictEqual(verifyRazorpaySignature(undefined, 'x', secret), false);
      assert.strictEqual(verifyRazorpaySignature(raw, undefined, secret), false);
      assert.strictEqual(verifyRazorpaySignature(raw, 'x', undefined), false);
      assert.strictEqual(verifyRazorpaySignature(raw, 12345, secret), false);
      assert.strictEqual(verifyRazorpaySignature(raw, '', secret), false);
    });
  });

  describe('B. Verified events', () => {
    it('a validly signed event of an unhandled type is acknowledged and ignored (no Kafka needed)', async () => {
      const res = await deliver(A.id, { id: `evt_${uniq()}`, event: 'payment.captured', payload: {} }, { secret: A.webhookSecret });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'ignored');
    });

    it('a suspended merchant\'s validly signed events are refused (403)', async () => {
      const S = await createTestMerchant('Webhook Suspended');
      await setMerchantStatus(S.id, 'suspended');
      const email = `suspended.${uniq()}@example.com`;
      const res = await deliver(S.id, failedEvent(email), { secret: S.webhookSecret });
      assert.strictEqual(res.status, 403);
      assert.strictEqual((await customerRowsFor(email)).length, 0);
    });

    it('a validly signed payment.failed is accepted and owned by the signing merchant', async (t) => {
      const email = `owned.${uniq()}@example.com`;
      const res = await deliver(A.id, failedEvent(email), { secret: A.webhookSecret });
      if (!kafkaUp) {
        assert.notStrictEqual(res.status, 401, 'authentication must pass even if the broker is down');
        return t.skip('Kafka not available: acceptance path not asserted');
      }
      assert.strictEqual(res.status, 200, JSON.stringify(res.data));
      assert.strictEqual(res.data.processed, true);
      assert.strictEqual(res.data.result.transaction.merchantId, A.id);

      const rows = await customerRowsFor(email);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].merchantId, A.id);
      const txs = await db.select().from(transactions).where(eq(transactions.customerId, rows[0].id));
      assert.strictEqual(txs.length, 1);
      assert.strictEqual(txs[0].merchantId, A.id);
      assert.strictEqual(Number(txs[0].amount), 2500);
    });

    it('redelivery of the same payment is deduplicated per merchant, and another merchant\'s identical id is independent', async (t) => {
      if (!kafkaUp) return t.skip('Kafka not available');
      const paymentId = `pay_dup_${uniq()}`;
      const email = `dup.${uniq()}@example.com`;
      const first = await deliver(A.id, failedEvent(email, paymentId), { secret: A.webhookSecret });
      const second = await deliver(A.id, failedEvent(email, paymentId), { secret: A.webhookSecret });
      const otherTenant = await deliver(B.id, failedEvent(email, paymentId), { secret: B.webhookSecret });
      assert.strictEqual(first.data.result.status, 'queued');
      assert.strictEqual(second.data.result.status, 'duplicate');
      assert.strictEqual(otherTenant.data.result.status, 'queued', 'tenant B must not be blocked by tenant A\'s payment id');

      const rows = await customerRowsFor(email);
      assert.strictEqual(rows.length, 2, 'one customer row per merchant');
      assert.deepStrictEqual(new Set(rows.map((r) => r.merchantId)), new Set([A.id, B.id]));
    });
  });
});
