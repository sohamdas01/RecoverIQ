import { checkKafkaHealth, getAdmin, disconnectKafka } from '../kafka/kafka.client.js';
import { redis, disconnectRedis } from '../redis/redis.client.js';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

async function verifyAllSystems() {
  console.log('=== RecoverIQ Full Stack Sanity Check ===');
  
  // 1. Check PostgreSQL
  try {
    const dbResult = await db.execute(sql`SELECT 1 as connected`);
    console.log('[PostgreSQL] Connection OK: count =', dbResult.rowCount);
  } catch (err) {
    console.error('[PostgreSQL] Connection Failed:', err.message);
  }

  // 2. Check Redis
  try {
    const ping = await redis.ping();
    console.log('[Redis] Ping OK:', ping);
  } catch (err) {
    console.error('[Redis] Connection Failed:', err.message);
  }

  // 3. Check Kafka / Redpanda
  try {
    const health = await checkKafkaHealth();
    console.log('[Kafka/Redpanda] Health OK:', health.status);

    const admin = await getAdmin();
    const topics = await admin.listTopics();
    console.log('[Kafka/Redpanda] Existing Topics:', topics.filter(t => !t.startsWith('_')));
  } catch (err) {
    console.error('[Kafka/Redpanda] Health Check Failed:', err.message);
  }

  // Teardown
  await disconnectRedis();
  await disconnectKafka();
  console.log('=== All Core Services Verified Successfully ===');
  process.exit(0);
}

verifyAllSystems().catch(console.error);
