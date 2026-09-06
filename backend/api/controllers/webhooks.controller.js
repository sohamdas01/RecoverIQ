import { EventProducerService } from '../../services/ingestion/event-producer.service.js';

export async function handleRazorpayWebhook(req, res, next) {
  try {
    const eventBody = req.body;
    console.log('[Webhook] Received Razorpay webhook event:', eventBody?.event);

    if (eventBody?.event === 'payment.failed') {
      const paymentEntity = eventBody.payload?.payment?.entity || {};
      
      const failedEvent = {
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
