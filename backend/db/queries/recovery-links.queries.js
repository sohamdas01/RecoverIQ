import { db } from '../index.js';
import { recoveryLinks, transactions, customers } from '../../../drizzle/schema.js';
import { eq, and, gt, isNull } from 'drizzle-orm';

export async function createRecoveryLink(data) {
  const [link] = await db.insert(recoveryLinks).values({
    transactionId: data.transactionId,
    token: data.token,
    expiresAt: data.expiresAt,
  }).returning();
  return link;
}

export async function getValidRecoveryLink(token) {
  const [result] = await db
    .select({
      recoveryLink: recoveryLinks,
      transaction: transactions,
      customer: customers,
    })
    .from(recoveryLinks)
    .innerJoin(transactions, eq(recoveryLinks.transactionId, transactions.id))
    .innerJoin(customers, eq(transactions.customerId, customers.id))
    .where(
      and(
        eq(recoveryLinks.token, token),
        isNull(recoveryLinks.usedAt),
        gt(recoveryLinks.expiresAt, new Date())
      )
    )
    .limit(1);
  return result || null;
}

export async function markRecoveryLinkUsed(token) {
  const [updated] = await db
    .update(recoveryLinks)
    .set({ usedAt: new Date() })
    .where(eq(recoveryLinks.token, token))
    .returning();
  return updated;
}
