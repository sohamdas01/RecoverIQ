import { checkRateLimit } from '../../redis/redis.client.js';
import { AuthService } from '../auth/auth.service.js';
import { createRecoveryLink } from '../../db/queries/recovery-links.queries.js';
import { createMessage } from '../../db/queries/messages.queries.js';
import { getTransactionById } from '../../db/queries/transactions.queries.js';
import { config } from '../config/index.js';

export async function executeSendRecoveryMessage(params) {
  const rateLimitKey = `rate:msg:${params.transactionId}`;
  const allowed = await checkRateLimit(rateLimitKey, config.guardrails.maxRecoveryMessagesPerDay, 86400);

  if (!allowed) {
    return {
      sent: false,
      error: `Rate limit exceeded: Recovery message already sent for transaction ${params.transactionId}`,
    };
  }

  const txData = await getTransactionById(params.transactionId);
  if (!txData) {
    return {
      sent: false,
      error: `Transaction ${params.transactionId} not found`,
    };
  }

  const { transaction, customer } = txData;

  // 1. Generate secure signed token
  const { token, expiresAt } = AuthService.generateRecoveryToken({
    transactionId: transaction.id,
    amount: parseFloat(transaction.amount),
    currency: transaction.currency,
    email: customer.email,
  });

  // 2. Persist recovery link in DB
  await createRecoveryLink({
    transactionId: transaction.id,
    token,
    expiresAt,
  });

  const recoveryUrl = `${config.frontendUrl}/recover/${token}`;
  const channel = params.channel || 'email';

  // 3. Record message dispatch in messages table
  const messageRecord = await createMessage({
    transactionId: transaction.id,
    eventTaken: 'recovery_link_sent',
    channel,
    details: {
      recipient: customer.email,
      recoveryUrl,
      expiresAt: expiresAt.toISOString(),
      templateId: params.templateId || 'card_expired_recovery_v1',
      customMessage: params.customMessage,
    },
  });

  console.log(`[Tool: send_recovery_message] Recovery link created for customer ${customer.email}: ${recoveryUrl}`);

  return {
    sent: true,
    messageId: messageRecord.id,
    linkToken: token,
    recoveryUrl,
    channel,
  };
}
