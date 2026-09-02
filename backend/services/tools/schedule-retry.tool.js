import { createMessage } from '../../db/queries/messages.queries.js';

export async function executeScheduleRetry(params) {
  const delayHours = params.delayHours || 4;
  const scheduledTime = params.retryAt
    ? new Date(params.retryAt)
    : new Date(Date.now() + delayHours * 3600 * 1000);

  console.log(`[Tool: schedule_retry] Scheduling retry for transaction ${params.transactionId} at ${scheduledTime.toISOString()}`);

  await createMessage({
    transactionId: params.transactionId,
    eventTaken: 'retry_scheduled',
    channel: 'scheduler',
    details: {
      scheduledFor: scheduledTime.toISOString(),
      reason: params.reason || 'Deferred retry scheduled for optimal success window',
    },
  });

  return {
    scheduled: true,
    status: 'scheduled',
    scheduledFor: scheduledTime.toISOString(),
    reason: params.reason || `Retry deferred for ${delayHours} hours`,
  };
}
