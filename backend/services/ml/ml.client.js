import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from '../logger/index.js';
import { metrics, classifyError } from '../metrics/index.js';
import { withSpan, injectTraceContext } from '../observability/tracing.service.js';
import { SpanKind } from '@opentelemetry/api';

const mlLogger = logger.withComponent('ml_client');

/**
 * Request recovery probability and SHAP reason codes from ML Service
 * Falls back to deterministic heuristics if ML service is unreachable.
 *
 * @param {Object} payload Feature dictionary for ML inference
 * @returns {Promise<Object>} ML prediction result with probability and reason_codes
 */
export async function getMLPrediction(payload) {
  const startTime = Date.now();
  try {
    const result = await withSpan('ml.inference', {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.method': 'POST',
        'http.route': '/predict',
        'service.target': 'ml-service',
        'peer.service': 'recoveriq-ml-service',
        'component': 'ml_client',
      },
    }, async (span) => {
      const headers = {
        'x-internal-service-token': config.mlInternalToken,
      };
      injectTraceContext(headers);

      const response = await axios.post(
        `${config.mlServiceUrl}/predict`,
        payload,
        { timeout: 3000, headers }
      );
      const durationMs = Date.now() - startTime;
      if (response.data && typeof response.data.probability === 'number') {
        span.setAttribute('ml.model_version', response.data.model_version || 'v1.0.0');
        span.setAttribute('ml.is_fallback', false);
        metrics.recordMLPrediction(false, durationMs / 1000);
        mlLogger.info('ml_prediction_completed', {
          durationMs,
          probability: response.data.probability,
          modelVersion: response.data.model_version || 'v1.0.0',
          reasonCodes: response.data.reason_codes || [],
          isFallback: false,
        });
        return response.data;
      }
      return null;
    });

    if (result) return result;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorType = classifyError(err);
    metrics.recordMLPrediction(true, durationMs / 1000);
    metrics.recordMLFailure(errorType);
    mlLogger.warn('ml_prediction_fallback', {
      durationMs,
      error: err.message,
      errorType,
      isFallback: true,
    });
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
