import crypto from 'crypto';
import { EventProducerService } from '../../services/ingestion/event-producer.service.js';
import { getMerchantById } from '../../db/queries/merchants.queries.js';

/**
 * Verify Razorpay's `X-Razorpay-Signature` (hex HMAC-SHA256 of the RAW request body)
 * with the merchant's webhook secret, in constant time.
 */
export function verifyRazorpaySignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret || typeof signature !== 'string') {
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = Buffer.from(signature.trim(), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

const INVALID_WEBHOOK = { status: 'error', message: 'Invalid webhook signature' };

/**
 * POST /api/webhooks/razorpay/:merchantId
 *
 * Each merchant has its own endpoint and its own webhook secret. The signature is verified
 * BEFORE any event is parsed or persisted, and the resulting records are owned by that merchant.
 * Unknown merchants and bad signatures are indistinguishable to the caller.
 */
export async function handleRazorpayWebhook(req, res, next) {
  try {
    const { merchantId } = req.params;
    const signature = req.get('x-razorpay-signature');

    let merchant;
    try {
      merchant = await getMerchantById(merchantId);
    } catch (err) {
      console.error('[Webhook] Merchant lookup failed, rejecting event:', err.message);
      return res.status(503).json({ status: 'error', message: 'Webhook processing unavailable' });
    }

    if (!merchant || !verifyRazorpaySignature(req.rawBody, signature, merchant.webhookSecret)) {
      return res.status(401).json(INVALID_WEBHOOK);
    }

    if (merchant.status !== 'active') {
      return res.status(403).json({ status: 'error', message: 'Merchant account is suspended' });
    }

    const eventBody = req.body;
    console.log('[Webhook] Verified Razorpay webhook event:', eventBody?.event, 'merchant:', merchant.id);

    if (eventBody?.event === 'payment.failed') {
      const paymentEntity = eventBody.payload?.payment?.entity || {};

      const failedEvent = {
        merchantId: merchant.id,
        eventId: eventBody.id || `evt_${Date.now()}`,
        customer: {
          name: paymentEntity.notes?.customer_name || 'Customer',
          email: paymentEntity.email || 'customer@example.com',
          phone: paymentEntity.contact,
        },
        amount: (paymentEntity.amount || 0) / 100, // Convert paise to rupees
        currency: paymentEntity.currency || 'INR',
        paymentMethod: paymentEntity.method || 'card',
        failureReason: mapRazorpayErrorToFailureReason(paymentEntity.error_code, paymentEntity.error_reason),
        attemptCount: 1,
        metadata: {
          razorpayPaymentId: paymentEntity.id,
          razorpayOrderId: paymentEntity.order_id,
          rawError: paymentEntity.error_description,
        },
        idempotencyKey: paymentEntity.id || eventBody.id,
        timestamp: new Date().toISOString(),
      };

      const result = await EventProducerService.ingestAndPublishPaymentFailure(failedEvent);
      return res.status(200).json({ status: 'ok', processed: true, queued: true, result });
    }

    return res.status(200).json({ status: 'ignored', message: 'Event not handled' });
  } catch (error) {
    next(error);
  }
}

function mapRazorpayErrorToFailureReason(errorCode, errorReason) {
  const code = (errorCode || '').toLowerCase();
  const reason = (errorReason || '').toLowerCase();

  if (code.includes('insufficient') || reason.includes('insufficient')) {
    return 'insufficient_funds';
  }
  if (code.includes('expired') || reason.includes('expired')) {
    return 'card_expired';
  }
  if (code.includes('bank') || code.includes('outage') || reason.includes('downtime')) {
    return 'bank_outage';
  }
  if (code.includes('timeout') || reason.includes('timeout')) {
    return 'network_timeout';
  }
  if (code.includes('fraud') || reason.includes('risk')) {
    return 'high_risk_fraud';
  }
  return 'authentication_failed';
}
