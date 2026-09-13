"""
RecoverIQ GenAI Service - Main FastAPI Application
Phase 5 - Step 3: Multi-Agent Architecture (Agent 1: Analyst & Agent 2: Executor)
"""

import os
import hmac
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Header, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional, Dict, Any
from dotenv import load_dotenv

load_dotenv()

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

# Internal Service Boundary Protection & Production Validation
ENVIRONMENT = os.getenv("ENVIRONMENT") or os.getenv("ENV") or os.getenv("NODE_ENV") or "development"
IS_PRODUCTION = ENVIRONMENT.lower() == "production"

INSECURE_DEV_SECRETS = {
    "recoveriq-internal-service-token-dev-secret",
    "your-shared-internal-service-token-secret",
    "your-genai-service-internal-token-secret",
}

def get_genai_internal_token() -> str:
    token = os.getenv("GENAI_INTERNAL_TOKEN") or os.getenv("INTERNAL_SERVICE_TOKEN")
    if not token or token.strip() == "":
        if IS_PRODUCTION:
            raise RuntimeError(
                "[Config Error] GENAI_INTERNAL_TOKEN or INTERNAL_SERVICE_TOKEN must be explicitly set in production mode."
            )
        return "recoveriq-internal-service-token-dev-secret"

    if IS_PRODUCTION and token.strip() in INSECURE_DEV_SECRETS:
        raise RuntimeError(
            f"[Config Error] Insecure default internal token detected in production: '{token}'"
        )
    return token.strip()

GENAI_INTERNAL_TOKEN = get_genai_internal_token()

async def verify_internal_token(
    x_internal_service_token: Optional[str] = Header(None, alias="x-internal-service-token"),
    authorization: Optional[str] = Header(None),
):
    """
    Validates that incoming internal service requests possess the authoritative internal token.
    Returns 401 Unauthorized if token is missing.
    Returns 403 Forbidden if token is invalid.
    """
    token = x_internal_service_token
    if not token and authorization:
        if authorization.startswith("Bearer "):
            token = authorization[7:].strip()
        else:
            token = authorization.strip()

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing internal service token (x-internal-service-token header required).",
        )

    current_token = get_genai_internal_token()
    if not hmac.compare_digest(token, current_token):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid internal service token.",
        )
    return token

# Initialize Autonomous Agents
recovery_analyst = RecoveryAnalystAgent()
recovery_executor = RecoveryExecutorAgent()


@app.get("/health/live")
def liveness_probe():
    """Liveness probe: returns 200 if the process is up."""
    return {
        "status": "alive",
        "service": "recoveriq-genai-service",
    }


@app.get("/health/ready")
def readiness_probe():
    """Readiness probe: returns 200 if agents are loaded and ready."""
    is_ready = recovery_analyst is not None and recovery_executor is not None
    if not is_ready:
        raise HTTPException(
            status_code=503,
            detail={"status": "not_ready", "service": "recoveriq-genai-service", "reason": "Agents not initialized"}
        )
    return {
        "status": "ready",
        "service": "recoveriq-genai-service",
        "version": "1.2.0",
        "agents": {
            "recovery_analyst": "active",
            "recovery_executor": "active",
        },
    }


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


@app.post("/internal/recovery/analyze", response_model=RecoveryAnalystOutput, dependencies=[Depends(verify_internal_token)])
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


@app.post("/internal/recovery/plan", response_model=RecoveryExecutorOutput, dependencies=[Depends(verify_internal_token)])
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


@app.post("/analyze", dependencies=[Depends(verify_internal_token)])
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
