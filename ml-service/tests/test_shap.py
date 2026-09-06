import os
import sys
import pytest
import pandas as pd
import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from preprocessing.features import preprocess_single_record
from explainability.shap_explainer import RecoverySHAPExplainer


@pytest.fixture
def explainer():
    return RecoverySHAPExplainer()


def test_shap_explanation_bank_outage(explainer):
    record = {
        "amount": 1499.0,
        "payment_method": "upi",
        "failure_reason": "bank_outage",
        "attempt_count": 1,
        "days_since_failure": 0,
        "day_of_month": 1,
        "hour_of_day": 11,
        "previous_successes": 12,
        "previous_failures": 0,
        "previous_recovery_success": True,
    }

    df = preprocess_single_record(record)
    prob, reason_codes, attributions = explainer.explain_prediction(df, top_k=3)

    assert 0.0 <= prob <= 1.0
    assert prob > 0.75, "Transient bank outage with high loyalty should have high recovery probability"
    assert isinstance(reason_codes, list)
    assert len(reason_codes) >= 1

    # Check reason codes contains expected positive drivers
    assert any(code in ["transient_bank_outage", "strong_payment_history", "low_retry_count", "frictionless_upi_channel"] for code in reason_codes)

    # Detailed attributions test
    assert len(attributions) > 0
    top_attr = attributions[0]
    assert "feature" in top_attr
    assert "impact" in top_attr
    assert top_attr["impact"] in ["positive", "negative"]


def test_shap_explanation_fraud_flag(explainer):
    record = {
        "amount": 95000.0,
        "payment_method": "card",
        "failure_reason": "high_risk_fraud",
        "attempt_count": 2,
        "days_since_failure": 3,
        "day_of_month": 12,
        "hour_of_day": 3,
        "previous_successes": 0,
        "previous_failures": 4,
        "previous_recovery_success": False,
    }

    df = preprocess_single_record(record)
    prob, reason_codes, attributions = explainer.explain_prediction(df, top_k=3)

    assert prob < 0.25, "High-risk fraud with poor history should have very low recovery probability"
    assert "high_risk_fraud_flagged" in reason_codes


def test_shap_explanation_expired_card(explainer):
    record = {
        "amount": 2999.0,
        "payment_method": "card",
        "failure_reason": "card_expired",
        "attempt_count": 1,
        "days_since_failure": 1,
        "day_of_month": 15,
        "hour_of_day": 14,
        "previous_successes": 2,
        "previous_failures": 1,
        "previous_recovery_success": False,
    }

    df = preprocess_single_record(record)
    prob, reason_codes, attributions = explainer.explain_prediction(df, top_k=3)

    assert "hard_decline_expired_card" in reason_codes


def test_shap_determinism(explainer):
    record = {
        "amount": 4999.0,
        "payment_method": "subscription_mandate",
        "failure_reason": "insufficient_funds",
        "attempt_count": 1,
        "days_since_failure": 0,
        "day_of_month": 1,
        "hour_of_day": 10,
        "previous_successes": 5,
        "previous_failures": 1,
        "previous_recovery_success": True,
    }

    df1 = preprocess_single_record(record)
    prob1, codes1, _ = explainer.explain_prediction(df1)

    df2 = preprocess_single_record(record)
    prob2, codes2, _ = explainer.explain_prediction(df2)

    assert prob1 == prob2
    assert codes1 == codes2
