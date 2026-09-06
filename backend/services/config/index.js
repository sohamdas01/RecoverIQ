import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  env: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  
  // Database & Cache
  databaseUrl: process.env.DATABASE_URL || 'postgresql://recoveriq_user:recoveriq_password@localhost:5433/recoveriq_db',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // Microservices
  genaiServiceUrl: process.env.GENAI_SERVICE_URL || 'http://localhost:8001',
  mlServiceUrl: process.env.ML_SERVICE_URL || 'http://localhost:8000',

  // Auth & Security
  jwtSecret: process.env.JWT_SECRET || 'recoveriq-jwt-secret-key-default',
  recoveryLinkSecret: process.env.RECOVERY_LINK_SECRET || 'recoveriq-recovery-link-secret-default',
  recoveryLinkExpiryHours: 24,

  // Razorpay
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder_key',
    keySecret: process.env.RAZORPAY_KEY_SECRET || 'rzp_test_placeholder_secret',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || 'rzp_webhook_secret_placeholder',
  },

  // Guardrail & Recovery Policy Thresholds
  guardrails: {
    maxAutoRetries: 3,
    autoRetryCooldownMinutes: 15,
    maxAutoApprovalAmount: 50000.00, // In INR (₹50,000)
    maxRecoveryMessagesPerDay: 2,
    fraudBlockThreshold: 0.85,
    highValueThreshold: 20000.00,
  },

  // Kafka Topics & Consumer Groups
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:19092').split(',').map(b => b.trim()),
    clientId: process.env.KAFKA_CLIENT_ID || 'recoveriq-backend',
    paymentEventsTopic: process.env.KAFKA_PAYMENT_TOPIC || 'payment-events',
    recoveryOutcomesTopic: process.env.KAFKA_OUTCOME_TOPIC || 'recovery-outcomes',
    deadLetterTopic: process.env.KAFKA_DLQ_TOPIC || 'dead-letter-events',
    recoveryWorkerGroup: process.env.KAFKA_RECOVERY_GROUP || 'recovery-worker-group',
    outcomeWorkerGroup: process.env.KAFKA_OUTCOME_GROUP || 'outcome-worker-group',
  },

  // Retry & DLQ Configuration
  retry: {
    maxRetries: parseInt(process.env.RETRY_MAX_ATTEMPTS || '3', 10),
    initialDelayMs: parseInt(process.env.RETRY_INITIAL_DELAY_MS || '100', 10),
    maxDelayMs: parseInt(process.env.RETRY_MAX_DELAY_MS || '2000', 10),
    backoffMultiplier: parseFloat(process.env.RETRY_BACKOFF_MULTIPLIER || '2'),
    jitter: true,
    entityRecheckRetries: parseInt(process.env.RETRY_ENTITY_RECHECK || '3', 10),
    entityRecheckDelayMs: parseInt(process.env.RETRY_ENTITY_DELAY_MS || '100', 10),
  },
};
