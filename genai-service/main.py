"""
RecoverIQ GenAI Service - Main FastAPI Application
Phase 5 - Step 3: Multi-Agent Architecture (Agent 1: Analyst & Agent 2: Executor)
"""

import os
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional, Dict, Any

from agents.schemas import (
    RecoveryAnalystInput,
    RecoveryAnalystOutput,
    RecoveryExecutorInput,
    RecoveryExecutorOutput,
    TransactionContext,
)
from agents.recovery_analyst import RecoveryAnalystAgent
from agents.recovery_executor import RecoveryExecutorAgent

app = FastAPI(
    title="RecoverIQ GenAI Service",
    description="Agentic Decision & RAG Service for Payment Recovery (Agent 1: Analyst, Agent 2: Executor)",
    version="1.2.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Autonomous Agents
recovery_analyst = RecoveryAnalystAgent()
recovery_executor = RecoveryExecutorAgent()


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "service": "recoveriq-genai-service",
        "version": "1.2.0",
        "agents": {
            "recovery_analyst": "active",
            "recovery_executor": "active",
        }
    }


@app.post("/internal/recovery/analyze", response_model=RecoveryAnalystOutput)
async def analyze_recovery_internal(payload: RecoveryAnalystInput):
    """
    Internal API for Agent 1 (Recovery Analyst).
    Accepts structured, sanitized recovery context and returns strategic recommendation.
    """
    try:
        result = await recovery_analyst.analyze(payload)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent 1 analysis error: {str(e)}")


@app.post("/internal/recovery/plan", response_model=RecoveryExecutorOutput)
async def plan_recovery_internal(payload: RecoveryExecutorInput):
    """
    Internal API for Agent 2 (Recovery Executor / Action Planner).
    Takes Agent 1's recommendation and context, validates parameter schemas,
    and returns a concrete Action Plan proposal.
    """
    try:
        result = await recovery_executor.plan(payload)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent 2 planning error: {str(e)}")


@app.post("/analyze")
async def analyze_legacy(raw_payload: Dict[str, Any]):
    """
    Backwards-compatible endpoint executing complete Agent 1 + Agent 2 pipeline.
    """
    try:
        # Step 1: Normalize input for Agent 1
        if "transaction" in raw_payload:
            analyst_input = raw_payload
        else:
            analyst_input = {
                "transaction": {
                    "id": raw_payload.get("transactionId"),
                    "amount": float(raw_payload.get("amount", 0)),
                    "currency": raw_payload.get("currency", "INR"),
                    "paymentMethod": raw_payload.get("paymentMethod", "card"),
                    "failureReason": raw_payload.get("failureReason", "unknown"),
                    "attemptCount": int(raw_payload.get("attemptCount", 1)),
                    "metadata": raw_payload.get("metadata", {}),
                },
                "customerHistory": {
                    "previousSuccesses": raw_payload.get("previousSuccesses", 0),
                    "previousFailures": raw_payload.get("previousFailures", 0),
                    "previousRecoverySuccess": raw_payload.get("previousRecoverySuccess", False),
                },
                "mlPrediction": {
                    "probability": float(raw_payload.get("mlScore", 0.70)) if raw_payload.get("mlScore") is not None else 0.70,
                    "reason_codes": raw_payload.get("mlReasonCodes", []),
                } if raw_payload.get("mlScore") is not None else None,
            }

        # Step 2: Run Agent 1 (Analyst)
        analyst_output = await recovery_analyst.analyze(analyst_input)

        # Step 3: Run Agent 2 (Executor)
        executor_input = {
            "transaction": analyst_input.get("transaction"),
            "customerHistory": analyst_input.get("customerHistory"),
            "mlPrediction": analyst_input.get("mlPrediction"),
            "agent1Recommendation": analyst_output,
        }
        executor_output = await recovery_executor.plan(executor_input)

        # Return combined result
        return {
            "action": executor_output["proposedAction"],
            "proposedAction": executor_output["proposedAction"],
            "confidence": executor_output["confidence"],
            "reasonCodes": executor_output["reasonCodes"],
            "reasoning": executor_output["rationale"],
            "rationale": executor_output["rationale"],
            "toolParams": executor_output.get("parameters", {}),
            "parameters": executor_output.get("parameters", {}),
            "agent1": analyst_output,
            "agent2": executor_output,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8001))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
