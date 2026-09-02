import { db } from '../index.js';
import { overrides } from '../../../drizzle/schema.js';
import { eq, desc } from 'drizzle-orm';

export async function createOverride(data) {
  const [ovr] = await db.insert(overrides).values({
    decisionId: data.decisionId,
    merchantAction: data.merchantAction,
    merchantReasoning: data.merchantReasoning,
  }).returning();
  return ovr;
}

export async function getOverridesByDecisionId(decisionId) {
  return db
    .select()
    .from(overrides)
    .where(eq(overrides.decisionId, decisionId))
    .orderBy(desc(overrides.createdAt));
}
