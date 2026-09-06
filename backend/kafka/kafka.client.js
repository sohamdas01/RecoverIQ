import { Kafka, logLevel, Partitioners } from 'kafkajs';
import { config } from '../services/config/index.js';

let kafkaInstance = null;
let producerInstance = null;
let adminInstance = null;

/**
 * Get or initialize the singleton KafkaJS client instance
 */
export function getKafkaClient() {
  if (!kafkaInstance) {
    const brokers = config.kafka.brokers;
    const clientId = config.kafka.clientId || 'recoveriq-backend';

    kafkaInstance = new Kafka({
      clientId,
      brokers,
      logLevel: config.env === 'development' ? logLevel.WARN : logLevel.ERROR,
      retry: {
        initialRetryTime: 300,
        retries: 5,
      },
    });
  }
  return kafkaInstance;
}

/**
 * Get or create connected singleton Producer instance
 */
export async function getProducer() {
  if (!producerInstance) {
    const kafka = getKafkaClient();
    producerInstance = kafka.producer({
      allowAutoTopicCreation: true,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
    await producerInstance.connect();
    console.log('[Kafka] Producer connected successfully');
  }
  return producerInstance;
}

/**
 * Create a new Consumer instance with specified groupId
 */
export function createConsumer({ groupId }) {
  const kafka = getKafkaClient();
  const consumer = kafka.consumer({
    groupId: groupId || config.kafka.recoveryWorkerGroup,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
    maxWaitTimeInMs: 500,
    retry: {
      retries: 5,
    },
  });
  return consumer;
}

/**
 * Get or create connected Admin instance
 */
export async function getAdmin() {
  if (!adminInstance) {
    const kafka = getKafkaClient();
    adminInstance = kafka.admin();
    await adminInstance.connect();
  }
  return adminInstance;
}

/**
 * Initialize and verify required Kafka topics
 */
export async function initKafkaTopics() {
  try {
    const admin = await getAdmin();
    const existingTopics = await admin.listTopics();
    
    const requiredTopics = [
      {
        topic: config.kafka.paymentEventsTopic,
        numPartitions: 3,
        replicationFactor: 1,
      },
      {
        topic: config.kafka.recoveryOutcomesTopic,
        numPartitions: 3,
        replicationFactor: 1,
      },
      {
        topic: config.kafka.deadLetterTopic,
        numPartitions: 3,
        replicationFactor: 1,
      },
    ];

    const topicsToCreate = requiredTopics.filter(
      (t) => !existingTopics.includes(t.topic)
    );

    if (topicsToCreate.length > 0) {
      console.log(`[Kafka] Creating missing topics: ${topicsToCreate.map(t => t.topic).join(', ')}`);
      await admin.createTopics({
        topics: topicsToCreate,
        waitForLeaders: true,
      });
      console.log('[Kafka] Topics created successfully');
    } else {
      console.log(`[Kafka] All required topics exist: ${requiredTopics.map(t => t.topic).join(', ')}`);
    }

    return {
      success: true,
      topics: requiredTopics.map(t => t.topic),
      existingTopics,
    };
  } catch (error) {
    console.error('[Kafka] Error initializing topics:', error.message);
    throw error;
  }
}

/**
 * Check Kafka connectivity and broker health
 */
export async function checkKafkaHealth() {
  try {
    const admin = await getAdmin();
    const cluster = await admin.describeCluster();
    const topics = await admin.listTopics();

    return {
      status: 'healthy',
      brokers: cluster.brokers,
      controller: cluster.controller,
      clusterId: cluster.clusterId,
      topics,
    };
  } catch (error) {
    return {
      status: 'unreachable',
      error: error.message,
    };
  }
}

/**
 * Graceful disconnect of Kafka clients
 */
export async function disconnectKafka() {
  try {
    if (producerInstance) {
      await producerInstance.disconnect();
      producerInstance = null;
      console.log('[Kafka] Producer disconnected');
    }
    if (adminInstance) {
      await adminInstance.disconnect();
      adminInstance = null;
      console.log('[Kafka] Admin disconnected');
    }
  } catch (error) {
    console.error('[Kafka] Error during disconnect:', error.message);
  }
}
