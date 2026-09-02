import { updateTransactionStatus } from '../../db/queries/transactions.queries.js';
import { createMessage } from '../../db/queries/messages.queries.js';

export async function executeEscalateToHuman(params) {
  const ticketId = `TICK-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const priority = params.priority || 'high';

  await updateTransactionStatus(params.transactionId, 'escalated');

  await createMessage({
    transactionId: params.transactionId,
    eventTaken: 'escalated',
    channel: 'internal_ticketing',
    details: {
      ticketId,
      reason: params.reason,
      priority,
    },
  });

  console.log(`[Tool: escalate_to_human] Escalation ticket ${ticketId} created with priority: ${priority}`);

  return {
    ticketId,
    status: 'escalated',
    priority,
    reason: params.reason,
  };
}
