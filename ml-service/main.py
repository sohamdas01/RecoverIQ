"""
RecoverIQ ML Service — FastAPI Online Inference Service
-------------------------------------------------------
Exposes:
  - GET  /health   -> Service & model readiness status
  - POST /predict  -> Real-time recovery probability & SHAP reason codes

Invariants:
  - Zero online retraining (loads static model artifact on startup)
  - Reuses single source of truth preprocessing pipeline
  - Strict Pydantic input validation
  - Structured error handling without stack trace leaks
"""

import os
import json
import logging
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field, field_validator
import uvicorn

from preprocessing.features import (
    SUPPORTED_PAYMENT_METHODS,
    SUPPORTED_FAILURE_REASONS,
    preprocess_single_record,
)
from explainability.shap_explainer import RecoverySHAPExplainer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ml_service")

# Global singleton model & explainer container
model_container: Dict[str, Any] = {
    "explainer": None,
    "metadata": None,
    "model_version": "v1.0.0",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Loads trained model, metadata, and initializes SHAP TreeExplainer once at startup."""
    artifacts_dir = os.path.join(os.path.dirname(__file__), "artifacts")
    model_path = os.path.join(artifacts_dir, "model.joblib")
    metadata_path = os.path.join(artifacts_dir, "metadata.json")

    logger.info(f"Initializing RecoverIQ ML Service (Loading artifacts from {artifacts_dir})...")

    if not os.path.exists(model_path):
        logger.error(f"Critical: Model artifact not found at {model_path}. Run training pipeline.")
        raise RuntimeError(f"Model artifact not found at {model_path}")

    # Load metadata
    if os.path.exists(metadata_path):
        with open(metadata_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
            model_container["metadata"] = meta
            model_container["model_version"] = meta.get("model_version", "v1.0.0")

    # Initialize SHAP explainer (loads model.joblib internally)
    try:
        model_container["explainer"] = RecoverySHAPExplainer(model_path)
        logger.info(f"Loaded XGBoost model & SHAP TreeExplainer successfully (Version: {model_container['model_version']})")
    except Exception as e:
        logger.error(f"Failed to load model into SHAP explainer: {e}")
        raise RuntimeError(f"Failed to load model: {e}")

    yield

    logger.info("Shutting down RecoverIQ ML Service...")


app = FastAPI(
    title="RecoverIQ ML Prediction Service",
    description="Payment failure recovery probability scoring & SHAP explainability",
    version="1.0.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------
# Request & Response Schemas
# ---------------------------------------------------------

class PredictRequest(BaseModel):
    amount: float = Field(..., gt=0, description="Transaction amount (e.g. in INR)")
    payment_method: str = Field(..., description=f"Payment method. Allowed: {SUPPORTED_PAYMENT_METHODS}")
    failure_reason: str = Field(..., description=f"Failure reason. Allowed: {SUPPORTED_FAILURE_REASONS}")
    attempt_count: int = Field(default=1, ge=1, description="Current recovery retry attempt number")
    days_since_failure: float = Field(default=0.0, ge=0.0, description="Elapsed days since initial failure")
    day_of_month: Optional[int] = Field(default=15, ge=1, le=31, description="Day of calendar month (1-31)")
    hour_of_day: Optional[int] = Field(default=12, ge=0, le=23, description="Hour of the day (0-23)")
    previous_successes: int = Field(default=0, ge=0, description="Customer's previous successful transactions")
    previous_failures: int = Field(default=0, ge=0, description="Customer's previous failed transactions")
    previous_recovery_success: bool = Field(default=False, description="Whether customer successfully recovered a past payment")
    is_subscription: Optional[bool] = Field(default=None, description="Whether transaction is a recurring subscription")

    @field_validator("payment_method")
    @classmethod
    def validate_payment_method(cls, v: str) -> str:
        clean = v.lower().strip()
        if clean not in SUPPORTED_PAYMENT_METHODS:
            raise ValueError(f"Invalid payment_method '{v}'. Allowed methods: {SUPPORTED_PAYMENT_METHODS}")
        return clean

    @field_validator("failure_reason")
    @classmethod
    def validate_failure_reason(cls, v: str) -> str:
        clean = v.lower().strip()
        if clean not in SUPPORTED_FAILURE_REASONS:
            raise ValueError(f"Invalid failure_reason '{v}'. Allowed reasons: {SUPPORTED_FAILURE_REASONS}")
        return clean


class AttributionDetail(BaseModel):
    feature: str
    code: str
    description: str
    impact: str
    shap_value: float


class PredictResponse(BaseModel):
    probability: float
    reason_codes: List[str]
    model_version: str
    attributions: Optional[List[AttributionDetail]] = None


class HealthResponse(BaseModel):
    status: str
    service: str
    model_version: str
    model_loaded: bool


# ---------------------------------------------------------
# Custom Exception Handlers (Prevent Stack Trace Leakage)
# ---------------------------------------------------------

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = []
    for err in exc.errors():
        field = " -> ".join([str(loc) for loc in err.get("loc", []) if loc != "body"])
        errors.append(f"{field}: {err.get('msg')}")

    logger.warning(f"Validation rejected on {request.url.path}: {errors}")
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": "Validation Error",
            "message": "The request payload failed input schema validation.",
            "details": errors,
        },
    )


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    logger.warning(f"ValueError on {request.url.path}: {str(exc)}")
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={
            "error": "Bad Request",
            "message": str(exc),
        },
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.error(f"Internal Server Error on {request.url.path}: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": "Internal Server Error",
            "message": "An unexpected error occurred during ML inference.",
        },
    )


# ---------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health & Readiness probe endpoint."""
    is_loaded = model_container["explainer"] is not None
    return HealthResponse(
        status="healthy" if is_loaded else "degraded",
        service="recoveriq-ml-service",
        model_version=model_container["model_version"],
        model_loaded=is_loaded,
    )


@app.post("/predict", response_model=PredictResponse)
async def predict_recovery_probability(payload: PredictRequest):
    """
    Predicts payment recovery probability and returns grounded SHAP reason codes.
    """
    explainer: RecoverySHAPExplainer = model_container["explainer"]
    if explainer is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ML Model is not loaded or service is initializing.",
        )

    # 1. Convert payload to dictionary
    raw_dict = payload.model_dump()
    if raw_dict.get("is_subscription") is None:
        raw_dict["is_subscription"] = (raw_dict["payment_method"] == "subscription_mandate")

    # 2. Preprocess input using single source of truth
    X_single_df = preprocess_single_record(raw_dict)

    # 3. Predict & Explain via SHAP
    prob, reason_codes, attributions = explainer.explain_prediction(X_single_df, top_k=4)

    logger.info(
        f"[Predict] Amount: {payload.amount} | Reason: {payload.failure_reason} -> "
        f"Prob: {prob:.4f} | Reason Codes: {reason_codes}"
    )

    return PredictResponse(
        probability=prob,
        reason_codes=reason_codes,
        model_version=model_container["model_version"],
        attributions=[
            AttributionDetail(
                feature=a["feature"],
                code=a["code"],
                description=a["description"],
                impact=a["impact"],
                shap_value=a["shap_value"],
            )
            for a in attributions[:6]
        ],
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
