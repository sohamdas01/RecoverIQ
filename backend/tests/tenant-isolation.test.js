/**
 * Phase 8 - Cross-Merchant Data Isolation Tests
 *
 * Two merchants (A and B) with real users, real cases created through the real recovery pipeline,
 * and a customer email deliberately shared between them. Verifies — over HTTP and at the service
 * layer — that one merchant can never read, act on, or influence the other's data.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import axios from 'axios';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.js';
import { db, closeDatabasePool } from '../db/index.js';
import { customers, transactions, overrides, actions } from '../../drizzle/schema.js';
import { findOrCreateCustomer } from '../db/queries/customers.queries.js';
import { createTransaction, getTransactionById, getRecentTransactions } from '../db/queries/transactions.queries.js';
import { getDecisionById, getRecentDecisions, getPendingReviewDecisions } from '../db/queries/decisions.queries.js';
import { getRecentMessages } from '../db/queries/messages.queries.js';
import { RecoveryOrchestrator } from '../services/recovery/index.js';
import { ReviewService } from '../services/review/index.js';
import { ObservabilityService } from '../services/observability/index.js';
import { AskRecoverIQService } from '../services/ask/ask.service.js';
import { EventProducerService } from '../services/ingestion/event-producer.service.js';
import { resolveScope, TenantScopeError } from '../services/auth/tenant-scope.js';
import { disconnectRedis } from '../redis/redis.client.js';
import { checkKafkaHealth, disconnectKafka } from '../kafka/kafka.client.js';
import { stopRecoveryConsumer } from '../kafka/consumers/recovery.consumer.js';
import { stopOutcomeConsumer } from '../kafka/consumers/outcome.consumer.js';
import { createTestMerchant, createTestUser, bearer } from './helpers/auth-fixtures.js';

const uniq = () => crypto.randomBytes(4).toString('hex');
const SHARED_EMAIL = `shared.customer.${uniq()}@example.com`;

describe('Phase 8 - Cross-Merchant Isolation', () => {
  let server;
  let http;
  let kafkaUp = false;

  const tenant = {}; // { A: {...}, B: {...} }

  async function seedTenant(label) {
    const merchant = await createTestMerchant(`Tenant ${label}`);
    const admin = await createTestUser({ merchantId: merchant.id, role: 'admin' });
    const reviewer = await createTestUser({ merchantId: merchant.id, role: 'reviewer' });
    const customer = await findOrCreateCustomer({
      merchantId: merchant.id,
      name: `Customer of ${label} ${uniq()}`,
      email: SHARED_EMAIL, // same email in BOTH tenants
    });

    const make = async (amount, failureReason) => {
      const transaction = await createTransaction({
        merchantId: merchant.id,
        customerId: customer.id,
        amount,
        currency: 'INR',
        paymentMethod: 'card',
        status: 'failed',
        failureReason,
        attemptCount: 1,
      });
      const result = await RecoveryOrchestrator.orchestrateRecovery({ transaction, customer });
      return { transaction, decision: result.decision };
    };

    const pending = await make(75000, 'insufficient_funds'); // REQUIRE_APPROVAL
    const pendingTwo = await make(76000, 'insufficient_funds'); // second pending case for write tests
    const allowed = await make(1500, 'card_expired'); // ALLOW

    return { label, merchant, admin, reviewer, customer, pending, pendingTwo, allowed };
  }

  before(async () => {
    const app = createApp();
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });
    try { kafkaUp = (await checkKafkaHealth()).status === 'healthy'; } catch { kafkaUp = false; }

    tenant.A = await seedTenant('A');
    tenant.B = await seedTenant('B');
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await stopRecoveryConsumer().catch(() => {});
    await stopOutcomeConsumer().catch(() => {});
    await disconnectKafka().catch(() => {});
    await disconnectRedis();
    await closeDatabasePool();
  });

  const ids = (t) => [t.pending, t.pendingTwo, t.allowed];
  const caseIds = (t) => ids(t).map((x) => x.decision.id);
  const txIds = (t) => ids(t).map((x) => x.transaction.id);
  const rowsOf = (res) => res.data.data;

  // ---------------------------------------------------------------------------
  describe('A. Data model', () => {
    it('the same customer email under two merchants is two separate customer rows', () => {
      const { A, B } = tenant;
      assert.notStrictEqual(A.customer.id, B.customer.id);
      assert.strictEqual(A.customer.email, B.customer.email);
      assert.strictEqual(A.customer.merchantId, A.merchant.id);
      assert.strictEqual(B.customer.merchantId, B.merchant.id);
    });

    it('findOrCreateCustomer is idempotent within a merchant and never crosses merchants', async () => {
      const again = await findOrCreateCustomer({ merchantId: tenant.A.merchant.id, name: 'ignored', email: SHARED_EMAIL });
      assert.strictEqual(again.id, tenant.A.customer.id);
      const other = await findOrCreateCustomer({ merchantId: tenant.B.merchant.id, name: 'ignored', email: SHARED_EMAIL });
      assert.strictEqual(other.id, tenant.B.customer.id);
    });

    it('every row created for a merchant is stamped with that merchant', async () => {
      for (const t of [tenant.A, tenant.B]) {
        for (const x of ids(t)) {
          assert.strictEqual(x.transaction.merchantId, t.merchant.id);
        }
      }
    });

    it('the database refuses a transaction or customer with no owning merchant', async () => {
      await assert.rejects(
        () => db.insert(customers).values({ name: 'orphan', email: `orphan.${uniq()}@x.example` }),
        /merchant_id/
      );
      await assert.rejects(
        () => db.insert(transactions).values({ customerId: tenant.A.customer.id, amount: '1.00', paymentMethod: 'card', failureReason: 'card_expired' }),
        /merchant_id/
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('B. Reads are scoped to the caller\'s merchant', () => {
    for (const [me, other] of [['A', 'B'], ['B', 'A']]) {
      it(`${me} sees only its own decisions, pending queue, transactions and activity`, async () => {
        const mine = tenant[me];
        const theirs = tenant[other];
        const headers = bearer(mine.admin.token);

        const decisions = await http.get('/api/decisions?limit=200', { headers });
        assert.strictEqual(decisions.status, 200);
        const decisionIds = rowsOf(decisions).map((r) => r.decision.id);
        for (const id of caseIds(mine)) assert.ok(decisionIds.includes(id), 'own case present');
        for (const id of caseIds(theirs)) assert.ok(!decisionIds.includes(id), 'other tenant case must be absent');
        assert.ok(rowsOf(decisions).every((r) => r.transaction.merchantId === mine.merchant.id));
        assert.ok(rowsOf(decisions).every((r) => r.customer.merchantId === mine.merchant.id));

        const pending = await http.get('/api/decisions?pending=true', { headers });
        const pendingIds = rowsOf(pending).map((r) => r.decision.id);
        assert.ok(pendingIds.includes(mine.pending.decision.id));
        assert.ok(!pendingIds.includes(theirs.pending.decision.id));
        assert.ok(rowsOf(pending).every((r) => r.transaction.merchantId === mine.merchant.id));

        const txs = await http.get('/api/transactions?limit=200', { headers });
        const txnIds = rowsOf(txs).map((r) => r.transaction.id);
        for (const id of txIds(mine)) assert.ok(txnIds.includes(id));
        for (const id of txIds(theirs)) assert.ok(!txnIds.includes(id));

        for (const path of ['/api/decisions/activity?limit=200', '/api/admin/recovery-cases/activity?limit=200']) {
          const activity = await http.get(path, { headers });
          assert.strictEqual(activity.status, 200);
          const feedCaseIds = new Set(rowsOf(activity).map((e) => e.caseId));
          const feedTxIds = new Set(rowsOf(activity).map((e) => e.transactionId));
          for (const id of caseIds(theirs)) assert.ok(!feedCaseIds.has(id), `${path}: leaked other tenant case`);
          for (const id of txIds(theirs)) assert.ok(!feedTxIds.has(id), `${path}: leaked other tenant transaction`);
          assert.ok(feedCaseIds.has(mine.pending.decision.id), `${path}: own case missing from feed`);
        }
      });
    }

    it('direct lookups of another merchant\'s ids read as "not found" (no existence leak)', async () => {
      const { A, B } = tenant;
      const headers = bearer(A.admin.token);
      const foreignCase = B.pending.decision.id;
      const foreignTx = B.pending.transaction.id;

      const attempts = [
        http.get(`/api/decisions/${foreignCase}`, { headers }),
        http.get(`/api/transactions/${foreignTx}`, { headers }),
        http.get(`/api/admin/recovery-cases/${foreignCase}/review`, { headers }),
        http.get(`/api/admin/recovery-cases/${foreignCase}/explanation`, { headers }),
      ];
      for (const res of await Promise.all(attempts)) {
        assert.strictEqual(res.status, 404);
        const body = JSON.stringify(res.data);
        assert.ok(!body.includes(B.customer.name) && !body.includes(foreignTx), 'response must not echo foreign data');
      }

      // and a genuinely nonexistent id behaves identically (indistinguishable)
      const missing = await http.get(`/api/decisions/${crypto.randomUUID()}`, { headers });
      const foreign = await http.get(`/api/decisions/${foreignCase}`, { headers });
      assert.strictEqual(missing.status, foreign.status);
      assert.deepStrictEqual(missing.data, foreign.data);
    });

    it('the owner can read its own case in full', async () => {
      const { A } = tenant;
      const headers = bearer(A.reviewer.token);
      const decision = await http.get(`/api/decisions/${A.pending.decision.id}`, { headers });
      assert.strictEqual(decision.status, 200);
      assert.strictEqual(decision.data.data.transaction.merchantId, A.merchant.id);
      const explanation = await http.get(`/api/admin/recovery-cases/${A.pending.decision.id}/explanation`, { headers });
      assert.strictEqual(explanation.status, 200);
      assert.strictEqual(explanation.data.data.caseId, A.pending.decision.id);
      const tx = await http.get(`/api/transactions/${A.pending.transaction.id}`, { headers });
      assert.strictEqual(tx.status, 200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('C. Writes cannot cross merchants', () => {
    it('A cannot approve / reject / modify B\'s pending case through any route; B\'s case is unchanged', async () => {
      const { A, B } = tenant;
      const target = B.pending.decision.id;
      const headers = bearer(A.admin.token);

      const results = await Promise.all([
        http.post(`/api/admin/recovery-cases/${target}/approve`, { reasoning: 'cross-tenant attempt' }, { headers }),
        http.post(`/api/admin/recovery-cases/${target}/reject`, { reasoning: 'cross-tenant attempt' }, { headers }),
        http.post(`/api/admin/recovery-cases/${target}/modify`, { modifiedAction: 'send_recovery_message', reasoning: 'cross-tenant attempt' }, { headers }),
        http.post(`/api/decisions/${target}/review`, { reviewAction: 'approve', merchantReasoning: 'cross-tenant attempt' }, { headers }),
        http.post(`/api/decisions/${target}/review`, { reviewAction: 'reject', merchantReasoning: 'cross-tenant attempt' }, { headers }),
      ]);
      for (const res of results) {
        assert.strictEqual(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.data)}`);
      }

      const after = await getDecisionById(target, { merchantId: B.merchant.id });
      assert.strictEqual(after.decision.status, 'pending_review', 'B\'s case must remain pending');
      const ovr = await db.select().from(overrides).where(eq(overrides.decisionId, target));
      assert.strictEqual(ovr.length, 0, 'no override/audit rows may be created by the foreign attempt');
      const acts = await db.select().from(actions).where(eq(actions.decisionId, target));
      assert.strictEqual(acts.length, 0, 'no tool may be executed by the foreign attempt');
      const txn = await getTransactionById(B.pending.transaction.id, { merchantId: B.merchant.id });
      assert.strictEqual(txn.transaction.status, 'failed');
    });

    it('a foreign attempt does not take the review lock, so the real owner is not blocked', async () => {
      const { A, B } = tenant;
      // A hammers B's case id concurrently; B must still be able to act immediately afterwards.
      await Promise.all(Array.from({ length: 5 }, () =>
        http.post(`/api/admin/recovery-cases/${B.pendingTwo.decision.id}/approve`, {}, { headers: bearer(A.admin.token) })));
      const ownerReject = await http.post(`/api/admin/recovery-cases/${B.pendingTwo.decision.id}/reject`, { reasoning: 'owner decision' }, { headers: bearer(B.reviewer.token) });
      assert.strictEqual(ownerReject.status, 200, `owner blocked? ${JSON.stringify(ownerReject.data)}`);
      assert.strictEqual(ownerReject.data.success, true);
    });

    it('the owner can still review its own case; the audit row records the acting user', async () => {
      const { A } = tenant;
      const res = await http.post(`/api/admin/recovery-cases/${A.pending.decision.id}/approve`, { reasoning: 'owner approval' }, { headers: bearer(A.reviewer.token) });
      assert.strictEqual(res.status, 200, JSON.stringify(res.data));
      assert.strictEqual(res.data.success, true);
      const rows = await db.select().from(overrides).where(eq(overrides.decisionId, A.pending.decision.id));
      assert.strictEqual(rows.length, 1);
      const after = await getDecisionById(A.pending.decision.id, { merchantId: A.merchant.id });
      assert.notStrictEqual(after.decision.status, 'pending_review');
    });

    it('legacy review route is tenant-scoped for the owner too', async () => {
      const { A } = tenant;
      const res = await http.post(`/api/decisions/${A.pendingTwo.decision.id}/review`, { reviewAction: 'reject', merchantReasoning: 'owner via legacy route' }, { headers: bearer(A.reviewer.token) });
      assert.strictEqual(res.status, 200, JSON.stringify(res.data));
    });
  });

  // ---------------------------------------------------------------------------
  describe('D. Ask RecoverIQ is grounded only in the caller\'s data', () => {
    it('asking about another merchant\'s case yields no evidence and no foreign data', async () => {
      const { A, B } = tenant;
      const res = await http.post('/api/admin/recovery-cases/ask',
        { question: 'Why was this case blocked or sent for approval?', caseId: B.pending.decision.id },
        { headers: bearer(A.admin.token) });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.data.isGrounded, false);
      assert.deepStrictEqual(res.data.data.evidence, []);
      const body = JSON.stringify(res.data);
      assert.ok(!body.includes(B.customer.name) && !body.includes(B.pending.transaction.id));
    });

    it('aggregate answers are computed from the caller\'s cases only', async () => {
      const { A, B } = tenant;
      const askAgg = async (t) => {
        const res = await http.post('/api/admin/recovery-cases/ask', { question: 'How much revenue was recovered?' }, { headers: bearer(t.admin.token) });
        assert.strictEqual(res.status, 200);
        return JSON.stringify(res.data);
      };
      const a = await askAgg(A);
      const b = await askAgg(B);
      // each tenant has exactly 3 cases, so each aggregate must say "3 cases evaluated", never a combined count
      assert.match(a, /3 cases evaluated/);
      assert.match(b, /3 cases evaluated/);
      assert.ok(!a.includes(B.customer.name) && !b.includes(A.customer.name));
    });

    it('asking about its own case works', async () => {
      const { A } = tenant;
      const res = await http.post('/api/admin/recovery-cases/ask', { question: 'Which playbook was retrieved?', caseId: A.allowed.decision.id }, { headers: bearer(A.admin.token) });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.data.isGrounded, true);
      assert.ok(res.data.data.evidence.length > 0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('E. Service and query layers fail closed', () => {
    it('resolveScope requires a tenant or an explicit system opt-in; a named tenant always wins', () => {
      assert.throws(() => resolveScope({}), TenantScopeError);
      assert.throws(() => resolveScope({ merchantId: '' }), TenantScopeError);
      assert.throws(() => resolveScope({ merchantId: '   ' }), TenantScopeError);
      assert.throws(() => resolveScope({ system: false }), TenantScopeError);
      assert.deepStrictEqual(resolveScope({ system: true }), {});
      assert.deepStrictEqual(resolveScope({ merchantId: 'm1' }), { merchantId: 'm1' });
      assert.deepStrictEqual(resolveScope({ merchantId: 'm1', system: true }), { merchantId: 'm1' });
    });

    it('merchant-facing services refuse to run without a tenant', async () => {
      const id = tenant.A.allowed.decision.id;
      await assert.rejects(() => ReviewService.approveCase(id), (e) => e.code === 'MERCHANT_SCOPE_REQUIRED');
      await assert.rejects(() => ReviewService.rejectCase(id, { reviewerId: 'x' }), (e) => e.code === 'MERCHANT_SCOPE_REQUIRED');
      await assert.rejects(() => ReviewService.modifyCase(id, { reviewerId: 'x' }), (e) => e.code === 'MERCHANT_SCOPE_REQUIRED');
      await assert.rejects(() => ReviewService.getCaseForReview(id), (e) => e.code === 'MERCHANT_SCOPE_REQUIRED');
      await assert.rejects(() => ObservabilityService.getRecentActivity(10), (e) => e.code === 'MERCHANT_SCOPE_REQUIRED');
      await assert.rejects(() => ObservabilityService.getRecentDecisions(10), (e) => e.code === 'MERCHANT_SCOPE_REQUIRED');
      await assert.rejects(() => ObservabilityService.getDecisionExplanation(id), (e) => e.code === 'MERCHANT_SCOPE_REQUIRED');
      await assert.rejects(() => AskRecoverIQService.ask({ question: 'anything' }), (e) => e.code === 'MERCHANT_SCOPE_REQUIRED');
    });

    it('scoped queries hide other tenants; unscoped (internal) queries still see everything', async () => {
      const { A, B } = tenant;
      assert.strictEqual(await getDecisionById(B.pending.decision.id, { merchantId: A.merchant.id }), null);
      assert.ok(await getDecisionById(B.pending.decision.id, { merchantId: B.merchant.id }));
      assert.ok(await getDecisionById(B.pending.decision.id), 'internal callers (workers) are unscoped');

      assert.strictEqual(await getTransactionById(B.pending.transaction.id, { merchantId: A.merchant.id }), null);

      const aTx = await getRecentTransactions(500, { merchantId: A.merchant.id });
      assert.ok(aTx.every((r) => r.transaction.merchantId === A.merchant.id));
      const aDec = await getRecentDecisions(500, { merchantId: A.merchant.id });
      assert.ok(aDec.every((r) => r.transaction.merchantId === A.merchant.id));
      const aPending = await getPendingReviewDecisions({ merchantId: A.merchant.id });
      assert.ok(aPending.every((r) => r.transaction.merchantId === A.merchant.id));
      const aMsgs = await getRecentMessages(500, { merchantId: A.merchant.id });
      const aTxIds = new Set(txIds(A));
      const bTxIds = new Set(txIds(B));
      assert.ok(aMsgs.every((m) => !bTxIds.has(m.transactionId)), 'activity messages must not include the other tenant');
      assert.ok(aMsgs.some((m) => aTxIds.has(m.transactionId)));
    });
  });

  // ---------------------------------------------------------------------------
  describe('F. Ingestion keeps tenants apart', () => {
    it('idempotency keys are namespaced per merchant (one tenant cannot suppress another\'s event)', async (t) => {
      if (!kafkaUp) return t.skip('Kafka not available');
      const key = `pay_shared_${uniq()}`;
      const base = (merchantId) => ({
        merchantId,
        customer: { name: 'Idem Customer', email: `idem.${uniq()}@example.com` },
        amount: 2100,
        paymentMethod: 'upi',
        failureReason: 'bank_outage',
        idempotencyKey: key,
      });
      const a1 = await EventProducerService.ingestAndPublishPaymentFailure(base(tenant.A.merchant.id));
      const b1 = await EventProducerService.ingestAndPublishPaymentFailure(base(tenant.B.merchant.id));
      const a2 = await EventProducerService.ingestAndPublishPaymentFailure(base(tenant.A.merchant.id));
      assert.strictEqual(a1.status, 'queued');
      assert.strictEqual(b1.status, 'queued', 'B must not be treated as a duplicate of A\'s event');
      assert.strictEqual(a2.status, 'duplicate', 'same merchant + same key is still deduplicated');
      assert.strictEqual(a1.transaction.merchantId, tenant.A.merchant.id);
      assert.strictEqual(b1.transaction.merchantId, tenant.B.merchant.id);
    });
  });
});
