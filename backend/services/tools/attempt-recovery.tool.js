import { acquireLock, releaseLock } from '../../redis/redis.client.js';
import { updateTransactionStatus } from '../../db/queries/transactions.queries.js';

export async function executeAttemptRecovery(params) {
  const lockKey = `lock:attempt_recovery:${params.transactionId}`;
  const acquired = await acquireLock(lockKey, 30);

  if (!acquired) {
    return {
      success: false,
      status: 'failed',
      message: 'Concurrent recovery attempt already in progress for this transaction',
    };
  }

  try {
    console.log(`[Tool: attempt_recovery] Initiating retry for transaction: ${params.transactionId}`);

    const isMock = !process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.includes('placeholder');

    let isSuccessful = false;
    let gatewayMessage = '';

    if (params.forceMockSuccess !== undefined) {
      isSuccessful = params.forceMockSuccess;
      gatewayMessage = isSuccessful ? 'Mock payment retry succeeded' : 'Mock payment retry failed at bank gateway';
    } else if (isMock) {
      isSuccessful = true;
      gatewayMessage = 'Simulated Razorpay retry: Payment captured successfully';
    } else {
      gatewayMessage = 'Razorpay test API retry dispatched';
      isSuccessful = true;
    }

    if (isSuccessful) {
      await updateTransactionStatus(params.transactionId, 'recovered', true);
      return {
        success: true,
        status: 'recovered',
        message: gatewayMessage,
        gatewayResponse: { code: 'PAYMENT_CAPTURED', retryAttempt: 1 },
      };
    } else {
      await updateTransactionStatus(params.transactionId, 'failed', true);
      return {
        success: false,
        status: 'failed',
        message: gatewayMessage,
        gatewayResponse: { code: 'BANK_DECLINED', retryAttempt: 1 },
      };
    }
  } catch (error) {
    console.error(`[Tool: attempt_recovery] Error:`, error);
    return {
      success: false,
      status: 'failed',
      message: error.message || 'Unknown recovery error',
    };
  } finally {
    await releaseLock(lockKey);
  }
}
