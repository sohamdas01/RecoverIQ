import pytest
import numpy as np
import pandas as pd
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from preprocessing.features import (
    FEATURE_COLUMNS,
    SUPPORTED_PAYMENT_METHODS,
    SUPPORTED_FAILURE_REASONS,
    validate_raw_record,
    extract_features_dict,
    preprocess_single_record,
    preprocess_dataframe,
)


def test_valid_single_record_preprocessing():
    record = {
        "amount": 1499.0,
        "payment_method": "card",
        "failure_reason": "insufficient_funds",
        "attempt_count": 1,
        "days_since_failure": 2.0,
        "day_of_month": 1,
        "hour_of_day": 10,
        "previous_successes": 8,
        "previous_failures": 1,
        "previous_recovery_success": True,
        "is_subscription": True,
    }

    df = preprocess_single_record(record)
    assert isinstance(df, pd.DataFrame)
    assert df.shape == (1, len(FEATURE_COLUMNS))
    assert list(df.columns) == FEATURE_COLUMNS

    # Numerical invariants
    assert np.isclose(df["log_amount"].iloc[0], np.log1p(1499.0))
    assert df["attempt_count"].iloc[0] == 1.0
    assert df["days_since_failure"].iloc[0] == 2.0
    assert df["previous_successes"].iloc[0] == 8.0
    assert df["previous_failures"].iloc[0] == 1.0
    assert df["previous_recovery_success"].iloc[0] == 1.0
    assert df["is_subscription"].iloc[0] == 1.0
    assert df["total_history"].iloc[0] == 9.0
    assert df["is_salary_window"].iloc[0] == 1.0
    assert df["is_business_hours"].iloc[0] == 1.0

    # Categorical one-hot checks
    assert df["payment_method_card"].iloc[0] == 1.0
    assert df["payment_method_upi"].iloc[0] == 0.0
    assert df["failure_reason_insufficient_funds"].iloc[0] == 1.0
    assert df["failure_reason_card_expired"].iloc[0] == 0.0


def test_training_serving_consistency():
    """Verify that batch DataFrame preprocessing produces identical results to single record preprocessing."""
    raw_records = [
        {
            "amount": 1499.0,
            "payment_method": "card",
            "failure_reason": "insufficient_funds",
            "attempt_count": 1,
            "days_since_failure": 1,
            "day_of_month": 2,
            "hour_of_day": 14,
            "previous_successes": 5,
            "previous_failures": 0,
            "previous_recovery_success": False,
        },
        {
            "amount": 8500.0,
            "payment_method": "upi",
            "failure_reason": "bank_outage",
            "attempt_count": 2,
            "days_since_failure": 0,
            "day_of_month": 15,
            "hour_of_day": 20,
            "previous_successes": 12,
            "previous_failures": 2,
            "previous_recovery_success": True,
        },
    ]

    # Preprocess via batch DataFrame
    batch_df = preprocess_dataframe(pd.DataFrame(raw_records))

    # Preprocess each record individually
    single_dfs = [preprocess_single_record(r) for r in raw_records]
    combined_single_df = pd.concat(single_dfs, ignore_index=True)

    pd.testing.assert_frame_equal(batch_df, combined_single_df)


def test_validation_errors():
    # Missing amount
    with pytest.raises(ValueError, match="Missing required field: 'amount'"):
        validate_raw_record({"payment_method": "card", "failure_reason": "bank_outage"})

    # Negative amount
    with pytest.raises(ValueError, match="Amount must be positive"):
        validate_raw_record({"amount": -100, "payment_method": "card", "failure_reason": "bank_outage"})

    # Unsupported payment method
    with pytest.raises(ValueError, match="Unsupported payment_method"):
        validate_raw_record({"amount": 100, "payment_method": "bitcoin", "failure_reason": "bank_outage"})

    # Unsupported failure reason
    with pytest.raises(ValueError, match="Unsupported failure_reason"):
        validate_raw_record({"amount": 100, "payment_method": "card", "failure_reason": "solar_flare"})
