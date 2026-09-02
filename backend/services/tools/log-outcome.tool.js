import { updateActionResult } from '../../db/queries/actions.queries.js';

export async function executeLogOutcome(params) {
  const recordedAt = new Date().toISOString();

  if (params.actionId) {
    await updateActionResult(params.actionId, params.outcome, {
      ...params.metadata,
      loggedAt: recordedAt,
    });
  }

  console.log(`[Tool: log_outcome] Outcome for transaction ${params.transactionId} logged as: ${params.outcome}`);

  return {
    logged: true,
    recordedAt,
    outcome: params.outcome,
  };
}
