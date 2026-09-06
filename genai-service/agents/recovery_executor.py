"""
RecoverIQ GenAI Service - Agent 2 (Recovery Executor / Action Planner) Implementation
Phase 5 - Step 3: Agent 2 Recovery Executor
"""

import os
import json
import time
from typing import Dict, Any, Optional

from agents.schemas import (
    RecoveryExecutorInput,
    RecoveryExecutorOutput,
    RecoveryActionEnum,
    validate_action_parameters,
)
from prompts.recovery_executor import RECOVERY_EXECUTOR_SYSTEM_PROMPT


class RecoveryExecutorAgent:
    """
    Agent 2: Recovery Executor / Action Planner
    Takes Agent 1's analysis, context invariants, and ML signals to produce a
    concrete, parameter-validated Action Plan proposal for Policy Engine evaluation.
    """

    def __init__(self, model_adapter=None):
        self.api_key = os.getenv("OPENAI_API_KEY", "")
        self.model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        self.model_adapter = model_adapter  # Allows plugging mock adapters for tests

    async def plan(self, raw_input: Dict[str, Any]) -> Dict[str, Any]:
        """
        Main entry point for Agent 2 action planning.
        Strictly validates input schema, calls LLM or deterministic planner,
        enforces action parameter schemas, and returns Pydantic-validated output.
        """
        start_time = time.time()

        # 1. Validate Input Context using Pydantic
        try:
            if isinstance(raw_input, RecoveryExecutorInput):
                validated_input = raw_input
            else:
                validated_input = RecoveryExecutorInput.model_validate(raw_input)
        except Exception as e:
            # Fallback for invalid input: Safe human escalation
            latency_ms = int((time.time() - start_time) * 1000)
            return RecoveryExecutorOutput(
                proposedAction=RecoveryActionEnum.ESCALATE_TO_HUMAN,
                confidence=0.10,
                reasonCodes=["INVALID_EXECUTOR_INPUT_SCHEMA"],
                rationale=f"Invalid action planner input schema: {str(e)}",
                parameters={"priority": "high", "reason": "input_validation_failure"},
                metadata={
                    "agentName": "RecoveryExecutor",
                    "agentVersion": "v1.0",
                    "latencyMs": latency_ms,
                    "isFallback": True,
                },
            ).model_dump()

        # 2. Model Inference (Custom Adapter or LLM API or Deterministic Planner)
        raw_output = None

        if self.model_adapter is not None:
            raw_output = await self.model_adapter(validated_input)
        elif self.api_key and not self.api_key.startswith("sk-placeholder"):
            try:
                raw_output = await self._call_llm(validated_input)
            except Exception as err:
                print(f"[RecoveryExecutor] LLM call failed ({err}). Falling back to deterministic action planner.")
                raw_output = None

        if raw_output is None:
            raw_output = self._deterministic_action_planner(validated_input)

        # 3. Strict Machine Validation of Action & Parameters
        latency_ms = int((time.time() - start_time) * 1000)

        try:
            # If raw_output is dict, normalize fields
            if isinstance(raw_output, dict):
                action_val = raw_output.get("proposedAction") or raw_output.get("action")
                action_enum = RecoveryActionEnum(action_val)
                raw_params = raw_output.get("parameters") or raw_output.get("toolParams") or {}
                
                # Enforce parameter validation schema
                validated_params = validate_action_parameters(action_enum, raw_params)

                validated_output = RecoveryExecutorOutput(
                    proposedAction=action_enum,
                    confidence=float(raw_output.get("confidence", 0.80)),
                    reasonCodes=raw_output.get("reasonCodes", []),
                    rationale=str(raw_output.get("rationale") or raw_output.get("reasoning", "Action plan configured.")),
                    parameters=validated_params,
                    metadata={
                        "agentName": "RecoveryExecutor",
                        "agentVersion": "v1.0",
                        "latencyMs": latency_ms,
                        "isFallback": raw_output.get("isFallback", False),
                    },
                )
            elif isinstance(raw_output, RecoveryExecutorOutput):
                validated_output = raw_output
                validated_output.parameters = validate_action_parameters(
                    validated_output.proposedAction,
                    validated_output.parameters
                )
                if not validated_output.metadata:
                    validated_output.metadata = {}
                validated_output.metadata["latencyMs"] = latency_ms
            else:
                raise ValueError(f"Unexpected output type: {type(raw_output)}")

            return validated_output.model_dump()

        except Exception as validation_err:
            print(f"[RecoveryExecutor] Output validation failed ({validation_err}). Returning safe escalation fallback.")
            return RecoveryExecutorOutput(
                proposedAction=RecoveryActionEnum.ESCALATE_TO_HUMAN,
                confidence=0.30,
                reasonCodes=["EXECUTOR_VALIDATION_ERROR"],
                rationale=f"Executor action proposal validation failed: {str(validation_err)}",
                parameters={"priority": "urgent", "reason": "action_planner_validation_failed"},
                metadata={
                    "agentName": "RecoveryExecutor",
                    "agentVersion": "v1.0",
                    "latencyMs": latency_ms,
                    "isFallback": True,
                },
            ).model_dump()

    def _deterministic_action_planner(self, inp: RecoveryExecutorInput) -> Dict[str, Any]:
        """
        Synthesizes concrete Action Plan based on Agent 1 analysis and transaction constraints.
        Enforces safety rules to prevent privilege escalation or invalid operations.
        """
        tx = inp.transaction
        a1 = inp.agent1Recommendation
        reason = tx.failureReason
        rec = a1.recommendation

        # Safety Check 1: Invariant override if card expired but retry was somehow recommended
        if reason == "card_expired" and rec == RecoveryActionEnum.ATTEMPT_RECOVERY:
            return {
                "proposedAction": RecoveryActionEnum.SEND_RECOVERY_MESSAGE.value,
                "confidence": 0.95,
                "reasonCodes": ["CARD_EXPIRED_OVERRULE_RETRY", "SELF_SERVICE_LINK"],
                "rationale": "Overruled direct retry recommendation for expired card. Formulating self-service update link.",
                "parameters": {
                    "channel": "email",
                    "templateId": "card_expired_update_v1",
                    "customMessage": "Your payment card on file has expired. Please update details securely.",
                },
            }

        # Safety Check 2: Fraud cases must always escalate
        if reason == "high_risk_fraud" or tx.metadata.get("fraudFlag") is True:
            return {
                "proposedAction": RecoveryActionEnum.ESCALATE_TO_HUMAN.value,
                "confidence": 0.99,
                "reasonCodes": ["FRAUD_FLAG_ENFORCED", "SECURITY_ESCALATION"],
                "rationale": "High-risk fraud activity detected. Formulating immediate human review dispatch.",
                "parameters": {
                    "priority": "urgent",
                    "reason": "High risk fraud indicators present",
                    "channel": "internal_escalation",
                },
            }

        # Safety Check 3: Check if Agent 1 recommendation is supported
        if rec not in inp.availableActions:
            return {
                "proposedAction": RecoveryActionEnum.ESCALATE_TO_HUMAN.value,
                "confidence": 0.40,
                "reasonCodes": ["UNSUPPORTED_AGENT1_ACTION"],
                "rationale": f"Agent 1 recommended unsupported action '{rec}'. Defaulting to human review.",
                "parameters": {"priority": "high", "reason": f"unsupported_action_{rec}"},
            }

        # Formulate optimal parameters based on confirmed action
        if rec == RecoveryActionEnum.ATTEMPT_RECOVERY:
            return {
                "proposedAction": RecoveryActionEnum.ATTEMPT_RECOVERY.value,
                "confidence": a1.confidence,
                "reasonCodes": a1.reasonCodes or ["CONFIRMED_IMMEDIATE_RETRY"],
                "rationale": f"Action confirmed by Executor: {a1.rationale}",
                "parameters": {
                    "paymentId": f"pay_retry_{tx.id or int(time.time())}",
                    "reason": "Immediate retry for transient failure",
                    "retryDelayMinutes": 0,
                },
            }

        if rec == RecoveryActionEnum.SEND_RECOVERY_MESSAGE:
            params = a1.suggestedParameters or {}
            return {
                "proposedAction": RecoveryActionEnum.SEND_RECOVERY_MESSAGE.value,
                "confidence": a1.confidence,
                "reasonCodes": a1.reasonCodes or ["CONFIRMED_RECOVERY_MESSAGE"],
                "rationale": f"Action confirmed by Executor: {a1.rationale}",
                "parameters": {
                    "channel": params.get("channel", "email"),
                    "templateId": params.get("templateId", "card_expired_update_v1"),
                    "customMessage": params.get("customMessage", "Your payment was declined. Click to complete payment securely."),
                },
            }

        if rec == RecoveryActionEnum.SCHEDULE_RETRY:
            params = a1.suggestedParameters or {}
            delay = params.get("delayHours", 4)
            return {
                "proposedAction": RecoveryActionEnum.SCHEDULE_RETRY.value,
                "confidence": a1.confidence,
                "reasonCodes": a1.reasonCodes or ["CONFIRMED_SCHEDULED_RETRY"],
                "rationale": f"Action confirmed by Executor: {a1.rationale}",
                "parameters": {
                    "delayHours": delay,
                    "retryDelayMinutes": delay * 60,
                    "reason": "Scheduled banking window retry",
                },
            }

        if rec == RecoveryActionEnum.ESCALATE_TO_HUMAN:
            params = a1.suggestedParameters or {}
            return {
                "proposedAction": RecoveryActionEnum.ESCALATE_TO_HUMAN.value,
                "confidence": a1.confidence,
                "reasonCodes": a1.reasonCodes or ["CONFIRMED_HUMAN_ESCALATION"],
                "rationale": f"Action confirmed by Executor: {a1.rationale}",
                "parameters": {
                    "priority": params.get("priority", "urgent"),
                    "reason": params.get("reason", "Case requires merchant manual investigation"),
                    "channel": "internal_escalation",
                },
            }

        return {
            "proposedAction": RecoveryActionEnum.LOG_OUTCOME.value,
            "confidence": a1.confidence,
            "reasonCodes": ["LOG_OUTCOME_PROPOSED"],
            "rationale": "Logging non-retriable failure outcome.",
            "parameters": {"reason": "Non-actionable decline", "category": "unrecoverable"},
        }

    async def _call_llm(self, inp: RecoveryExecutorInput) -> Dict[str, Any]:
        """
        Executes OpenAI Chat Completion with structured JSON output enforcement.
        """
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=self.api_key)

        tx = inp.transaction
        a1 = inp.agent1Recommendation
        ml = inp.mlPrediction

        user_content = f"""TRANSACTION CONTEXT:
- ID: {tx.id}
- Amount: {tx.currency} {tx.amount}
- Payment Method: {tx.paymentMethod}
- Failure Reason: {tx.failureReason}
- Attempt Count: {tx.attemptCount}

AGENT 1 (RECOVERY ANALYST) RECOMMENDATION:
- Recommendation: {a1.recommendation}
- Confidence: {a1.confidence}
- Reason Codes: {a1.reasonCodes}
- Rationale: {a1.rationale}
- Suggested Params: {json.dumps(a1.suggestedParameters)}

ML RECOVERY SIGNALS:
- Probability: {f"{ml.probability:.2f}" if ml else "N/A"}

Formulate the final concrete Action Plan with structured parameters matching the schema."""

        response = await client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": RECOVERY_EXECUTOR_SYSTEM_PROMPT},
                {"role": "user", "content": user_content}
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=500,
        )

        content = response.choices[0].message.content
        return json.loads(content)
