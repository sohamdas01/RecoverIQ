import os
import sys
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from main import app, get_ml_internal_token


VALID_INTERNAL_TOKEN = os.getenv("ML_INTERNAL_TOKEN", "recoveriq-internal-service-token-dev-secret")
AUTH_HEADERS = {"x-internal-service-token": VALID_INTERNAL_TOKEN}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_production_config_validation_rules(monkeypatch):
    # In development/test mode, fallback secret is valid
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("ML_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
    assert get_ml_internal_token() == "recoveriq-internal-service-token-dev-secret"

    # In production mode with missing token, raises RuntimeError
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setattr("main.IS_PRODUCTION", True)
    with pytest.raises(RuntimeError, match="must be explicitly set in production"):
        get_ml_internal_token()

    # In production mode with insecure default token, raises RuntimeError
    monkeypatch.setenv("ML_INTERNAL_TOKEN", "recoveriq-internal-service-token-dev-secret")
    with pytest.raises(RuntimeError, match="Insecure default internal token detected in production"):
        get_ml_internal_token()

    # In production mode with strong unique secret, succeeds
    monkeypatch.setenv("ML_INTERNAL_TOKEN", "prod_ml_secure_token_9x7y5z")
    assert get_ml_internal_token() == "prod_ml_secure_token_9x7y5z"

    # Reset environment
    monkeypatch.setattr("main.IS_PRODUCTION", False)
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("ML_INTERNAL_TOKEN", VALID_INTERNAL_TOKEN)


def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["model_loaded"] is True
    assert "model_version" in data


def test_health_probes_unauthenticated(client):
    # Liveness and readiness must remain accessible to monitoring/orchestrators without internal auth tokens
    live_res = client.get("/health/live")
    assert live_res.status_code == 200
    assert live_res.json()["status"] == "alive"

    ready_res = client.get("/health/ready")
    assert ready_res.status_code == 200
    assert ready_res.json()["status"] == "ready"


def test_predict_missing_token_unauthorized(client):
    payload = {
        "amount": 1499.0,
        "payment_method": "card",
        "failure_reason": "insufficient_funds",
    }
    # No headers -> must return 401
    response = client.post("/predict", json=payload)
    assert response.status_code == 401


def test_predict_invalid_token_forbidden(client):
    payload = {
        "amount": 1499.0,
        "payment_method": "card",
        "failure_reason": "insufficient_funds",
    }
    # Bad token -> must return 403
    response = client.post("/predict", json=payload, headers={"x-internal-service-token": "wrong-secret-token"})
    assert response.status_code == 403


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

    response = client.post("/predict", json=payload, headers=AUTH_HEADERS)
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

    response = client.post("/predict", json=payload, headers=AUTH_HEADERS)
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

    response = client.post("/predict", json=payload, headers=AUTH_HEADERS)
    assert response.status_code == 422
    data = response.json()
    assert data["error"] == "Validation Error"


def test_predict_missing_required_fields(client):
    payload = {
        "payment_method": "card"
    }

    response = client.post("/predict", json=payload, headers=AUTH_HEADERS)
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

    r1 = client.post("/predict", json=payload, headers=AUTH_HEADERS).json()
    r2 = client.post("/predict", json=payload, headers=AUTH_HEADERS).json()

    assert r1["probability"] == r2["probability"]
    assert r1["reason_codes"] == r2["reason_codes"]

