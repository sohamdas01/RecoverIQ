import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  getKafkaClient,
  getProducer,
  createConsumer,
  getAdmin,
  initKafkaTopics,
  checkKafkaHealth,
  disconnectKafka,
} from '../kafka/kafka.client.js';
import { config } from '../services/config/index.js';

describe('Kafka Infrastructure & Client Tests', () => {
  after(async () => {
    await disconnectKafka();
  });

  it('should initialize KafkaJS client with valid broker configuration', () => {
    const client = getKafkaClient();
    assert.ok(client, 'Kafka client should be defined');
    assert.strictEqual(typeof client.producer, 'function');
    assert.strictEqual(typeof client.consumer, 'function');
    assert.strictEqual(typeof client.admin, 'function');
  });

  it('should connect to Kafka admin and report healthy cluster status', async () => {
    const health = await checkKafkaHealth();
    assert.strictEqual(health.status, 'healthy');
    assert.ok(Array.isArray(health.brokers), 'Brokers should be an array');
    assert.ok(health.brokers.length > 0, 'Should have at least 1 connected broker');
  });

  it('should initialize required topics (payment-events, recovery-outcomes, dead-letter-events)', async () => {
    const result = await initKafkaTopics();
    assert.strictEqual(result.success, true);
    assert.ok(result.topics.includes(config.kafka.paymentEventsTopic));
    assert.ok(result.topics.includes(config.kafka.recoveryOutcomesTopic));
    assert.ok(result.topics.includes(config.kafka.deadLetterTopic));

    const health = await checkKafkaHealth();
    assert.ok(health.topics.includes(config.kafka.paymentEventsTopic), 'payment-events topic should exist');
    assert.ok(health.topics.includes(config.kafka.recoveryOutcomesTopic), 'recovery-outcomes topic should exist');
    assert.ok(health.topics.includes(config.kafka.deadLetterTopic), 'dead-letter-events topic should exist');
  });

  it('should initialize and connect singleton Producer', async () => {
    const producer = await getProducer();
    assert.ok(producer, 'Producer should be instantiated');
    assert.strictEqual(typeof producer.send, 'function');
  });

  it('should create Consumer instance for recovery-worker-group', () => {
    const consumer = createConsumer({ groupId: config.kafka.recoveryWorkerGroup });
    assert.ok(consumer, 'Consumer should be instantiated');
    assert.strictEqual(typeof consumer.subscribe, 'function');
    assert.strictEqual(typeof consumer.run, 'function');
  });

  it('should create Consumer instance for outcome-worker-group', () => {
    const consumer = createConsumer({ groupId: config.kafka.outcomeWorkerGroup });
    assert.ok(consumer, 'Consumer should be instantiated');
    assert.strictEqual(typeof consumer.subscribe, 'function');
    assert.strictEqual(typeof consumer.run, 'function');
  });
});
