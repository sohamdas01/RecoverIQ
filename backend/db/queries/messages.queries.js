import { db } from '../index.js';
import { messages, transactions } from '../../../drizzle/schema.js';
import { eq, desc, getTableColumns } from 'drizzle-orm';

export async function createMessage(data) {
  const [msg] = await db.insert(messages).values({
    transactionId: data.transactionId,
    eventTaken: data.eventTaken,
    channel: data.channel || 'email',
    details: data.details || {},
  }).returning();
  return msg;
}

export async function getMessagesByTransactionId(transactionId) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.transactionId, transactionId))
    .orderBy(desc(messages.createdAt));
}

export async function getRecentMessages(limit = 50, { merchantId } = {}) {
  if (merchantId) {
    // Messages carry no tenant column: ownership comes from the parent transaction
    return db
      .select(getTableColumns(messages))
      .from(messages)
      .innerJoin(transactions, eq(messages.transactionId, transactions.id))
      .where(eq(transactions.merchantId, merchantId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
  }
  return db
    .select()
    .from(messages)
    .orderBy(desc(messages.createdAt))
    .limit(limit);
}
