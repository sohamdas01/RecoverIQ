import { db } from '../index.js';
import { messages } from '../../../drizzle/schema.js';
import { eq, desc } from 'drizzle-orm';

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
