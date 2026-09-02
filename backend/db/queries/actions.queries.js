import { db } from '../index.js';
import { actions } from '../../../drizzle/schema.js';
import { eq, desc } from 'drizzle-orm';

export async function createAction(data) {
  const [act] = await db.insert(actions).values({
    decisionId: data.decisionId,
    toolName: data.toolName,
    toolParams: data.toolParams || {},
    status: data.status || 'pending',
    result: data.result || {},
  }).returning();
  return act;
}

export async function updateActionResult(id, status, result) {
  const [updated] = await db
    .update(actions)
    .set({
      status,
      result,
    })
    .where(eq(actions.id, id))
    .returning();
  return updated;
}

export async function getActionsByDecisionId(decisionId) {
  return db
    .select()
    .from(actions)
    .where(eq(actions.decisionId, decisionId))
    .orderBy(desc(actions.executedAt));
}
