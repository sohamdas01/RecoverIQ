import axios from 'axios';
import { config } from '../config/index.js';

/**
 * Request recovery probability and SHAP reason codes from ML Service
 * Falls back to deterministic heuristics if ML service is unreachable.
 *
 * @param {Object} payload Feature dictionary for ML inference
 * @returns {Promise<Object>} ML prediction result with probability and reason_codes
 */
export async function getMLPrediction(payload) {
  try {
    const response = await axios.post(
      `${config.mlServiceUrl}/predict`,
      payload,
      { timeout: 3000 }
    );
    if (response.data && typeof response.data.probability === 'number') {
      return response.data;
    }
  } catch (err) {
    console.warn(`[ML Client] ML service unreachable (${err.message}). Using built-in baseline probability heuristics.`);
  }

  // Heuristic ML fallback in case ML service is offline
  const reason = payload.failure_reason;
  let fallbackProb = 0.72;
  let fallbackReasons = ['baseline_heuristic_estimate'];

  if (reason === 'high_risk_fraud') {
    fallbackProb = 0.05;
    fallbackReasons = ['high_risk_fraud_flagged'];
  } else if (reason === 'card_expired') {
    fallbackProb = 0.45;
    fallbackReasons = ['hard_decline_expired_card'];
  } else if (reason === 'bank_outage' || reason === 'network_timeout') {
    fallbackProb = 0.88;
    fallbackReasons = ['transient_infrastructure_glitch'];
  } else if (payload.previous_successes > 5) {
    fallbackProb = 0.82;
    fallbackReasons = ['strong_payment_history'];
  }

  return {
    probability: fallbackProb,
    reason_codes: fallbackReasons,
    model_version: 'v1.0.0-fallback',
    attributions: [],
  };
}
