/**
 * Tenant scoping for service-layer calls.
 *
 * Every merchant-facing service entry point (review, case explanation, activity, Ask) must be told
 * WHICH merchant it is acting for. `resolveScope` turns the caller-supplied options into the
 * `{ merchantId }` filter understood by the DB query layer, and refuses to continue when no
 * tenant was named — so a controller that forgets to pass one fails closed instead of reading
 * across tenants. Internal/system callers (Kafka workers, tests) must opt in with `system: true`.
 */

export class TenantScopeError extends Error {
  constructor() {
    super('Merchant scope is required for this operation');
    this.name = 'TenantScopeError';
    this.statusCode = 403;
    this.code = 'MERCHANT_SCOPE_REQUIRED';
  }
}

/**
 * @param {{ merchantId?: string, system?: boolean }} [options]
 * @returns {{ merchantId?: string }} filter for the query layer ({} means unscoped / system)
 */
export function resolveScope({ merchantId, system } = {}) {
  // A named merchant always wins, even if `system` is also set: system access is only for callers with no tenant
  if (typeof merchantId === 'string' && merchantId.trim() !== '') {
    return { merchantId };
  }
  if (system === true) {
    return {};
  }
  throw new TenantScopeError();
}
