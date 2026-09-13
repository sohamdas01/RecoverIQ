/**
 * RecoverIQ Structured Logger Service
 * Phase 6 - Step 1: Structured Logging & End-to-End Correlation IDs
 *
 * Emits JSON-compatible structured logs enriched with correlation context,
 * service identifiers, durations, and deep recursive secret scrubbing.
 */

import { getCorrelationContext } from './correlation-context.js';
import { getCurrentTraceContext } from '../observability/tracing.service.js';

const SENSITIVE_KEY_PATTERN = /^(password|secret|token|apiKey|key|authorization|cvv|pan|card_number|auth_token|jwt|raw_token)$/i;


export class LoggerService {
  constructor({ component = 'app', service = 'recoveriq-backend' } = {}) {
    this.component = component;
    this.service = service;
  }

  /**
   * Deeply sanitizes an object, stripping or masking sensitive keys/values
   *
   * @param {any} obj Payload to sanitize
   * @returns {any} Clean sanitized object
   */
  static sanitize(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof Error) {
      return {
        message: obj.message,
        name: obj.name,
        code: obj.code,
        stack: process.env.NODE_ENV === 'development' ? obj.stack : undefined,
      };
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => LoggerService.sanitize(item));
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        cleaned[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        cleaned[key] = LoggerService.sanitize(value);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  /**
   * Builds the normalized structured log payload
   */
  _buildLogPayload(level, eventOrMessage, metadata = {}) {
    const timestamp = new Date().toISOString();
    const context = getCorrelationContext();
    const isStringMessage = typeof eventOrMessage === 'string';
    const event = isStringMessage ? eventOrMessage : metadata.event || 'log_event';
    const message = isStringMessage ? eventOrMessage : metadata.message;

    const sanitizedMeta = LoggerService.sanitize(metadata);

    const traceContext = getCurrentTraceContext ? getCurrentTraceContext() : { traceId: null, spanId: null };

    const logObject = {
      timestamp,
      level,
      service: this.service,
      component: this.component,
      event,
      ...(message && message !== event ? { message } : {}),

      // Trace Context (OpenTelemetry)
      traceId: sanitizedMeta.traceId || traceContext.traceId || undefined,
      spanId: sanitizedMeta.spanId || traceContext.spanId || undefined,

      // Correlation Context (propagated across async boundaries)
      requestId: sanitizedMeta.requestId || context.requestId || undefined,
      correlationId: sanitizedMeta.correlationId || context.correlationId || undefined,
      caseId: sanitizedMeta.caseId || context.caseId || undefined,
      transactionId: sanitizedMeta.transactionId || context.transactionId || undefined,
      eventId: sanitizedMeta.eventId || context.eventId || undefined,
      originalEventId: sanitizedMeta.originalEventId || context.originalEventId || undefined,
      replayEventId: sanitizedMeta.replayEventId || context.replayEventId || undefined,

      // Operational & Decision metadata
      durationMs: typeof sanitizedMeta.durationMs === 'number' ? sanitizedMeta.durationMs : undefined,
      decision: sanitizedMeta.decision || undefined,
      action: sanitizedMeta.action || sanitizedMeta.toolName || undefined,
      policyVersion: sanitizedMeta.policyVersion || undefined,
      agent: sanitizedMeta.agent || undefined,

      // Remaining metadata payload
      ...sanitizedMeta,
    };

    // Clean undefined keys for compact JSON
    Object.keys(logObject).forEach((k) => {
      if (logObject[k] === undefined) {
        delete logObject[k];
      }
    });

    return logObject;
  }

  /**
   * Formats and prints structured JSON log
   */
  _writeLog(logObject) {
    const jsonStr = JSON.stringify(logObject);
    if (logObject.level === 'ERROR') {
      console.error(jsonStr);
    } else if (logObject.level === 'WARN') {
      console.warn(jsonStr);
    } else {
      console.log(jsonStr);
    }
    return logObject;
  }

  info(eventOrMessage, metadata = {}) {
    const logObj = this._buildLogPayload('INFO', eventOrMessage, metadata);
    return this._writeLog(logObj);
  }

  warn(eventOrMessage, metadata = {}) {
    const logObj = this._buildLogPayload('WARN', eventOrMessage, metadata);
    return this._writeLog(logObj);
  }

  error(eventOrMessage, metadata = {}) {
    const logObj = this._buildLogPayload('ERROR', eventOrMessage, metadata);
    return this._writeLog(logObj);
  }

  debug(eventOrMessage, metadata = {}) {
    if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development') {
      const logObj = this._buildLogPayload('DEBUG', eventOrMessage, metadata);
      return this._writeLog(logObj);
    }
    return null;
  }

  /**
   * Creates a child logger with a dedicated component name
   *
   * @param {string} component Component name
   * @returns {LoggerService} Child logger instance
   */
  child(component) {
    return new LoggerService({ component, service: this.service });
  }

  withComponent(component) {
    return this.child(component);
  }
}

// Global default singleton instance
export const logger = new LoggerService({ component: 'app' });
export const createLogger = (options) => new LoggerService(options);
