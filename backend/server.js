import * as dotenv from 'dotenv';
import { config, validateProductionConfig } from './services/config/index.js';
import { createApp } from './app.js';

// Validate production secrets configuration if running in production mode
validateProductionConfig();

import { initKafkaTopics, disconnectKafka } from './kafka/kafka.client.js';
import { startRecoveryConsumer, stopRecoveryConsumer } from './kafka/consumers/recovery.consumer.js';
import { startOutcomeConsumer, stopOutcomeConsumer } from './kafka/consumers/outcome.consumer.js';

dotenv.config();

const app = createApp();

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
