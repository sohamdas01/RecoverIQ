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

  // Kafka Topics
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:19092').split(','),
    recoveryTopic: process.env.KAFKA_RECOVERY_TOPIC || 'recovery-events',
    outcomeTopic: process.env.KAFKA_OUTCOME_TOPIC || 'outcome-events',
    dlqTopic: process.env.KAFKA_DLQ_TOPIC || 'recovery-dlq',
  },
};
