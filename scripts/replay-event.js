#!/usr/bin/env node

import { replayDlqEvent, findDlqEvent } from '../backend/kafka/replay.service.js';
import { disconnectKafka } from '../backend/kafka/kafka.client.js';
import { disconnectRedis } from '../backend/redis/redis.client.js';
import { closeDatabasePool } from '../backend/db/index.js';

async function main() {
  const args = process.argv.slice(2);
  const dlqEventId = args[0];

  if (!dlqEventId || dlqEventId.startsWith('--')) {
    console.error(`
=====================================================
 RecoverIQ - Dead-Letter Event Replay Tool (CLI)
=====================================================
Usage:
  node scripts/replay-event.js <dlqEventId> [options]

Options:
  --dry-run      Validate and preview the replay without publishing
  --by <user>    Specify who is replaying the event (default: "admin_cli")
  --inspect      Inspect the DLQ event details only

Examples:
  node scripts/replay-event.js a8c439f0-2f3b-419b-a312-70b8c0a4e321
  node scripts/replay-event.js a8c439f0-2f3b-419b-a312-70b8c0a4e321 --dry-run
=====================================================
`);
    process.exit(1);
  }

  const isDryRun = args.includes('--dry-run');
  const isInspectOnly = args.includes('--inspect');
  const byIdx = args.indexOf('--by');
  const replayedBy = byIdx !== -1 && args[byIdx + 1] ? args[byIdx + 1] : 'admin_cli';

  console.log(`\n🔍 Looking up DLQ event: ${dlqEventId}...`);

  try {
    if (isInspectOnly) {
      const event = await findDlqEvent(dlqEventId);
      if (!event) {
        console.error(`❌ DLQ Event not found: ${dlqEventId}`);
        process.exit(1);
      }
      console.log('\n📄 DLQ Event Details:');
      console.log(JSON.stringify(event, null, 2));
      process.exit(0);
    }

    console.log(`🚀 Initiating event replay (dryRun: ${isDryRun}, replayedBy: ${replayedBy})...\n`);

    const result = await replayDlqEvent(dlqEventId, {
      replayedBy,
      dryRun: isDryRun,
    });

    console.log('=====================================================');
    console.log(`✅ Event Replay Result: ${result.status.toUpperCase()}`);
    console.log('=====================================================');
    console.log(`• DLQ Event ID:        ${result.dlqEventId}`);
    console.log(`• Original Event ID:   ${result.originalEventId}`);
    console.log(`• Replay Event ID:     ${result.replayEventId || '(Dry Run - None)'}`);
    console.log(`• Target Topic:        ${result.targetTopic}`);
    console.log(`• Replayed By:         ${result.replayedBy || replayedBy}`);
    console.log(`• Timestamp:           ${result.replayedAt || new Date().toISOString()}`);
    if (result.dryRun) {
      console.log(`• Mode:                DRY RUN (Not published to Kafka)`);
    } else {
      console.log(`• Kafka Status:        Successfully published to ${result.targetTopic}`);
    }
    console.log('=====================================================\n');

    process.exitCode = 0;
  } catch (error) {
    console.error('\n❌ Event Replay Failed:');
    console.error(`Status Code: ${error.statusCode || 500}`);
    console.error(`Reason:      ${error.message}`);
    if (error.validationErrors) {
      console.error('Validation Errors:', JSON.stringify(error.validationErrors, null, 2));
    }
    process.exitCode = 1;
  } finally {
    try {
      await disconnectKafka();
      await disconnectRedis();
      await closeDatabasePool();
    } catch (_) {}
  }
}

main();
