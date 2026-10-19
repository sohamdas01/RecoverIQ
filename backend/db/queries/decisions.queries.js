import { db } from '../index.js';
import { decisions, transactions, customers } from '../../../drizzle/schema.js';
import { and, eq, desc } from 'drizzle-orm';

export async function createDecision(data) {
  const [decision] = await db.insert(decisions).values({
    transactionId: data.transactionId,
    agentAnalystResponse: data.agentAnalystResponse || {},
    mlScore: data.mlScore,
    recommendedAction: data.recommendedAction,
    guardrailResult: data.guardrailResult,
    finalAction: data.finalAction || data.recommendedAction,
    reasoning: data.reasoning,
    status: data.status || (data.guardrailResult === 'ALLOW' ? 'executed' : data.guardrailResult === 'REQUIRE_APPROVAL' ? 'pending_review' : 'blocked'),
  }).returning();
  return decision;
}

/**
 * @param {string} id
 * @param {{ merchantId?: string }} [scope] Restrict to one merchant's cases (cross-tenant ids read as "not found").
 */
export async function getDecisionById(id, { merchantId } = {}) {
  const [decision] = await db
    .select({
      decision: decisions,
      transaction: transactions,
      customer: customers,
    })
    .from(decisions)
    .innerJoin(transactions, eq(decisions.transactionId, transactions.id))
    .innerJoin(customers, eq(transactions.customerId, customers.id))
    .where(
      merchantId
        ? and(eq(decisions.id, id), eq(transactions.merchantId, merchantId))
        : eq(decisions.id, id)
    )
    .limit(1);
  return decision || null;
}

export async function getPendingReviewDecisions({ merchantId } = {}) {
  return db
    .select({
      decision: decisions,
      transaction: transactions,
      customer: customers,
    })
    .from(decisions)
    .innerJoin(transactions, eq(decisions.transactionId, transactions.id))
    .innerJoin(customers, eq(transactions.customerId, customers.id))
    .where(
      merchantId
        ? and(eq(decisions.status, 'pending_review'), eq(transactions.merchantId, merchantId))
        : eq(decisions.status, 'pending_review')
    )
    .orderBy(desc(decisions.createdAt));
}

export async function updateDecisionStatus(id, status, finalAction) {
  const [updated] = await db
    .update(decisions)
    .set({
      status,
      ...(finalAction ? { finalAction } : {}),
    })
    .where(eq(decisions.id, id))
    .returning();
  return updated;
}

export async function getRecentDecisions(limit = 50, { merchantId } = {}) {
  const query = db
    .select({
      decision: decisions,
      transaction: transactions,
      customer: customers,
    })
    .from(decisions)
    .innerJoin(transactions, eq(decisions.transactionId, transactions.id))
    .innerJoin(customers, eq(transactions.customerId, customers.id));

  return (merchantId ? query.where(eq(transactions.merchantId, merchantId)) : query)
    .orderBy(desc(decisions.createdAt))
    .limit(limit);
}
