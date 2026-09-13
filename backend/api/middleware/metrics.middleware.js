/**
 * RecoverIQ HTTP Request Metrics Middleware
 * Phase 6 - Step 2: Metrics, Health Checks & Readiness Probes
 *
 * Automatically records HTTP request rates, durations, and status code distributions
 * with strictly normalized, low-cardinality route templates.
 */

import { metrics, MetricsService, ERROR_TYPES } from '../../services/metrics/index.js';

export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const durationSeconds = Number(end - start) / 1e9;
    const route = MetricsService.normalizeRoute(req);
    const statusCode = res.statusCode || 200;

    const metricsInstance = req.app?.locals?.metricsService || metrics;
    metricsInstance.recordHttpRequest(req.method, route, statusCode, durationSeconds);

    if (statusCode >= 400) {
      const errorType = statusCode === 404
        ? ERROR_TYPES.NOT_FOUND
        : statusCode === 401 || statusCode === 403
        ? ERROR_TYPES.AUTH_ERROR
        : statusCode === 422 || statusCode === 400
        ? ERROR_TYPES.VALIDATION_ERROR
        : statusCode === 504
        ? ERROR_TYPES.TIMEOUT
        : statusCode === 503
        ? ERROR_TYPES.DEPENDENCY_UNAVAILABLE
        : ERROR_TYPES.UNKNOWN;

      metricsInstance.recordHttpError(req.method, route, errorType);
    }
  });

  next();
}
