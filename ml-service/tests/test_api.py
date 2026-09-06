import os
import sys
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["model_loaded"] is True
    assert "model_version" in data


def test_predict_valid_payload(client):
    payload = {
        "amount": 1499.0,
        "payment_method": "card",
        "failure_reason": "insufficient_funds",
        "attempt_count": 1,
        "days_since_failure": 2.0,
        "previous_successes": 8,
        "previous_failures": 1,
        "previous_recovery_success": True,
    }

    response = client.post("/predict", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert "probability" in data
    assert 0.0 <= data["probability"] <= 1.0
    assert "reason_codes" in data
    assert isinstance(data["reason_codes"], list)
    assert len(data["reason_codes"]) > 0
    assert data["model_version"] == "v1.0.0"
    assert "attributions" in data


def test_predict_invalid_payment_method(client):
    payload = {
        "amount": 1499.0,
        "payment_method": "crypto_token",
        "failure_reason": "insufficient_funds",
    }

    response = client.post("/predict", json=payload)
    assert response.status_code == 422
    data = response.json()
    assert data["error"] == "Validation Error"
    assert "details" in data


def test_predict_invalid_amount(client):
    payload = {
        "amount": -500.0,
        "payment_method": "card",
        "failure_reason": "insufficient_funds",
    }

    response = client.post("/predict", json=payload)
    assert response.status_code == 422
    data = response.json()
    assert data["error"] == "Validation Error"


def test_predict_missing_required_fields(client):
    payload = {
        "payment_method": "card"
    }

    response = client.post("/predict", json=payload)
    assert response.status_code == 422
    data = response.json()
    assert data["error"] == "Validation Error"


def test_predict_determinism(client):
    payload = {
        "amount": 3499.0,
        "payment_method": "upi",
        "failure_reason": "bank_outage",
        "attempt_count": 1,
        "days_since_failure": 0.0,
        "previous_successes": 15,
        "previous_failures": 0,
        "previous_recovery_success": True,
    }

    r1 = client.post("/predict", json=payload).json()
    r2 = client.post("/predict", json=payload).json()

    assert r1["probability"] == r2["probability"]
    assert r1["reason_codes"] == r2["reason_codes"]
