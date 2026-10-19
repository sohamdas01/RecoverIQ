import express from 'express';
import cors from 'cors';
import { config } from './services/config/index.js';
import { errorHandler } from './api/middleware/error.middleware.js';
import { correlationMiddleware } from './api/middleware/correlation.middleware.js';
import { metricsMiddleware } from './api/middleware/metrics.middleware.js';
import { tracingMiddleware } from './api/middleware/tracing.middleware.js';

import authRoutes from './api/routes/auth.routes.js';
import simulateRoutes from './api/routes/simulate.routes.js';
import transactionsRoutes from './api/routes/transactions.routes.js';
import decisionsRoutes from './api/routes/decisions.routes.js';
import recoveryRoutes from './api/routes/recovery.routes.js';
import webhooksRoutes from './api/routes/webhooks.routes.js';
import adminRoutes from './api/routes/admin-events.routes.js';
import recoveryCasesRoutes from './api/routes/recovery-cases.routes.js';
import healthRoutes from './api/routes/health.routes.js';
import metricsRoutes from './api/routes/metrics.routes.js';

/**
 * CORS: only the configured browser origins may call the API from a browser.
 * Requests without an Origin header (server-to-server, e.g. payment-provider webhooks) are not CORS requests.
 */
export function buildCorsOptions(allowedOrigins = config.corsOrigins) {
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      return callback(null, allowedOrigins.includes(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
  };
}

/**
 * Build the Express application (no listening / no background workers), so the exact
 * production middleware stack can be exercised by tests.
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Set TRUST_PROXY (e.g. "1") when running behind a reverse proxy so client IPs (login throttling) are real
  if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY);
    app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
  }

  // Middleware
  app.use(cors(buildCorsOptions()));
  app.use(express.json({
    limit: '100kb',
    // Keep the exact bytes: payment-provider webhook signatures are computed over the raw body
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));
  app.use(tracingMiddleware);
  app.use(correlationMiddleware);
  app.use(metricsMiddleware);

  // Health & Readiness Probes
  app.use('/health', healthRoutes);

  // Prometheus Metrics Endpoint
  app.use('/metrics', metricsRoutes);

  // API Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/simulate', simulateRoutes);
  app.use('/api/transactions', transactionsRoutes);
  app.use('/api/decisions', decisionsRoutes);
  app.use('/api/recover', recoveryRoutes);
  app.use('/api/webhooks', webhooksRoutes);
  app.use('/api/admin/recovery-cases', recoveryCasesRoutes);
  app.use('/api/admin', adminRoutes);

  // Error Handling
  app.use(errorHandler);

  return app;
}
