/**
 * RecoverIQ Correlation Context
 * Phase 6 - Step 1: Structured Logging & End-to-End Correlation IDs
 *
 * Provides async-safe context propagation across HTTP, Kafka, and internal agent workflows
 * using Node.js AsyncLocalStorage.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const asyncLocalStorage = new AsyncLocalStorage();

/**
 * Creates and normalizes a correlation context object
 *
 * @param {Object} context Input correlation fields
 * @returns {Object} Clean correlation context
 */
export function createCorrelationContext(context = {}) {
  const requestId = context.requestId || context.correlationId || null;
  return {
    requestId,
    correlationId: context.correlationId || requestId || null,
    caseId: context.caseId || null,
    transactionId: context.transactionId || null,
    eventId: context.eventId || null,
    originalEventId: context.originalEventId || null,
    replayEventId: context.replayEventId || null,
    customerId: context.customerId || null,
    merchantId: context.merchantId || null,
  };
}

/**
 * Executes a function within the provided correlation context
 *
 * @param {Object} context Context data
 * @param {Function} fn Callback function to execute
 * @returns {any} Result of fn
 */
export function runWithCorrelationContext(context, fn) {
  const existing = asyncLocalStorage.getStore() || {};
  const merged = {
    ...existing,
    ...createCorrelationContext(context),
  };
  return asyncLocalStorage.run(merged, fn);
}

/**
 * Retrieves the current correlation context, or an empty object if outside context
 *
 * @returns {Object} Active correlation context
 */
export function getCorrelationContext() {
  return asyncLocalStorage.getStore() || {};
}

/**
 * Updates the active correlation context in-place
 *
 * @param {Object} updates Key-value updates to merge into current store
 */
export function updateCorrelationContext(updates = {}) {
  const store = asyncLocalStorage.getStore();
  if (store && typeof updates === 'object' && updates !== null) {
    Object.assign(store, updates);
  }
}

/**
 * Helper to safely sanitize header value string
 */
export function sanitizeCorrelationId(val) {
  if (!val || typeof val !== 'string') return null;
  const trimmed = val.trim();
  // Safe format: alphanumeric, hyphens, underscores, dots, max 64 characters
  if (/^[a-zA-Z0-9_\-\.]{1,64}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}
