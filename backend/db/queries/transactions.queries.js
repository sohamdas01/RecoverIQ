import { db } from '../index.js';
import { transactions, customers, DEFAULT_MERCHANT_ID } from '../../../drizzle/schema.js';
import { and, eq, desc } from 'drizzle-orm';

export async function createTransaction(data) {
  const [tx] = await db.insert(transactions).values({
    merchantId: data.merchantId || DEFAULT_MERCHANT_ID,
    customerId: data.customerId,
    amount: Number(data.amount).toFixed(2),
    currency: data.currency || 'INR',
    paymentMethod: data.paymentMethod,
    status: data.status || 'failed',
    failureReason: data.failureReason,
    attemptCount: data.attemptCount || 1,
    metadata: data.metadata || {},
  }).returning();
  return tx;
}

/**
 * @param {string} id
 * @param {{ merchantId?: string }} [scope] When merchantId is given, only that merchant's
 *   transaction is visible (other tenants' rows read as "not found"). Omit for internal use.
 */
export async function getTransactionById(id, { merchantId } = {}) {
  const [tx] = await db
    .select({
      transaction: transactions,
      customer: customers,
    })
    .from(transactions)
    .innerJoin(customers, eq(transactions.customerId, customers.id))
    .where(
      merchantId
        ? and(eq(transactions.id, id), eq(transactions.merchantId, merchantId))
        : eq(transactions.id, id)
    )
    .limit(1);
  return tx || null;
}

export async function updateTransactionStatus(id, status, incrementAttempt = false) {
  const current = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
  if (!current.length) return null;

  const [updated] = await db
    .update(transactions)
    .set({
      status,
      attemptCount: incrementAttempt ? current[0].attemptCount + 1 : current[0].attemptCount,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, id))
    .returning();
  return updated;
}

export async function updateTransaction(id, updates) {
  const [updated] = await db
    .update(transactions)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, id))
    .returning();
  return updated;
}

export async function getRecentTransactions(limit = 50, { merchantId } = {}) {
  const query = db
    .select({
      transaction: transactions,
      customer: customers,
    })
    .from(transactions)
    .innerJoin(customers, eq(transactions.customerId, customers.id));

  return (merchantId ? query.where(eq(transactions.merchantId, merchantId)) : query)
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
}

export async function getCustomerStats(customerId) {
  const customerTxs = await db
    .select()
    .from(transactions)
    .where(eq(transactions.customerId, customerId));

  let previousSuccesses = 0;
  let previousFailures = 0;
  let previousRecoverySuccess = false;

  for (const tx of customerTxs) {
    if (tx.status === 'recovered' || tx.status === 'success') {
      previousSuccesses += 1;
      previousRecoverySuccess = true;
    } else if (tx.status === 'failed' || tx.status === 'abandoned') {
      previousFailures += 1;
    }
  }

  return {
    previousSuccesses,
    previousFailures,
    previousRecoverySuccess,
  };
}

