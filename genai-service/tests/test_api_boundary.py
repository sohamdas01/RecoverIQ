"""
RecoverIQ GenAI Service - Service Boundary & Internal Token Security Tests
Phase 6 - Step 4: Service Boundary Hardening
"""

import os
import sys
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from main import app, get_genai_internal_token

VALID_INTERNAL_TOKEN = os.getenv("GENAI_INTERNAL_TOKEN", "recoveriq-internal-service-token-dev-secret")
AUTH_HEADERS = {"x-internal-service-token": VALID_INTERNAL_TOKEN}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_production_config_validation_rules(monkeypatch):
    # In development/test mode, fallback secret is valid
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("GENAI_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
    assert get_genai_internal_token() == "recoveriq-internal-service-token-dev-secret"

    # In production mode with missing token, raises RuntimeError
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setattr("main.IS_PRODUCTION", True)
    with pytest.raises(RuntimeError, match="must be explicitly set in production"):
        get_genai_internal_token()

    # In production mode with insecure default token, raises RuntimeError
    monkeypatch.setenv("GENAI_INTERNAL_TOKEN", "recoveriq-internal-service-token-dev-secret")
    with pytest.raises(RuntimeError, match="Insecure default internal token detected in production"):
        get_genai_internal_token()

    # In production mode with strong unique secret, succeeds
    monkeypatch.setenv("GENAI_INTERNAL_TOKEN", "prod_genai_secure_token_abc123xyz")
    assert get_genai_internal_token() == "prod_genai_secure_token_abc123xyz"

    # Reset environment
    monkeypatch.setattr("main.IS_PRODUCTION", False)
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("GENAI_INTERNAL_TOKEN", VALID_INTERNAL_TOKEN)


def test_health_probes_unauthenticated(client):
    """Health probes must remain accessible without internal auth tokens."""
    res_health = client.get("/health")
    assert res_health.status_code == 200
    assert res_health.json()["status"] == "healthy"

    res_live = client.get("/health/live")
    assert res_live.status_code == 200
    assert res_live.json()["status"] == "alive"

    res_ready = client.get("/health/ready")
    assert res_ready.status_code == 200
    assert res_ready.json()["status"] == "ready"


def test_analyst_missing_token_unauthorized(client):
    payload = {
        "transaction": {
            "id": "txn_sec_01",
            "amount": 1500.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "card_expired",
            "attemptCount": 1,
        }
    }
    res = client.post("/internal/recovery/analyze", json=payload)
    assert res.status_code == 401


def test_analyst_invalid_token_forbidden(client):
    payload = {
        "transaction": {
            "id": "txn_sec_02",
            "amount": 1500.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "card_expired",
            "attemptCount": 1,
        }
    }
    res = client.post(
        "/internal/recovery/analyze",
        json=payload,
        headers={"x-internal-service-token": "unauthorized_token"},
    )
    assert res.status_code == 403


def test_analyst_valid_token_success(client):
    payload = {
        "transaction": {
            "id": "txn_sec_03",
            "amount": 1500.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "card_expired",
            "attemptCount": 1,
        }
    }
    res = client.post("/internal/recovery/analyze", json=payload, headers=AUTH_HEADERS)
    assert res.status_code == 200
    data = res.json()
    assert data["recommendation"] == "send_recovery_message"
    assert data["confidence"] >= 0.80


def test_executor_missing_token_unauthorized(client):
    payload = {
        "transaction": {
            "id": "txn_sec_04",
            "amount": 1500.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "card_expired",
            "attemptCount": 1,
        },
        "agent1Recommendation": {
            "recommendation": "send_recovery_message",
            "confidence": 0.95,
            "reasonCodes": ["CARD_EXPIRED_UPDATE_REQUIRED"],
            "rationale": "Card expired.",
            "suggestedParameters": {"channel": "email"},
        },
    }
    res = client.post("/internal/recovery/plan", json=payload)
    assert res.status_code == 401


def test_executor_invalid_token_forbidden(client):
    payload = {
        "transaction": {
            "id": "txn_sec_05",
            "amount": 1500.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "card_expired",
            "attemptCount": 1,
        },
        "agent1Recommendation": {
            "recommendation": "send_recovery_message",
            "confidence": 0.95,
            "reasonCodes": ["CARD_EXPIRED_UPDATE_REQUIRED"],
            "rationale": "Card expired.",
            "suggestedParameters": {"channel": "email"},
        },
    }
    res = client.post(
        "/internal/recovery/plan",
        json=payload,
        headers={"x-internal-service-token": "bad_token_123"},
    )
    assert res.status_code == 403


def test_executor_valid_token_success(client):
    payload = {
        "transaction": {
            "id": "txn_sec_06",
            "amount": 1500.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "card_expired",
            "attemptCount": 1,
        },
        "agent1Recommendation": {
            "recommendation": "send_recovery_message",
            "confidence": 0.95,
            "reasonCodes": ["CARD_EXPIRED_UPDATE_REQUIRED"],
            "rationale": "Card expired.",
            "suggestedParameters": {"channel": "email"},
        },
    }
    res = client.post("/internal/recovery/plan", json=payload, headers=AUTH_HEADERS)
    assert res.status_code == 200
    data = res.json()
    assert data["proposedAction"] == "send_recovery_message"
    assert "parameters" in data


def test_legacy_analyze_token_enforcement(client):
    payload = {
        "transactionId": "txn_sec_07",
        "amount": 2500.0,
        "failureReason": "bank_outage",
    }
    # Missing token -> 401
    res_no_auth = client.post("/analyze", json=payload)
    assert res_no_auth.status_code == 401

    # Valid token via Bearer Authorization header -> 200
    res_bearer = client.post(
        "/analyze",
        json=payload,
        headers={"Authorization": f"Bearer {VALID_INTERNAL_TOKEN}"},
    )
    assert res_bearer.status_code == 200
    assert res_bearer.json()["action"] == "attempt_recovery"
