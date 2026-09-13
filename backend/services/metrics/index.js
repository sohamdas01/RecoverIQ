/**
 * RecoverIQ Metrics Module
 * Phase 6 - Step 2: Metrics, Health Checks & Readiness Probes
 */

import { MetricsService, metrics, ERROR_TYPES } from './metrics.service.js';
export { MetricsRegistry, defaultRegistry, Counter, Gauge, Histogram } from './registry.js';
export { MetricsService, metrics, ERROR_TYPES };
export const classifyError = MetricsService.classifyError;

