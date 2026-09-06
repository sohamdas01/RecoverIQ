import os
import json
import pytest
import joblib
import pandas as pd
import numpy as np
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from preprocessing.features import preprocess_single_record, FEATURE_COLUMNS


def test_model_artifact_and_metadata():
    artifacts_dir = os.path.join(os.path.dirname(__file__), "..", "artifacts")
    model_path = os.path.join(artifacts_dir, "model.joblib")
    metadata_path = os.path.join(artifacts_dir, "metadata.json")
    eval_report_path = os.path.join(artifacts_dir, "evaluation_report.json")

    assert os.path.exists(model_path), "model.joblib must exist"
    assert os.path.exists(metadata_path), "metadata.json must exist"
    assert os.path.exists(eval_report_path), "evaluation_report.json must exist"

    # Test metadata
    with open(metadata_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    assert meta["model_version"] == "v1.0.0"
    assert meta["feature_names"] == FEATURE_COLUMNS
    assert meta["validation_metrics"]["roc_auc"] > 0.70

    # Test model loading & prediction
    model = joblib.load(model_path)
    sample_record = {
        "amount": 2500.0,
        "payment_method": "upi",
        "failure_reason": "bank_outage",
        "attempt_count": 1,
        "days_since_failure": 0,
        "day_of_month": 1,
        "hour_of_day": 11,
        "previous_successes": 10,
        "previous_failures": 1,
        "previous_recovery_success": True,
    }
    input_df = preprocess_single_record(sample_record)
    prob = float(model.predict_proba(input_df)[0, 1])

    assert 0.0 <= prob <= 1.0
    # Bank outage with strong history should have high recovery probability
    assert prob > 0.70
