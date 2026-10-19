import crypto from 'crypto';
import { db } from '../index.js';
import { merchants, merchantUsers } from '../../../drizzle/schema.js';
import { eq } from 'drizzle-orm';

export const MERCHANT_ROLES = ['viewer', 'reviewer', 'admin', 'platform_admin'];

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}

export async function createMerchant({ name, webhookSecret } = {}) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Merchant name is required');
  }
  const [merchant] = await db.insert(merchants).values({
    name: name.trim(),
    webhookSecret: webhookSecret || generateWebhookSecret(),
  }).returning();
  return merchant;
}

export async function getMerchantById(id) {
  const [merchant] = await db.select().from(merchants).where(eq(merchants.id, id)).limit(1);
  return merchant || null;
}

export async function setMerchantStatus(id, status) {
  const [updated] = await db.update(merchants).set({ status }).where(eq(merchants.id, id)).returning();
  return updated || null;
}

/**
 * Create a dashboard login. `passwordHash` must already be hashed (see services/auth/password.js).
 */
export async function createMerchantUser({ merchantId, email, passwordHash, role = 'viewer', status = 'active' }) {
  if (!MERCHANT_ROLES.includes(role)) {
    throw new Error(`Invalid role '${role}'. Allowed: ${MERCHANT_ROLES.join(', ')}`);
  }
  const [user] = await db.insert(merchantUsers).values({
    merchantId,
    email: normalizeEmail(email),
    passwordHash,
    role,
    status,
  }).returning();
  return user;
}

export async function setUserStatus(id, status) {
  const [updated] = await db.update(merchantUsers).set({ status }).where(eq(merchantUsers.id, id)).returning();
  return updated || null;
}

export async function setUserRole(id, role) {
  if (!MERCHANT_ROLES.includes(role)) {
    throw new Error(`Invalid role '${role}'. Allowed: ${MERCHANT_ROLES.join(', ')}`);
  }
  const [updated] = await db.update(merchantUsers).set({ role }).where(eq(merchantUsers.id, id)).returning();
  return updated || null;
}

export async function findUserWithMerchantByEmail(email) {
  const [row] = await db
    .select({ user: merchantUsers, merchant: merchants })
    .from(merchantUsers)
    .innerJoin(merchants, eq(merchantUsers.merchantId, merchants.id))
    .where(eq(merchantUsers.email, normalizeEmail(email)))
    .limit(1);
  return row || null;
}

/**
 * Authoritative identity lookup for every authenticated request: role/status come from the
 * database, never from the token, so disabling a user or merchant takes effect immediately.
 */
export async function findAuthContextByUserId(userId) {
  const [row] = await db
    .select({ user: merchantUsers, merchant: merchants })
    .from(merchantUsers)
    .innerJoin(merchants, eq(merchantUsers.merchantId, merchants.id))
    .where(eq(merchantUsers.id, userId))
    .limit(1);
  return row || null;
}

export async function recordSuccessfulLogin(userId) {
  await db.update(merchantUsers).set({ lastLoginAt: new Date() }).where(eq(merchantUsers.id, userId));
}
