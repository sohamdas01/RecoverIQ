import { AuthService } from '../../services/auth/auth.service.js';
import { getValidRecoveryLink, markRecoveryLinkUsed } from '../../db/queries/recovery-links.queries.js';
import { updateTransactionStatus } from '../../db/queries/transactions.queries.js';
import { createMessage } from '../../db/queries/messages.queries.js';

/**
 * Validate customer recovery token and retrieve invoice/transaction details
 */
export async function getRecoveryDetails(req, res, next) {
  try {
    const { token } = req.params;

    // 1. Verify cryptographic signature & expiry
    const decoded = AuthService.verifyRecoveryToken(token);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: 'This recovery link is invalid or has expired.',
      });
    }

    // 2. Verify link status in PostgreSQL
    const linkRecord = await getValidRecoveryLink(token);
    if (!linkRecord) {
      return res.status(404).json({
        success: false,
        message: 'This payment recovery link has already been used or is no longer valid.',
      });
    }

    const { transaction, customer } = linkRecord;

    return res.status(200).json({
      success: true,
      data: {
        transactionId: transaction.id,
        amount: parseFloat(transaction.amount),
        currency: transaction.currency,
        customerName: customer.name,
        customerEmail: customer.email,
        paymentMethod: transaction.paymentMethod,
        failureReason: transaction.failureReason,
        status: transaction.status,
        expiresAt: linkRecord.recoveryLink.expiresAt,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Complete payment from Customer Recovery Page
 */
export async function completeRecoveryPayment(req, res, next) {
  try {
    const { token } = req.params;
    const { paymentMethod = 'card', razorpayPaymentId } = req.body || {};

    const decoded = AuthService.verifyRecoveryToken(token);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: 'This recovery link is invalid or has expired.',
      });
    }

    const linkRecord = await getValidRecoveryLink(token);
    if (!linkRecord) {
      return res.status(400).json({
        success: false,
        message: 'This recovery link has already been used or is expired.',
      });
    }

    const { transaction, customer } = linkRecord;

    // Mark link as used (single-use constraint)
    await markRecoveryLinkUsed(token);

    // Update transaction to 'recovered'
    await updateTransactionStatus(transaction.id, 'recovered', true);

    // Log completion message
    await createMessage({
      transactionId: transaction.id,
      eventTaken: 'resolved',
      channel: 'customer_portal',
      details: {
        resolvedBy: customer.email,
        paymentMethod,
        razorpayPaymentId: razorpayPaymentId || `pay_rec_${Date.now()}`,
        completedAt: new Date().toISOString(),
      },
    });

    console.log(`[Customer Recovery] Transaction ${transaction.id} successfully recovered by customer ${customer.email}!`);

    return res.status(200).json({
      success: true,
      message: 'Payment completed successfully. Your subscription / order has been reactivated.',
      transactionId: transaction.id,
      amount: parseFloat(transaction.amount),
      currency: transaction.currency,
      status: 'recovered',
    });
  } catch (error) {
    next(error);
  }
}
