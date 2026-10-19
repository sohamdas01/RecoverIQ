import { db } from '../index.js';
import { customers, DEFAULT_MERCHANT_ID } from '../../../drizzle/schema.js';
import { and, eq } from 'drizzle-orm';

/**
 * Customers are scoped to a merchant: the same email under two merchants is two distinct rows.
 * Callers without a merchant (internal/legacy) fall back to the seeded default tenant.
 */
export async function findOrCreateCustomer(data) {
  const merchantId = data.merchantId || DEFAULT_MERCHANT_ID;
  const lookup = () => db
    .select()
    .from(customers)
    .where(and(eq(customers.merchantId, merchantId), eq(customers.email, data.email)))
    .limit(1);

  const [existing] = await lookup();
  if (existing) {
    return existing;
  }
  const [created] = await db.insert(customers).values({
    merchantId,
    name: data.name,
    email: data.email,
    phone: data.phone,
  }).onConflictDoNothing().returning();
  if (created) {
    return created;
  }
  // Lost a concurrent-insert race on (merchant_id, email): read the winner
  const [raced] = await lookup();
  return raced;
}

export async function getCustomerById(id) {
  const [customer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  return customer || null;
}
