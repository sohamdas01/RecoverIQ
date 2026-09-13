import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { config, validateProductionConfig } from './services/config/index.js';
import { errorHandler } from './api/middleware/error.middleware.js';
import { correlationMiddleware } from './api/middleware/correlation.middleware.js';
import { metricsMiddleware } from './api/middleware/metrics.middleware.js';
import { tracingMiddleware } from './api/middleware/tracing.middleware.js';

// Validate production secrets configuration if running in production mode
validateProductionConfig();


import simulateRoutes from './api/routes/simulate.routes.js';
import transactionsRoutes from './api/routes/transactions.routes.js';
import decisionsRoutes from './api/routes/decisions.routes.js';
import recoveryRoutes from './api/routes/recovery.routes.js';
import webhooksRoutes from './api/routes/webhooks.routes.js';
import adminRoutes from './api/routes/admin-events.routes.js';
import recoveryCasesRoutes from './api/routes/recovery-cases.routes.js';
import healthRoutes from './api/routes/health.routes.js';
import metricsRoutes from './api/routes/metrics.routes.js';

import { checkKafkaHealth, initKafkaTopics, disconnectKafka } from './kafka/kafka.client.js';
import { startRecoveryConsumer, stopRecoveryConsumer } from './kafka/consumers/recovery.consumer.js';
import { startOutcomeConsumer, stopOutcomeConsumer } from './kafka/consumers/outcome.consumer.js';

dotenv.config();

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(tracingMiddleware);
app.use(correlationMiddleware);
app.use(metricsMiddleware);


// Health & Readiness Probes
app.use('/health', healthRoutes);

// Prometheus Metrics Endpoint
app.use('/metrics', metricsRoutes);

// API Routes
app.use('/api/simulate', simulateRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/decisions', decisionsRoutes);
app.use('/api/recover', recoveryRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/admin/recovery-cases', recoveryCasesRoutes);
app.use('/api/admin', adminRoutes);

// Error Handling
app.use(errorHandler);

const PORT = config.port || 4000;

const server = app.listen(PORT, async () => {
  console.log(`=========================================`);
  console.log(` RecoverIQ Backend API is running on port ${PORT}`);
  console.log(` Health: http://localhost:${PORT}/health`);
  console.log(`=========================================`);

  // Initialize Kafka topics in background on startup
  try {
    await initKafkaTopics();
    // Start recovery worker consumer if enabled
    if (process.env.START_RECOVERY_WORKER !== 'false') {
      await startRecoveryConsumer();
    }
    // Start outcome worker consumer if enabled
    if (process.env.START_OUTCOME_WORKER !== 'false') {
      await startOutcomeConsumer();
    }
  } catch (err) {
    console.warn(`[Kafka] Startup notice: ${err.message}`);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received. Shutting down gracefully...');
  await stopRecoveryConsumer();
  await stopOutcomeConsumer();
  await disconnectKafka();
  server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  console.log('[Server] SIGINT received. Shutting down gracefully...');
  await stopRecoveryConsumer();
  await stopOutcomeConsumer();
  await disconnectKafka();
  server.close(() => process.exit(0));
});

export default app;
