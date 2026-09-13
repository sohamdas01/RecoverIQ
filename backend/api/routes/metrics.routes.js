/**
 * RecoverIQ Prometheus Metrics Route
 * Phase 6 - Step 2: Metrics, Health Checks & Readiness Probes
 *
 * Exposes Prometheus exposition format text at GET /metrics
 */

import express from 'express';
import { defaultRegistry } from '../../services/metrics/index.js';

const router = express.Router();

router.get('/', (req, res) => {
  const reg = req.app?.locals?.metricsRegistry || defaultRegistry;
  res.setHeader('Content-Type', reg.contentType);
  res.send(reg.getMetrics());
});

export default router;
