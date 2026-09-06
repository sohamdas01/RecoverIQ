"""
Tests for Agent 2: Recovery Executor / Action Planner
Phase 5 - Step 3: Agent 2 Recovery Executor
"""

import pytest
import asyncio
from pydantic import ValidationError

from agents.schemas import (
    RecoveryActionEnum,
    RecoveryExecutorInput,
    RecoveryExecutorOutput,
    RecoveryAnalystOutput,
    validate_action_parameters,
    AttemptRecoveryParams,
    SendRecoveryMessageParams,
    ScheduleRetryParams,
    EscalateToHumanParams,
)
from agents.recovery_executor import RecoveryExecutorAgent


@pytest.fixture
def executor():
    return RecoveryExecutorAgent()


def test_executor_input_validation():
    valid_input = {
        "transaction": {
            "id": "txn_exec_01",
            "amount": 3500.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "network_timeout",
            "attemptCount": 1,
        },
        "agent1Recommendation": {
            "recommendation": "attempt_recovery",
            "confidence": 0.90,
            "reasonCodes": ["TRANSIENT_GATEWAY_OUTAGE"],
            "rationale": "Transient network issue identified.",
            "suggestedParameters": {"paymentId": "pay_test_01"},
        },
    }
    inp = RecoveryExecutorInput.model_validate(valid_input)
    assert inp.transaction.amount == 3500.0
    assert inp.agent1Recommendation.recommendation == RecoveryActionEnum.ATTEMPT_RECOVERY


def test_executor_output_schema_validation():
    out = RecoveryExecutorOutput(
        proposedAction=RecoveryActionEnum.SEND_RECOVERY_MESSAGE,
        confidence=0.92,
        reasonCodes=["CARD_EXPIRED_CONFIRMED"],
        rationale="Sending self-service link to customer for card renewal.",
        parameters={"channel": "email", "templateId": "card_expired_v1"},
    )
    assert out.proposedAction == RecoveryActionEnum.SEND_RECOVERY_MESSAGE
    assert out.confidence == 0.92
    assert out.parameters["channel"] == "email"


def test_executor_invalid_action_rejected():
    with pytest.raises(ValidationError):
        RecoveryExecutorOutput(
            proposedAction="execute_arbitrary_script",  # Forbidden
            confidence=0.99,
            rationale="Attempting unauthorized operation.",
        )


def test_parameter_validation_schemas():
    # 1. attempt_recovery params
    p1 = validate_action_parameters(
        RecoveryActionEnum.ATTEMPT_RECOVERY,
        {"paymentId": "pay_123", "retryDelayMinutes": 10, "unauthorized_extra": "hack"}
    )
    assert p1["paymentId"] == "pay_123"
    assert p1["retryDelayMinutes"] == 10
    assert "unauthorized_extra" not in p1  # Stripped

    # 2. send_recovery_message params
    p2 = validate_action_parameters(
        RecoveryActionEnum.SEND_RECOVERY_MESSAGE,
        {"channel": "email", "templateId": "vip_card_renewal"}
    )
    assert p2["channel"] == "email"
    assert p2["templateId"] == "vip_card_renewal"

    # 3. schedule_retry params
    p3 = validate_action_parameters(
        RecoveryActionEnum.SCHEDULE_RETRY,
        {"delayHours": 6, "reason": "Banking morning settlement window"}
    )
    assert p3["delayHours"] == 6

    # 4. escalate_to_human params
    p4 = validate_action_parameters(
        RecoveryActionEnum.ESCALATE_TO_HUMAN,
        {"priority": "urgent", "reason": "Fraud suspected"}
    )
    assert p4["priority"] == "urgent"


def test_executor_card_expired_invariant_override(executor):
    # If Agent 1 mistakenly recommended attempt_recovery on an expired card:
    payload = {
        "transaction": {
            "id": "txn_override_1",
            "amount": 2500.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "card_expired",
            "attemptCount": 1,
        },
        "agent1Recommendation": {
            "recommendation": "attempt_recovery",  # Inappropriate for expired card
            "confidence": 0.60,
            "rationale": "Analyst mistakenly proposed direct retry.",
        },
    }
    res = asyncio.run(executor.plan(payload))
    # Executor must overrule to send_recovery_message
    assert res["proposedAction"] == "send_recovery_message"
    assert "CARD_EXPIRED_OVERRULE_RETRY" in res["reasonCodes"]
    assert res["parameters"]["channel"] == "email"


def test_executor_fraud_invariant_override(executor):
    payload = {
        "transaction": {
            "id": "txn_fraud_override",
            "amount": 10000.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "high_risk_fraud",
            "attemptCount": 1,
        },
        "agent1Recommendation": {
            "recommendation": "attempt_recovery",
            "confidence": 0.50,
            "rationale": "Retry recommended.",
        },
    }
    res = asyncio.run(executor.plan(payload))
    assert res["proposedAction"] == "escalate_to_human"
    assert "FRAUD_FLAG_ENFORCED" in res["reasonCodes"]
    assert res["parameters"]["priority"] == "urgent"


def test_executor_normal_flow_confirmation(executor):
    payload = {
        "transaction": {
            "id": "txn_normal_conf",
            "amount": 1200.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "bank_outage",
            "attemptCount": 1,
        },
        "agent1Recommendation": {
            "recommendation": "attempt_recovery",
            "confidence": 0.90,
            "reasonCodes": ["TRANSIENT_GATEWAY_OUTAGE"],
            "rationale": "Bank outage recovered.",
        },
    }
    res = asyncio.run(executor.plan(payload))
    assert res["proposedAction"] == "attempt_recovery"
    assert res["confidence"] == 0.90
    assert "paymentId" in res["parameters"]
    assert res["metadata"]["agentName"] == "RecoveryExecutor"


def test_executor_broken_model_adapter_fallback():
    async def broken_adapter(inp):
        return {"proposedAction": "unsupported_shell_exec", "confidence": 100}

    executor_with_broken_model = RecoveryExecutorAgent(model_adapter=broken_adapter)
    res = asyncio.run(executor_with_broken_model.plan({
        "transaction": {
            "id": "txn_broken",
            "amount": 500.0,
            "currency": "INR",
            "paymentMethod": "card",
            "failureReason": "network_timeout",
        },
        "agent1Recommendation": {
            "recommendation": "attempt_recovery",
            "confidence": 0.85,
            "rationale": "Retry proposed.",
        }
    }))

    assert res["proposedAction"] == "escalate_to_human"
    assert res["metadata"]["isFallback"] is True
