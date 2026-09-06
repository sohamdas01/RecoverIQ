import Redis from 'ioredis';
import * as dotenv from 'dotenv';

dotenv.config();


const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const memoryLocks = new Map();
const memoryRateLimits = new Map();

let isConnected = false;

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  retryStrategy(times) {
    if (times > 3) {
      console.warn('[Redis] Connection failed, using in-memory fallback store');
      return null;
    }
    return Math.min(times * 100, 2000);
  },
  lazyConnect: true,
});

redis.on('connect', () => {
  isConnected = true;
  console.log('[Redis] Connected successfully to', redisUrl);
});

redis.on('error', (err) => {
  isConnected = false;
  console.warn('[Redis] Connection warning:', err.message);
});

redis.connect().catch(() => {});

/**
 * Acquire a distributed lock for attempt_recovery
 */
export async function acquireLock(key, ttlSeconds = 60) {
  try {
    if (isConnected) {
      const result = await redis.set(key, 'locked', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    }
  } catch (e) {}

  const now = Date.now();
  const existingExpiry = memoryLocks.get(key);
  if (existingExpiry && existingExpiry > now) {
    return false;
  }
  memoryLocks.set(key, now + ttlSeconds * 1000);
  return true;
}

/**
 * Release a lock
 */
export async function releaseLock(key) {
  try {
    if (isConnected) {
      await redis.del(key);
      return;
    }
  } catch (e) {}
  memoryLocks.delete(key);
}

/**
 * Rate limit check for send_recovery_message
 */
export async function checkRateLimit(key, maxAttempts = 1, windowSeconds = 3600) {
  try {
    if (isConnected) {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }
      return current <= maxAttempts;
    }
  } catch (e) {}

  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const timestamps = (memoryRateLimits.get(key) || []).filter(t => t > windowStart);
  
  if (timestamps.length >= maxAttempts) {
    return false;
  }
  
  timestamps.push(now);
  memoryRateLimits.set(key, timestamps);
  return true;
}

/**
 * Check and set idempotency key (returns true if first time, false if duplicate)
 */
export async function checkIdempotency(key, ttlSeconds = 86400) {
  try {
    if (isConnected) {
      const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    }
  } catch (e) {}

  const now = Date.now();
  const existingExpiry = memoryLocks.get(key);
  if (existingExpiry && existingExpiry > now) {
    return false; // Duplicate
  }
  memoryLocks.set(key, now + ttlSeconds * 1000);
  return true; // First time
}

/**
 * Disconnect Redis client cleanly
 */
export async function disconnectRedis() {
  try {
    if (isConnected) {
      await redis.quit();
      isConnected = false;
    }
  } catch (e) {
    try {
      redis.disconnect();
    } catch (_) {}
  }
}
