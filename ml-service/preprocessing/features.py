"""
RecoverIQ ML Service — Single Source of Truth Feature Preprocessing
-------------------------------------------------------------------
Shared across:
  1. Offline synthetic data generation & training
  2. Offline validation & evaluation metrics
  3. Real-time online inference endpoint (/predict)

Invariant:
  - Zero training-serving skew.
  - Strict category validation.
  - Deterministic feature column ordering.
"""

from typing import Dict, Any, List, Union
import numpy as np
import pandas as pd

# Supported categorical domains matching database schema & business rules
SUPPORTED_PAYMENT_METHODS: List[str] = [
    "card",
    "upi",
    "netbanking",
    "subscription_mandate",
]

SUPPORTED_FAILURE_REASONS: List[str] = [
    "insufficient_funds",
    "card_expired",
    "bank_outage",
    "network_timeout",
    "authentication_failed",
    "high_risk_fraud",
]

# Canonical list of ordered feature names generated for the XGBoost model
FEATURE_COLUMNS: List[str] = [
    "log_amount",
    "attempt_count",
    "days_since_failure",
    "previous_successes",
    "previous_failures",
    "previous_recovery_success",
    "is_subscription",
    "total_history",
    "historical_success_rate",
    "is_salary_window",
    "is_business_hours",
    "payment_method_card",
    "payment_method_upi",
    "payment_method_netbanking",
    "payment_method_subscription_mandate",
    "failure_reason_insufficient_funds",
    "failure_reason_card_expired",
    "failure_reason_bank_outage",
    "failure_reason_network_timeout",
    "failure_reason_authentication_failed",
    "failure_reason_high_risk_fraud",
]


def get_feature_names() -> List[str]:
    """Returns the ordered list of feature column names."""
    return list(FEATURE_COLUMNS)


def validate_raw_record(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validates and standardizes a single raw record.
    Raises ValueError with descriptive messages for invalid inputs.
    """
    if "amount" not in data or data["amount"] is None:
        raise ValueError("Missing required field: 'amount'")
    
    try:
        amount = float(data["amount"])
        if amount <= 0:
            raise ValueError(f"Invalid amount: {amount}. Amount must be positive.")
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid numeric value for amount: {e}")

    payment_method = str(data.get("payment_method", "")).lower().strip()
    if payment_method not in SUPPORTED_PAYMENT_METHODS:
        raise ValueError(
            f"Unsupported payment_method '{payment_method}'. Supported: {SUPPORTED_PAYMENT_METHODS}"
        )

    failure_reason = str(data.get("failure_reason", "")).lower().strip()
    if failure_reason not in SUPPORTED_FAILURE_REASONS:
        raise ValueError(
            f"Unsupported failure_reason '{failure_reason}'. Supported: {SUPPORTED_FAILURE_REASONS}"
        )

    try:
        attempt_count = int(data.get("attempt_count", 1))
        if attempt_count < 1:
            raise ValueError("attempt_count must be at least 1")
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid attempt_count: {e}")

    try:
        days_since_failure = float(data.get("days_since_failure", 0))
        if days_since_failure < 0:
            raise ValueError("days_since_failure cannot be negative")
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid days_since_failure: {e}")

    try:
        day_of_month = int(data.get("day_of_month", 15))
        if not (1 <= day_of_month <= 31):
            raise ValueError("day_of_month must be between 1 and 31")
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid day_of_month: {e}")

    try:
        hour_of_day = int(data.get("hour_of_day", 12))
        if not (0 <= hour_of_day <= 23):
            raise ValueError("hour_of_day must be between 0 and 23")
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid hour_of_day: {e}")

    try:
        prev_successes = int(data.get("previous_successes", 0))
        prev_failures = int(data.get("previous_failures", 0))
        if prev_successes < 0 or prev_failures < 0:
            raise ValueError("Historical payment counts cannot be negative")
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid previous payment counts: {e}")

    prev_recovery_success = bool(data.get("previous_recovery_success", False))
    is_subscription = bool(data.get("is_subscription", payment_method == "subscription_mandate"))

    return {
        "amount": amount,
        "payment_method": payment_method,
        "failure_reason": failure_reason,
        "attempt_count": attempt_count,
        "days_since_failure": days_since_failure,
        "day_of_month": day_of_month,
        "hour_of_day": hour_of_day,
        "previous_successes": prev_successes,
        "previous_failures": prev_failures,
        "previous_recovery_success": prev_recovery_success,
        "is_subscription": is_subscription,
    }


def extract_features_dict(clean_data: Dict[str, Any]) -> Dict[str, float]:
    """
    Transforms a single cleaned record dictionary into a dictionary of processed numerical features.
    """
    amount = float(clean_data["amount"])
    log_amount = float(np.log1p(amount))
    attempt_count = float(clean_data["attempt_count"])
    days_since_failure = float(clean_data["days_since_failure"])
    prev_successes = float(clean_data["previous_successes"])
    prev_failures = float(clean_data["previous_failures"])
    prev_recovery_success = 1.0 if clean_data["previous_recovery_success"] else 0.0
    is_subscription = 1.0 if clean_data["is_subscription"] else 0.0

    # Derived domain metrics
    total_history = prev_successes + prev_failures
    # Laplace smoothed historical success rate
    historical_success_rate = (prev_successes + 1.0) / (total_history + 2.0)

    # Salary window: Indian corporate salary cycles typically 28th - 5th
    dom = int(clean_data.get("day_of_month", 15))
    is_salary_window = 1.0 if (dom in [1, 2, 3, 4, 5, 27, 28, 29, 30, 31]) else 0.0

    # Business clearing hours: 09:00 - 18:00
    hod = int(clean_data.get("hour_of_day", 12))
    is_business_hours = 1.0 if (9 <= hod <= 18) else 0.0

    features: Dict[str, float] = {
        "log_amount": log_amount,
        "attempt_count": attempt_count,
        "days_since_failure": days_since_failure,
        "previous_successes": prev_successes,
        "previous_failures": prev_failures,
        "previous_recovery_success": prev_recovery_success,
        "is_subscription": is_subscription,
        "total_history": total_history,
        "historical_success_rate": historical_success_rate,
        "is_salary_window": is_salary_window,
        "is_business_hours": is_business_hours,
    }

    # One-hot encode payment methods
    for method in SUPPORTED_PAYMENT_METHODS:
        col_name = f"payment_method_{method}"
        features[col_name] = 1.0 if clean_data["payment_method"] == method else 0.0

    # One-hot encode failure reasons
    for reason in SUPPORTED_FAILURE_REASONS:
        col_name = f"failure_reason_{reason}"
        features[col_name] = 1.0 if clean_data["failure_reason"] == reason else 0.0

    return features


def preprocess_single_record(data: Dict[str, Any]) -> pd.DataFrame:
    """
    Processes a single raw dictionary for live inference.
    Returns a 1-row pandas DataFrame with exactly FEATURE_COLUMNS.
    """
    clean_data = validate_raw_record(data)
    feat_dict = extract_features_dict(clean_data)
    
    # Ensure exact column ordering
    row = [[feat_dict[col] for col in FEATURE_COLUMNS]]
    return pd.DataFrame(row, columns=FEATURE_COLUMNS)


def preprocess_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    Processes a batch pandas DataFrame for training / evaluation.
    Reuses the exact same feature extraction logic to guarantee zero skew.
    """
    rows = []
    for _, raw_row in df.iterrows():
        clean = validate_raw_record(raw_row.to_dict())
        feat_dict = extract_features_dict(clean)
        rows.append(feat_dict)
    
    processed_df = pd.DataFrame(rows)
    return processed_df[FEATURE_COLUMNS]
