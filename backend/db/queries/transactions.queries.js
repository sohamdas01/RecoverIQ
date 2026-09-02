import { db } from '../index.js';
import { transactions, customers } from '../../../drizzle/schema.js';
import { eq, desc } from 'drizzle-orm';

export async function createTransaction(data) {
  const [tx] = await db.insert(transactions).values({
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

export async function getTransactionById(id) {
  const [tx] = await db
    .select({
      transaction: transactions,
      customer: customers,
    })
    .from(transactions)
    .innerJoin(customers, eq(transactions.customerId, customers.id))
    .where(eq(transactions.id, id))
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

export async function getRecentTransactions(limit = 50) {
  return db
    .select({
      transaction: transactions,
      customer: customers,
    })
    .from(transactions)
    .innerJoin(customers, eq(transactions.customerId, customers.id))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
}
