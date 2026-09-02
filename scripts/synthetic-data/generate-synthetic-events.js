import axios from 'axios';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

const SYNTHETIC_SCENARIOS = [
  {
    customerName: 'Priya Sharma',
    customerEmail: 'priya.sharma@example.com',
    amount: 1499.00,
    currency: 'INR',
    paymentMethod: 'card',
    failureReason: 'insufficient_funds',
    attemptCount: 1,
  },
  {
    customerName: 'Aarav Patel',
    customerEmail: 'aarav.patel@techcorp.in',
    amount: 2999.00,
    currency: 'INR',
    paymentMethod: 'card',
    failureReason: 'card_expired',
    attemptCount: 1,
  },
  {
    customerName: 'Vikram Mehta',
    customerEmail: 'vikram.mehta@enterprise.org',
    amount: 8500.00,
    currency: 'INR',
    paymentMethod: 'upi',
    failureReason: 'bank_outage',
    attemptCount: 1,
  },
  {
    customerName: 'Neha Gupta',
    customerEmail: 'neha.gupta@fintech.io',
    amount: 12000.00,
    currency: 'INR',
    paymentMethod: 'subscription_mandate',
    failureReason: 'network_timeout',
    attemptCount: 1,
  },
  {
    customerName: 'Rahul Kapoor',
    customerEmail: 'rahul.k@startup.com',
    amount: 75000.00, // Exceeds auto approval amount (₹50k) -> Triggers REQUIRE_APPROVAL
    currency: 'INR',
    paymentMethod: 'card',
    failureReason: 'insufficient_funds',
    attemptCount: 1,
  },
  {
    customerName: 'Fraud Suspect',
    customerEmail: 'temp_suspicious_user_44@disposable.com',
    amount: 125000.00,
    currency: 'INR',
    paymentMethod: 'card',
    failureReason: 'high_risk_fraud',
    attemptCount: 1,
  }
];

async function runSyntheticGenerator() {
  console.log(`[Synthetic Generator] Starting batch simulation to ${BACKEND_URL}/api/simulate/purchase ...\n`);

  for (const scenario of SYNTHETIC_SCENARIOS) {
    try {
      console.log(`-> Sending failure event: ${scenario.customerName} (${scenario.failureReason}, ₹${scenario.amount})`);
      const response = await axios.post(`${BACKEND_URL}/api/simulate/purchase`, scenario);
      
      const { transaction, decision, guardrail, executionResult } = response.data.data;
      console.log(`   Result: Guardrail=${guardrail.decision} | Action=${decision.recommendedAction} | Status=${decision.status}`);
      if (executionResult?.output?.recoveryUrl) {
        console.log(`   Customer Recovery URL: ${executionResult.output.recoveryUrl}`);
      }
      console.log('');
    } catch (err) {
      console.error(`   Failed to send scenario:`, err.response?.data || err.message);
    }
  }

  console.log('[Synthetic Generator] Batch simulation finished successfully.');
}

runSyntheticGenerator();
