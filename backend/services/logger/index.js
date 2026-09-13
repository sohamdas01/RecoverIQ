/**
 * RecoverIQ Structured Logger & Correlation Module
 * Phase 6 - Step 1: Structured Logging & End-to-End Correlation IDs
 */

export { LoggerService, logger, createLogger } from './logger.service.js';
export {
  createCorrelationContext,
  runWithCorrelationContext,
  getCorrelationContext,
  updateCorrelationContext,
  sanitizeCorrelationId,
} from './correlation-context.js';
