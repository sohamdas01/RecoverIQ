/**
 * RecoverIQ HTTP Request Correlation Middleware
 * Phase 6 - Step 1: Structured Logging & End-to-End Correlation IDs
 *
 * Inspects incoming request headers for correlation identifiers, generates safe UUIDs,
 * sets response headers, and binds async correlation context for downstream operations.
 */

import crypto from 'crypto';
import {
  runWithCorrelationContext,
  sanitizeCorrelationId,
} from '../../services/logger/index.js';

export function correlationMiddleware(req, res, next) {
  const incomingReqId = sanitizeCorrelationId(req.headers['x-request-id'] || req.headers['request-id']);
  const incomingCorrId = sanitizeCorrelationId(req.headers['x-correlation-id'] || req.headers['correlation-id']);

  const requestId = incomingReqId || crypto.randomUUID();
  const correlationId = incomingCorrId || requestId;

  // Attach to express request
  req.requestId = requestId;
  req.correlationId = correlationId;

  // Set standard correlation response headers
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Correlation-Id', correlationId);

  // Wrap downstream handlers in AsyncLocalStorage correlation context
  runWithCorrelationContext({ requestId, correlationId }, () => {
    next();
  });
}
