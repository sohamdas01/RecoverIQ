"""
RecoverIQ GenAI Service - Agent 1 (Recovery Analyst) Implementation
Phase 5 - Step 2: Agent 1 Recovery Analyst
"""

import os
import json
import time
from typing import Dict, Any, Optional

from agents.schemas import (
    RecoveryAnalystInput,
    RecoveryAnalystOutput,
    RecoveryActionEnum,
)
from prompts.recovery_analyst import RECOVERY_ANALYST_SYSTEM_PROMPT
from rag.playbook_retriever import PlaybookRetriever


class RecoveryAnalystAgent:
    """
    Agent 1: Recovery Analyst
    Analyzes failed payment events, synthesizes ML + RAG context, and produces
    strictly structured recovery recommendations for the Policy Engine.
    """

    def __init__(self, model_adapter=None):
        self.api_key = os.getenv("OPENAI_API_KEY", "")
        self.model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        self.retriever = PlaybookRetriever()
        self.model_adapter = model_adapter  # Allows plugging a test mock adapter

    async def analyze(self, raw_input: Dict[str, Any]) -> Dict[str, Any]:
        """
        Main entry point for Agent 1 analysis.
        Strictly validates input schema, retrieves RAG context, calls LLM or fallback,
        and enforces Pydantic output validation.
        """
        start_time = time.time()

        # 1. Validate Input Context using Pydantic
        try:
            if isinstance(raw_input, RecoveryAnalystInput):
                validated_input = raw_input
            else:
                validated_input = RecoveryAnalystInput.model_validate(raw_input)
        except Exception as e:
            # Fallback for invalid input: Safe human escalation
            return RecoveryAnalystOutput(
                recommendation=RecoveryActionEnum.ESCALATE_TO_HUMAN,
                confidence=0.10,
                reasonCodes=["INVALID_INPUT_SCHEMA"],
                rationale=f"Invalid recovery analyst input schema: {str(e)}",
                suggestedParameters={"priority": "high", "reason": "input_validation_failure"},
                metadata={
                    "agentName": "RecoveryAnalyst",
                    "agentVersion": "v1.0",
                    "latencyMs": int((time.time() - start_time) * 1000),
                    "isFallback": True,
                },
            ).model_dump()

        tx = validated_input.transaction
        history = validated_input.customerHistory
        ml = validated_input.mlPrediction
        failure_reason = tx.failureReason or validated_input.failureReason or "unknown"
        attempt_count = tx.attemptCount or validated_input.attemptCount or 1

        # 2. Retrieve Relevant Playbook Strategies from Vector DB (RAG)
        retrieval_query = {
            "failureReason": failure_reason,
            "amount": tx.amount,
            "paymentMethod": tx.paymentMethod,
            "attemptCount": attempt_count,
        }
        retrieved_strategies = self.retriever.retrieve_strategies(retrieval_query, top_k=2)

        # 3. Model Inference (Custom Adapter or LLM API or Deterministic Engine)
        raw_output = None

        if self.model_adapter is not None:
            raw_output = await self.model_adapter(validated_input, retrieved_strategies)
        elif self.api_key and not self.api_key.startswith("sk-placeholder"):
            try:
                raw_output = await self._call_llm(validated_input, retrieved_strategies)
            except Exception as err:
                print(f"[RecoveryAnalyst] LLM call failed ({err}). Falling back to deterministic RAG engine.")
                raw_output = None

        if raw_output is None:
            raw_output = self._deterministic_rag_reasoning(validated_input, retrieved_strategies)

        # 4. Strict Machine Validation of Model Output
        latency_ms = int((time.time() - start_time) * 1000)

        try:
            if isinstance(raw_output, RecoveryAnalystOutput):
                validated_output = raw_output
            else:
                validated_output = RecoveryAnalystOutput.model_validate(raw_output)

            # Ensure metadata exists
            if not validated_output.metadata:
                validated_output.metadata = {}
            validated_output.metadata["latencyMs"] = latency_ms
            validated_output.metadata["agentName"] = "RecoveryAnalyst"
            validated_output.metadata["agentVersion"] = "v1.0"

            return validated_output.model_dump()

        except Exception as validation_err:
            print(f"[RecoveryAnalyst] Output validation failed ({validation_err}). Returning safe fallback.")
            return RecoveryAnalystOutput(
                recommendation=RecoveryActionEnum.ESCALATE_TO_HUMAN,
                confidence=0.30,
                reasonCodes=["OUTPUT_VALIDATION_ERROR"],
                rationale=f"Model output schema validation failed: {str(validation_err)}",
                suggestedParameters={"priority": "urgent", "reason": "model_output_invalid"},
                metadata={
                    "agentName": "RecoveryAnalyst",
                    "agentVersion": "v1.0",
                    "latencyMs": latency_ms,
                    "isFallback": True,
                },
            ).model_dump()

    def _deterministic_rag_reasoning(
        self,
        inp: RecoveryAnalystInput,
        strategies: list
    ) -> Dict[str, Any]:
        """
        High-fidelity deterministic decision synthesis incorporating RAG playbook rules,
        ML signals, and payment history invariants.
        """
        tx = inp.transaction
        hist = inp.customerHistory or CustomerHistoryContext()
        ml_prob = inp.mlPrediction.probability if inp.mlPrediction else 0.70
        reason = tx.failureReason

        # Case 1: High risk fraud
        if reason == "high_risk_fraud" or tx.metadata.get("fraudFlag") is True:
            return {
                "recommendation": RecoveryActionEnum.ESCALATE_TO_HUMAN.value,
                "confidence": 0.98,
                "reasonCodes": ["HIGH_RISK_FRAUD_FLAGGED", "SECURITY_QUARANTINE"],
                "rationale": "High-risk fraud indicators present. Suppressing automated retries and escalating to risk operations.",
                "suggestedParameters": {"priority": "urgent", "channel": "internal_escalation"},
            }

        # Case 2: Card expired
        if reason == "card_expired":
            return {
                "recommendation": RecoveryActionEnum.SEND_RECOVERY_MESSAGE.value,
                "confidence": 0.95,
                "reasonCodes": ["CARD_EXPIRED_UPDATE_REQUIRED", "SELF_SERVICE_LINK"],
                "rationale": "Card is expired; direct retries will fail at gateway. Self-service link allows customer to update payment details.",
                "suggestedParameters": {"channel": "email", "templateId": "card_expired_v1"},
            }

        # Case 3: Bank outage / Network timeout
        if reason in ("bank_outage", "network_timeout"):
            return {
                "recommendation": RecoveryActionEnum.ATTEMPT_RECOVERY.value,
                "confidence": 0.90,
                "reasonCodes": ["TRANSIENT_GATEWAY_OUTAGE", "IMMEDIATE_RETRY_ELIGIBLE"],
                "rationale": "Transient network or gateway timeout identified. Immediate re-capture has high probability of settlement.",
                "suggestedParameters": {"paymentId": f"pay_retry_{tx.id or int(time.time())}"},
            }

        # Case 4: Insufficient funds
        if reason == "insufficient_funds":
            if tx.attemptCount >= 3:
                return {
                    "recommendation": RecoveryActionEnum.SEND_RECOVERY_MESSAGE.value,
                    "confidence": 0.85,
                    "reasonCodes": ["MULTI_ATTEMPT_FUNDS_EXHAUSTED", "ALTERNATIVE_PAYMENT_METHOD"],
                    "rationale": "Multiple insufficient funds failures recorded. Proposing customer recovery message with alternate payment options.",
                    "suggestedParameters": {"channel": "email", "templateId": "alternative_payment_methods"},
                }
            return {
                "recommendation": RecoveryActionEnum.SCHEDULE_RETRY.value,
                "confidence": 0.82,
                "reasonCodes": ["INSUFFICIENT_FUNDS_SCHEDULED_WINDOW", "SETTLEMENT_TIMING"],
                "rationale": "Transient insufficient funds decline. Scheduling retry for standard banking clearing window.",
                "suggestedParameters": {"retryDelayMinutes": 360},
            }

        # Case 5: Top RAG strategy fallback
        if strategies:
            top = strategies[0]
            action = top.get("recommended_action", RecoveryActionEnum.SEND_RECOVERY_MESSAGE.value)
            similarity = top.get("similarity_score", 0.85)
            rule_code = top.get("rule_code", "PB-RAG")
            return {
                "recommendation": action,
                "confidence": min(0.95, max(0.70, similarity)),
                "reasonCodes": [f"RAG_{rule_code}", "PLAYBOOK_MATCH"],
                "rationale": f"Playbook match [{rule_code}: {top.get('title')}]: {top.get('rationale')}",
                "suggestedParameters": top.get("tool_params", {}),
            }

        # Default fallback
        return {
            "recommendation": RecoveryActionEnum.SEND_RECOVERY_MESSAGE.value,
            "confidence": 0.70,
            "reasonCodes": ["BASELINE_RECOVERY_HEURISTIC"],
            "rationale": "Standard recovery strategy routing customer to checkout self-service portal.",
            "suggestedParameters": {"channel": "email"},
        }

    async def _call_llm(
        self,
        inp: RecoveryAnalystInput,
        strategies: list
    ) -> Dict[str, Any]:
        """
        Executes OpenAI Chat Completion with structured JSON output enforcement.
        """
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=self.api_key)

        rag_context = "\n\n".join([
            f"- Strategy [{s.get('rule_code', 'PB')}]: {s.get('title')}\n"
            f"  Action: {s.get('recommended_action')}\n"
            f"  Rationale: {s.get('rationale')}\n"
            f"  Similarity: {s.get('similarity_score', 0.8):.2f}"
            for s in strategies
        ])

        tx = inp.transaction
        hist = inp.customerHistory or CustomerHistoryContext()
        ml = inp.mlPrediction

        # Sanitize metadata to avoid prompt injection leakage
        safe_meta = {k: str(v)[:100] for k, v in (tx.metadata or {}).items() if k != "notes"}

        user_content = f"""TRANSACTION DATA:
- Amount: {tx.currency} {tx.amount}
- Payment Method: {tx.paymentMethod}
- Failure Reason: {tx.failureReason}
- Attempt Count: {tx.attemptCount}
- Safe Metadata: {json.dumps(safe_meta)}

CUSTOMER HISTORY:
- Successes: {hist.previousSuccesses}
- Failures: {hist.previousFailures}
- Prior Recovery Success: {hist.previousRecoverySuccess}

ML RECOVERY SIGNALS:
- Probability: {f"{ml.probability:.2f}" if ml else "N/A"}
- Reason Codes: {ml.reason_codes if ml else []}

RELEVANT PLAYBOOK STRATEGIES (Vector DB):
{rag_context if rag_context else "None available"}

Analyze the transaction and return the structured JSON recommendation."""

        response = await client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": RECOVERY_ANALYST_SYSTEM_PROMPT},
                {"role": "user", "content": user_content}
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=500,
        )

        content = response.choices[0].message.content
        return json.loads(content)
