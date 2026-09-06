import { EventProducerService } from '../../services/ingestion/event-producer.service.js';

export async function simulatePurchaseFailure(req, res, next) {
  try {
    const {
      customerName = 'Priya Sharma',
      customerEmail = 'priya.sharma@example.com',
      amount = 4999.00,
      currency = 'INR',
      paymentMethod = 'card',
      failureReason = 'insufficient_funds',
      attemptCount = 1,
    } = req.body || {};

    const event = {
      eventId: `sim_${Date.now()}`,
      customer: {
        name: customerName,
        email: customerEmail,
      },
      amount: Number(amount),
      currency,
      paymentMethod,
      failureReason,
      attemptCount: Number(attemptCount),
      metadata: { simulated: true, trigger: 'simulate_purchase_page' },
      timestamp: new Date().toISOString(),
    };

    const result = await EventProducerService.ingestAndPublishPaymentFailure(event);

    return res.status(200).json({
      success: true,
      message: 'Simulated purchase failure published to Kafka queue for event-driven processing',
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function simulateBatchFailures(req, res, next) {
  try {
    const scenarios = [
      {
        customerName: 'Aarav Patel',
        customerEmail: 'aarav.patel@techcorp.in',
        amount: 2499.00,
        paymentMethod: 'card',
        failureReason: 'card_expired',
        attemptCount: 1,
      },
      {
        customerName: 'Ananya Iyer',
        customerEmail: 'ananya.iyer@gmail.com',
        amount: 7999.00,
        paymentMethod: 'upi',
        failureReason: 'bank_outage',
        attemptCount: 1,
      },
      {
        customerName: 'Rohan Verma',
        customerEmail: 'rohan.verma@fintech.co',
        amount: 14999.00,
        paymentMethod: 'subscription_mandate',
        failureReason: 'insufficient_funds',
        attemptCount: 3,
      },
      {
        customerName: 'Devika Nair',
        customerEmail: 'devika.nair@startup.io',
        amount: 65000.00,
        paymentMethod: 'card',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      },
      {
        customerName: 'Unknown User',
        customerEmail: 'flagged_user_99@tempmail.com',
        amount: 99999.00,
        paymentMethod: 'card',
        failureReason: 'high_risk_fraud',
        attemptCount: 1,
      }
    ];

    const results = [];
    for (const item of scenarios) {
      const event = {
        eventId: `batch_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        customer: { name: item.customerName, email: item.customerEmail },
        amount: item.amount,
        currency: 'INR',
        paymentMethod: item.paymentMethod,
        failureReason: item.failureReason,
        attemptCount: item.attemptCount,
        metadata: { simulated: true, trigger: 'batch_generator' },
        timestamp: new Date().toISOString(),
      };
      const resItem = await EventProducerService.ingestAndPublishPaymentFailure(event);
      results.push(resItem);
    }

    return res.status(200).json({
      success: true,
      processedCount: results.length,
      queuedCount: results.length,
      data: results,
    });
  } catch (error) {
    next(error);
  }
}
