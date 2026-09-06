import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { config } from './services/config/index.js';
import { errorHandler } from './api/middleware/error.middleware.js';

import simulateRoutes from './api/routes/simulate.routes.js';
import transactionsRoutes from './api/routes/transactions.routes.js';
import decisionsRoutes from './api/routes/decisions.routes.js';
import recoveryRoutes from './api/routes/recovery.routes.js';
import webhooksRoutes from './api/routes/webhooks.routes.js';
import adminRoutes from './api/routes/admin-events.routes.js';

import { checkKafkaHealth, initKafkaTopics, disconnectKafka } from './kafka/kafka.client.js';
import { startRecoveryConsumer, stopRecoveryConsumer } from './kafka/consumers/recovery.consumer.js';
import { startOutcomeConsumer, stopOutcomeConsumer } from './kafka/consumers/outcome.consumer.js';

dotenv.config();

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// Health Check
app.get('/health', async (req, res) => {
  const kafkaHealth = await checkKafkaHealth();
  res.status(200).json({
    status: 'healthy',
    service: 'recoveriq-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    kafka: kafkaHealth,
  });
});

// Dedicated Kafka Health Probe
app.get('/health/kafka', async (req, res) => {
  const kafkaHealth = await checkKafkaHealth();
  const statusCode = kafkaHealth.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(kafkaHealth);
});

// API Routes
app.use('/api/simulate', simulateRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/decisions', decisionsRoutes);
app.use('/api/recover', recoveryRoutes);
app.use('/api/webhooks', webhooksRoutes);
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
