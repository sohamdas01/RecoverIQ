"""
RecoverIQ ML Service — SHAP Explainability & Reason Code Generator
------------------------------------------------------------------
Translates raw TreeExplainer SHAP values into human-readable domain reason codes.
Preserves both:
  1. Top high-level reason codes (e.g. "strong_payment_history", "low_retry_count")
  2. Granular feature attribution breakdown (impact: positive / negative, magnitude)
"""

import os
import sys
from typing import Dict, Any, List, Tuple
import numpy as np
import pandas as pd
import shap
import joblib

# Add parent directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from preprocessing.features import FEATURE_COLUMNS, get_feature_names


class RecoverySHAPExplainer:
    def __init__(self, model_or_path: Any = None):
        """
        Initializes SHAP TreeExplainer with either a model instance or path to model.joblib.
        """
        if isinstance(model_or_path, str):
            self.model = joblib.load(model_or_path)
        elif model_or_path is not None:
            self.model = model_or_path
        else:
            default_path = os.path.join(
                os.path.dirname(__file__), "..", "artifacts", "model.joblib"
            )
            if not os.path.exists(default_path):
                raise FileNotFoundError(f"Model artifact not found at {default_path}")
            self.model = joblib.load(default_path)

        # Initialize TreeExplainer
        self.explainer = shap.TreeExplainer(self.model)

    def explain_prediction(
        self,
        X_df: pd.DataFrame,
        top_k: int = 4
    ) -> Tuple[float, List[str], List[Dict[str, Any]]]:
        """
        Calculates recovery probability and maps SHAP values to structured reason codes.

        Returns:
          - probability (float)
          - top_reason_codes (List[str])
          - detailed_attributions (List[Dict[str, Any]])
        """
        if X_df.shape[0] != 1:
            raise ValueError("explain_prediction expects a single-row DataFrame (shape (1, N))")

        # 1. Predict recovery probability
        prob = float(self.model.predict_proba(X_df)[0, 1])

        # 2. Compute SHAP values
        raw_shap = self.explainer.shap_values(X_df)
        if isinstance(raw_shap, list):
            # For some xgboost wrappers, shap_values returns [class_0, class_1]
            shap_vec = raw_shap[1][0]
        elif len(raw_shap.shape) == 2:
            shap_vec = raw_shap[0]
        else:
            shap_vec = raw_shap

        # 3. Map SHAP values to Reason Codes
        attributions = []
        for feat_name, shap_val in zip(FEATURE_COLUMNS, shap_vec):
            feat_val = float(X_df[feat_name].iloc[0])
            code, desc, impact = self._map_feature_to_reason_code(feat_name, feat_val, float(shap_val))
            if code is not None:
                attributions.append({
                    "feature": feat_name,
                    "code": code,
                    "description": desc,
                    "impact": impact,
                    "shap_value": round(float(shap_val), 4),
                    "abs_magnitude": abs(float(shap_val)),
                    "feature_value": feat_val,
                })

        # Sort by absolute SHAP magnitude (most influential features first)
        attributions.sort(key=lambda x: x["abs_magnitude"], reverse=True)

        # Extract top unique reason codes
        seen_codes = set()
        top_reason_codes: List[str] = []
        for attr in attributions:
            if attr["code"] not in seen_codes:
                seen_codes.add(attr["code"])
                top_reason_codes.append(attr["code"])
                if len(top_reason_codes) >= top_k:
                    break

        return round(prob, 4), top_reason_codes, attributions

    @staticmethod
    def _map_feature_to_reason_code(
        feat_name: str,
        feat_val: float,
        shap_val: float
    ) -> Tuple[str, str, str]:
        """
        Maps a specific feature, its value, and its SHAP contribution into a domain reason code.
        """
        is_positive = shap_val >= 0
        impact = "positive" if is_positive else "negative"

        # Failure Reason features
        if feat_name == "failure_reason_bank_outage" and feat_val == 1.0:
            return (
                "transient_bank_outage",
                "Transient bank infrastructure glitch; high probability of recovery once normalized",
                impact,
            )
        if feat_name == "failure_reason_network_timeout" and feat_val == 1.0:
            return (
                "transient_network_timeout",
                "Transient gateway socket timeout; immediate retry capture is favorable",
                impact,
            )
        if feat_name == "failure_reason_card_expired" and feat_val == 1.0:
            return (
                "hard_decline_expired_card",
                "Card is expired; direct payment gateway retries will fail without customer update",
                impact,
            )
        if feat_name == "failure_reason_high_risk_fraud" and feat_val == 1.0:
            return (
                "high_risk_fraud_flagged",
                "Suspected fraud indicators flagged; extremely low recovery feasibility",
                impact,
            )
        if feat_name == "failure_reason_authentication_failed" and feat_val == 1.0:
            return (
                "authentication_friction",
                "Customer 3DS / OTP challenge failed; customer re-authentication required",
                impact,
            )
        if feat_name == "failure_reason_insufficient_funds" and feat_val == 1.0:
            if is_positive:
                return (
                    "insufficient_funds_favorable_timing",
                    "Insufficient funds failure timed well with salary deposit window",
                    impact,
                )
            else:
                return (
                    "insufficient_funds_off_cycle",
                    "Insufficient funds decline outside standard salary clearing cycle",
                    impact,
                )

        # Historical customer performance
        if feat_name in ["historical_success_rate", "previous_successes", "total_history"]:
            if is_positive:
                return (
                    "strong_payment_history",
                    "Customer has a solid historical record of successful payments",
                    impact,
                )
            else:
                return (
                    "poor_payment_history",
                    "Customer has multiple historical failed payment attempts",
                    impact,
                )

        # Retry attempt count
        if feat_name == "attempt_count":
            if is_positive and feat_val <= 2:
                return (
                    "low_retry_count",
                    "Early retry attempt with high marginal recovery chance",
                    impact,
                )
            elif not is_positive and feat_val >= 3:
                return (
                    "retry_attempts_exhausted",
                    f"Repeated decline after {int(feat_val)} automated attempts",
                    impact,
                )

        # Salary window & business hours
        if feat_name == "is_salary_window" and feat_val == 1.0 and is_positive:
            return (
                "salary_window_active",
                "Payment scheduled within month-end / month-start salary disbursement window",
                impact,
            )
        if feat_name == "is_business_hours" and feat_val == 1.0 and is_positive:
            return (
                "business_hours_window",
                "Attempt aligned with active banking clearing hours (09:00 - 18:00)",
                impact,
            )

        # Prior recovery history
        if feat_name == "previous_recovery_success" and feat_val == 1.0 and is_positive:
            return (
                "prior_recovery_success",
                "Customer has successfully completed a recovery flow in the past",
                impact,
            )

        # Subscription mandate
        if feat_name == "is_subscription" and feat_val == 1.0 and is_positive:
            return (
                "active_subscription_intent",
                "Recurring subscription mandate provides strong customer intent",
                impact,
            )

        # Ticket size / Amount
        if feat_name == "log_amount":
            if is_positive:
                return (
                    "low_ticket_size",
                    "Low transaction value reduces authorization and balance friction",
                    impact,
                )
            else:
                return (
                    "high_ticket_friction",
                    "High transaction amount increases risk and balance constraints",
                    impact,
                )

        # Payment method
        if feat_name == "payment_method_upi" and feat_val == 1.0:
            return (
                "frictionless_upi_channel",
                "Instant UPI rails provide seamless authorization retry",
                impact,
            )

        return None, None, None
