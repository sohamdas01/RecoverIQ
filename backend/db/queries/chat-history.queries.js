import { db } from '../index.js';
import { chatHistory } from '../../../drizzle/schema.js';
import { eq, desc } from 'drizzle-orm';

export async function addChatMessage(data) {
  const [msg] = await db.insert(chatHistory).values({
    sessionId: data.sessionId,
    role: data.role,
    content: data.content,
  }).returning();
  return msg;
}

export async function getChatHistoryBySession(sessionId, limit = 20) {
  const messages = await db
    .select()
    .from(chatHistory)
    .where(eq(chatHistory.sessionId, sessionId))
    .orderBy(desc(chatHistory.createdAt))
    .limit(limit);
  return messages.reverse();
}
