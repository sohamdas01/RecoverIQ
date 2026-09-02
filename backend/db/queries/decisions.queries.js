import { db } from '../index.js';
import { decisions, transactions, customers } from '../../../drizzle/schema.js';
import { eq, desc } from 'drizzle-orm';

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

export async function getDecisionById(id) {
  const [decision] = await db
    .select({
      decision: decisions,
      transaction: transactions,
      customer: customers,
    })
    .from(decisions)
    .innerJoin(transactions, eq(decisions.transactionId, transactions.id))
    .innerJoin(customers, eq(transactions.customerId, customers.id))
    .where(eq(decisions.id, id))
    .limit(1);
  return decision || null;
}

export async function getPendingReviewDecisions() {
  return db
    .select({
      decision: decisions,
      transaction: transactions,
      customer: customers,
    })
    .from(decisions)
    .innerJoin(transactions, eq(decisions.transactionId, transactions.id))
    .innerJoin(customers, eq(transactions.customerId, customers.id))
    .where(eq(decisions.status, 'pending_review'))
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

export async function getRecentDecisions(limit = 50) {
  return db
    .select({
      decision: decisions,
      transaction: transactions,
      customer: customers,
    })
    .from(decisions)
    .innerJoin(transactions, eq(decisions.transactionId, transactions.id))
    .innerJoin(customers, eq(transactions.customerId, customers.id))
    .orderBy(desc(decisions.createdAt))
    .limit(limit);
}
