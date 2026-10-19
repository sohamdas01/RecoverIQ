"""
Tests for Ask RecoverIQ Grounded Engine & Internal API
Phase 7 - Step 6: Ask RecoverIQ
"""

import pytest
from fastapi.testclient import TestClient
from main import app, GENAI_INTERNAL_TOKEN
from agents.ask_engine import AskRecoverIQEngine
from agents.schemas import AskRecoverIQInput


client = TestClient(app)
AUTH_HEADERS = {"x-internal-service-token": GENAI_INTERNAL_TOKEN}


def test_ask_engine_grounded_block_question():
    engine = AskRecoverIQEngine()
    payload = AskRecoverIQInput(
        question="Why was this case blocked?",
        caseId="case-101",
        evidence=[
            {
                "caseId": "case-101",
                "stage": "6_policy",
                "ruleId": "RULE_VELOCITY_LIMIT",
                "policyDecision": "BLOCK",
                "detail": "Velocity limit exceeded: 4 attempts in 10 minutes",
                "timestamp": "2026-09-13T10:00:00Z"
            }
        ]
    )
    result = engine.answer(payload)
    assert result.isGrounded is True
    assert "RULE_VELOCITY_LIMIT" in result.answer
    assert "Velocity limit exceeded" in result.answer
    assert len(result.evidence) == 1
    assert result.evidence[0].ruleId == "RULE_VELOCITY_LIMIT"


def test_ask_engine_grounded_approval_question():
    engine = AskRecoverIQEngine()
    payload = AskRecoverIQInput(
        question="Why did this case require approval?",
        caseId="case-102",
        evidence=[
            {
                "caseId": "case-102",
                "stage": "6_policy",
                "ruleId": "RULE_HIGH_VALUE_THRESHOLD",
                "policyDecision": "REQUIRE_APPROVAL",
                "detail": "Amount $750.00 exceeds auto-recovery limit of $500.00",
                "timestamp": "2026-09-13T10:05:00Z"
            }
        ]
    )
    result = engine.answer(payload)
    assert result.isGrounded is True
    assert "RULE_HIGH_VALUE_THRESHOLD" in result.answer
    assert "Human-in-the-Loop" in result.answer or "approval" in result.answer.lower()
    assert len(result.evidence) == 1


def test_ask_engine_grounded_agent1_question():
    engine = AskRecoverIQEngine()
    payload = AskRecoverIQInput(
        question="What did Agent 1 recommend?",
        caseId="case-103",
        evidence=[
            {
                "caseId": "case-103",
                "stage": "3_agent1_analysis",
                "action": "smart_retry",
                "detail": "Confidence 0.88 with 30-minute delay due to temporary bank outage",
                "timestamp": "2026-09-13T10:10:00Z"
            }
        ]
    )
    result = engine.answer(payload)
    assert result.isGrounded is True
    assert "smart_retry" in result.answer
    assert len(result.evidence) == 1


def test_ask_engine_grounded_playbook_question():
    engine = AskRecoverIQEngine()
    payload = AskRecoverIQInput(
        question="Which playbook was retrieved?",
        caseId="case-104",
        evidence=[
            {
                "caseId": "case-104",
                "stage": "4_rag_playbook",
                "playbookId": "PB-INSUFFICIENT-FUNDS-01",
                "detail": "Delay retry by 4 hours; offer payment switch link",
                "timestamp": "2026-09-13T10:15:00Z"
            }
        ]
    )
    result = engine.answer(payload)
    assert result.isGrounded is True
    assert "PB-INSUFFICIENT-FUNDS-01" in result.answer
    assert len(result.evidence) == 1
    assert result.evidence[0].playbookId == "PB-INSUFFICIENT-FUNDS-01"


def test_ask_engine_grounded_agent2_question():
    engine = AskRecoverIQEngine()
    payload = AskRecoverIQInput(
        question="What action did Agent 2 propose?",
        caseId="case-105",
        evidence=[
            {
                "caseId": "case-105",
                "stage": "5_agent2_plan",
                "action": "smart_retry",
                "detail": "delaySeconds: 1800, maxAttempts: 2, routingStrategy: fallback_gateway",
                "timestamp": "2026-09-13T10:20:00Z"
            }
        ]
    )
    result = engine.answer(payload)
    assert result.isGrounded is True
    assert "smart_retry" in result.answer
    assert "delaySeconds" in result.answer or "1800" in result.answer


def test_ask_engine_empty_evidence_fallback():
    engine = AskRecoverIQEngine()
    payload = AskRecoverIQInput(
        question="Why was this case blocked?",
        caseId="case-999",
        evidence=[]
    )
    result = engine.answer(payload)
    assert result.isGrounded is False
    assert "not available" in result.answer.lower()
    assert len(result.evidence) == 0


def test_ask_recoveriq_internal_endpoint_auth():
    # Unauthorized request without token
    res_no_auth = client.post("/internal/ask", json={"question": "Why blocked?"})
    assert res_no_auth.status_code == 401

    # Authorized request
    res_auth = client.post(
        "/internal/ask",
        headers=AUTH_HEADERS,
        json={
            "question": "Why was this case blocked?",
            "caseId": "case-101",
            "evidence": [
                {
                    "caseId": "case-101",
                    "stage": "6_policy",
                    "ruleId": "RULE_VELOCITY_LIMIT",
                    "policyDecision": "BLOCK",
                    "detail": "Velocity limit exceeded: 4 attempts in 10 minutes",
                    "timestamp": "2026-09-13T10:00:00Z"
                }
            ]
        }
    )
    assert res_auth.status_code == 200
    data = res_auth.json()
    assert data["isGrounded"] is True
    assert "RULE_VELOCITY_LIMIT" in data["answer"]
    assert len(data["evidence"]) == 1
