/**
 * Test fixtures for merchant authentication / tenancy.
 * Creates REAL merchants and users in the test database and issues real tokens, so tests exercise
 * the same DB-backed authentication the API uses in production.
 */
import crypto from 'crypto';
import { createMerchant, createMerchantUser } from '../../db/queries/merchants.queries.js';
import { hashPassword } from '../../services/auth/password.js';
import { AuthService } from '../../services/auth/auth.service.js';
import { DEFAULT_MERCHANT_ID } from '../../../drizzle/schema.js';

export { DEFAULT_MERCHANT_ID };
export const TEST_PASSWORD = 'correct-horse-battery-staple';

let cachedHash = null;
async function testPasswordHash() {
  if (!cachedHash) cachedHash = await hashPassword(TEST_PASSWORD);
  return cachedHash;
}

const uniq = () => crypto.randomBytes(4).toString('hex');

export async function createTestMerchant(namePrefix = 'Test Merchant') {
  return createMerchant({ name: `${namePrefix} ${uniq()}` });
}

/**
 * Create a user for a merchant and return the user row plus a valid bearer token.
 */
export async function createTestUser({ merchantId, role = 'admin', email, status = 'active' } = {}) {
  const user = await createMerchantUser({
    merchantId,
    email: email || `${role}.${uniq()}@test.example`,
    passwordHash: await testPasswordHash(),
    role,
    status,
  });
  const token = AuthService.issueMerchantToken({ userId: user.id, merchantId, role });
  return { user, token, email: user.email, password: TEST_PASSWORD };
}

/**
 * Convenience: a user (default role admin) in the seeded default merchant. Existing tests create
 * their cases through the query layer without naming a merchant, so those cases live in this tenant.
 */
export async function createDefaultMerchantUser(role = 'admin') {
  return createTestUser({ merchantId: DEFAULT_MERCHANT_ID, role });
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });
