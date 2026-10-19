/**
 * Parse a `limit` query parameter into a safe integer in [1, max].
 * Garbage, negative or oversized input falls back to the default / clamps to max
 * (an unchecked NaN or huge limit previously reached the SQL layer).
 */
export function parseLimit(value, defaultLimit = 50, maxLimit = 200) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultLimit;
  }
  return Math.min(parsed, maxLimit);
}

/**
 * Scope options for service/query calls, taken only from the authenticated principal
 * (never from request params or body).
 */
export function merchantScope(req) {
  return { merchantId: req.merchant.merchantId };
}
