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
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN || 'recoveriq-internal-service-token-dev-secret',
  mlInternalToken: process.env.ML_INTERNAL_TOKEN || process.env.INTERNAL_SERVICE_TOKEN || 'recoveriq-internal-service-token-dev-secret',
  genaiInternalToken: process.env.GENAI_INTERNAL_TOKEN || process.env.INTERNAL_SERVICE_TOKEN || 'recoveriq-internal-service-token-dev-secret',

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

export const INSECURE_DEFAULT_SECRETS = new Set([
  'recoveriq-jwt-secret-key-default',
  'recoveriq-jwt-secret-key',
  'recoveriq-super-secret-jwt-key',
  'recoveriq-super-secret-jwt-key-change-in-production',
  'recoveriq-recovery-link-secret-default',
  'recoveriq-recovery-link-signing-secret',
  'recoveriq-internal-service-token-dev-secret',
  'your-production-jwt-secret-min-32-chars',
  'your-production-recovery-link-secret-min-32-chars',
  'your-internal-service-token-secret',
  'your-ml-service-token-secret',
  'your-genai-service-token-secret',
]);

/**
 * Validates configuration for production readiness.
 * - In development/test mode: allows safe fallback defaults.
 * - In production mode: strictly requires explicit, non-default environment variables.
 *
 * @param {Object} [env=process.env] Optional environment object for testing
 * @returns {{ isValid: boolean, errors: string[] }} Validation result
 * @throws {Error} In production mode if required secrets are missing or insecure
 */
export function validateProductionConfig(env = process.env) {
  const isProd = (env.NODE_ENV || '').toLowerCase() === 'production';
  if (!isProd) {
    return { isValid: true, errors: [] };
  }

  const errors = [];
  const requiredProductionSecrets = [
    { key: 'JWT_SECRET', value: env.JWT_SECRET, label: 'JWT Signing Secret' },
    { key: 'RECOVERY_LINK_SECRET', value: env.RECOVERY_LINK_SECRET, label: 'Recovery Link Secret' },
    { key: 'DATABASE_URL', value: env.DATABASE_URL, label: 'PostgreSQL Database URL' },
    {
      key: 'ML_INTERNAL_TOKEN',
      value: env.ML_INTERNAL_TOKEN || env.INTERNAL_SERVICE_TOKEN,
      label: 'ML Service Internal Token',
    },
    {
      key: 'GENAI_INTERNAL_TOKEN',
      value: env.GENAI_INTERNAL_TOKEN || env.INTERNAL_SERVICE_TOKEN,
      label: 'GenAI Service Internal Token',
    },
  ];

  for (const { key, value, label } of requiredProductionSecrets) {
    if (!value || typeof value !== 'string' || value.trim() === '') {
      errors.push(`Missing mandatory production secret: ${key} (${label})`);
    } else if (INSECURE_DEFAULT_SECRETS.has(value.trim())) {
      errors.push(`Insecure default secret detected in production: ${key}='${value.trim()}'`);
    }
  }

  if (errors.length > 0) {
    const errorMsg = `[Config Error] Production startup failed with ${errors.length} configuration validation error(s):\n - ${errors.join('\n - ')}`;
    const err = new Error(errorMsg);
    err.validationErrors = errors;
    throw err;
  }

  return { isValid: true, errors: [] };
}

