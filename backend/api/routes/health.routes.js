/**
 * RecoverIQ Health & Readiness Probes
 * Phase 6 - Step 2: Metrics, Health Checks & Readiness Probes
 */

import express from 'express';
import { pool } from '../../db/index.js';
import { redis } from '../../redis/redis.client.js';
import { checkKafkaHealth } from '../../kafka/kafka.client.js';

const router = express.Router();

/**
 * Liveness Probe: "Is this process running?"
 * Must return 200 as long as the Node.js event loop is operational.
 * Does not fail when external databases or message brokers are unreachable.
 */
router.get('/live', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'recoveriq-backend',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Helper to check individual dependency readiness with short timeout
 */
export async function checkDependenciesHealth(options = {}) {
  const timeoutMs = options.timeoutMs || 1500;

  // 1. PostgreSQL Check
  let postgresStatus = 'ok';
  try {
    const pgCheck = options.pgChecker
      ? options.pgChecker()
      : pool.query('SELECT 1');

    await Promise.race([
      pgCheck,
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), timeoutMs)),
    ]);
  } catch (err) {
    postgresStatus = 'unavailable';
  }

  // 2. Redis Check
  let redisStatus = 'ok';
  try {
    if (options.redisChecker) {
      await options.redisChecker();
    } else {
      if (!redis || redis.status !== 'ready') {
        redisStatus = 'unavailable';
      } else {
        await Promise.race([
          redis.ping(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), timeoutMs)),
        ]);
      }
    }
  } catch (err) {
    redisStatus = 'unavailable';
  }

  // 3. Kafka Check
  let kafkaStatus = 'ok';
  try {
    const kHealth = options.kafkaChecker
      ? await options.kafkaChecker()
      : await Promise.race([
          checkKafkaHealth(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Kafka timeout')), timeoutMs)),
        ]);

    if (kHealth.status !== 'healthy') {
      kafkaStatus = 'unavailable';
    }
  } catch (err) {
    kafkaStatus = 'unavailable';
  }

  const isReady = postgresStatus === 'ok' && redisStatus === 'ok' && kafkaStatus === 'ok';

  return {
    isReady,
    status: isReady ? 'ok' : 'not_ready',
    dependencies: {
      postgres: postgresStatus,
      redis: redisStatus,
      kafka: kafkaStatus,
    },
  };
}

/**
 * Readiness Probe: "Can this service perform its required responsibilities?"
 * Verifies connectivity to PostgreSQL, Redis, and Kafka.
 * Returns HTTP 200 when ready, HTTP 503 when degraded.
 */
router.get('/ready', async (req, res) => {
  const options = req.app?.locals?.healthOptions || {};
  const healthResult = await checkDependenciesHealth(options);
  const statusCode = healthResult.isReady ? 200 : 503;

  res.status(statusCode).json({
    status: healthResult.status,
    service: 'recoveriq-backend',
    timestamp: new Date().toISOString(),
    dependencies: healthResult.dependencies,
  });
});

/**
 * Dedicated Kafka Health Probe (Backwards Compatibility)
 */
router.get('/kafka', async (req, res) => {
  const kafkaChecker = req.app?.locals?.kafkaChecker || checkKafkaHealth;
  const kafkaHealth = await kafkaChecker();
  const statusCode = kafkaHealth.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(kafkaHealth);
});

/**
 * Legacy Composite Health Check (Backwards Compatibility)
 */
router.get('/', async (req, res) => {
  const kafkaChecker = req.app?.locals?.kafkaChecker || checkKafkaHealth;
  const kafkaHealth = await kafkaChecker();
  res.status(200).json({
    status: 'healthy',
    service: 'recoveriq-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    kafka: kafkaHealth,
  });
});

export default router;
