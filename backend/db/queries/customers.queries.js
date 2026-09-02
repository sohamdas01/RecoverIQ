import { db } from '../index.js';
import { customers } from '../../../drizzle/schema.js';
import { eq } from 'drizzle-orm';

export async function findOrCreateCustomer(data) {
  const existing = await db.select().from(customers).where(eq(customers.email, data.email)).limit(1);
  if (existing.length > 0) {
    return existing[0];
  }
  const [created] = await db.insert(customers).values({
    name: data.name,
    email: data.email,
    phone: data.phone,
  }).returning();
  return created;
}

export async function getCustomerById(id) {
  const [customer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  return customer || null;
}
