"""
RecoverIQ GenAI Service - Multi-Agent Schemas
Phase 5 - Step 3: Agent 1 (Analyst) & Agent 2 (Executor / Action Planner)
Phase 7 - Step 6: Ask RecoverIQ Grounded Question Answering
"""

from enum import Enum
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field, field_validator, model_validator


class RecoveryActionEnum(str, Enum):
    ATTEMPT_RECOVERY = "attempt_recovery"
    SEND_RECOVERY_MESSAGE = "send_recovery_message"
    SCHEDULE_RETRY = "schedule_retry"
    ESCALATE_TO_HUMAN = "escalate_to_human"
    LOG_OUTCOME = "log_outcome"


# -------------------------------------------------------------
# Parameter Validation Schemas for Supported Actions
# -------------------------------------------------------------
class AttemptRecoveryParams(BaseModel):
    paymentId: Optional[str] = Field(default=None, description="Gateway retry payment identifier")
    reason: Optional[str] = Field(default="Automated retry capture", description="Retry operational reason")
    retryDelayMinutes: Optional[int] = Field(default=0, ge=0, le=1440, description="Delay before capture in minutes")


class SendRecoveryMessageParams(BaseModel):
    channel: str = Field(default="email", pattern="^(email|sms|whatsapp)$", description="Delivery channel")
    templateId: Optional[str] = Field(default="card_expired_update_v1", description="Template identifier")
    customMessage: Optional[str] = Field(default=None, max_length=500, description="Safe advisory message")


class ScheduleRetryParams(BaseModel):
    delayHours: Optional[int] = Field(default=4, ge=1, le=168, description="Delay in hours")
    retryDelayMinutes: Optional[int] = Field(default=240, ge=1, le=10080, description="Delay in minutes")
    reason: Optional[str] = Field(default="Scheduled banking window retry", description="Scheduling reason")


class EscalateToHumanParams(BaseModel):
    priority: str = Field(default="urgent", pattern="^(low|medium|high|urgent)$", description="Escalation priority")
    reason: Optional[str] = Field(default="Case flagged for human review", description="Escalation justification")
    channel: Optional[str] = Field(default="internal_escalation", description="Escalation routing channel")


class LogOutcomeParams(BaseModel):
    reason: Optional[str] = Field(default="Outcome logged", description="Closure rationale")
    category: Optional[str] = Field(default="unrecoverable", description="Outcome category")


def validate_action_parameters(action: RecoveryActionEnum, raw_params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validates and sanitizes raw parameters against the strict schema for the given action.
    """
    params = raw_params or {}
    if action == RecoveryActionEnum.ATTEMPT_RECOVERY:
        return AttemptRecoveryParams.model_validate(params).model_dump(exclude_none=True)
    elif action == RecoveryActionEnum.SEND_RECOVERY_MESSAGE:
        return SendRecoveryMessageParams.model_validate(params).model_dump(exclude_none=True)
    elif action == RecoveryActionEnum.SCHEDULE_RETRY:
        return ScheduleRetryParams.model_validate(params).model_dump(exclude_none=True)
    elif action == RecoveryActionEnum.ESCALATE_TO_HUMAN:
        return EscalateToHumanParams.model_validate(params).model_dump(exclude_none=True)
    elif action == RecoveryActionEnum.LOG_OUTCOME:
        return LogOutcomeParams.model_validate(params).model_dump(exclude_none=True)
    return {}


# -------------------------------------------------------------
# Common Context Schemas
# -------------------------------------------------------------
class TransactionContext(BaseModel):
    id: Optional[str] = Field(default=None, description="Transaction unique ID")
    amount: float = Field(gt=0, description="Transaction monetary amount in major units")
    currency: str = Field(default="INR", description="Three-letter ISO currency code")
    paymentMethod: str = Field(description="Payment method used (card, upi, netbanking, subscription_mandate)")
    failureReason: str = Field(description="Normalized payment decline or failure code")
    attemptCount: int = Field(default=1, ge=1, description="Number of attempts for this transaction")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Safe transaction metadata")


class CustomerHistoryContext(BaseModel):
    customerId: Optional[str] = None
    previousSuccesses: int = Field(default=0, ge=0)
    previousFailures: int = Field(default=0, ge=0)
    previousRecoverySuccess: bool = Field(default=False)
    accountAgeDays: Optional[int] = Field(default=None, ge=0)


class MLPredictionContext(BaseModel):
    probability: float = Field(ge=0.0, le=1.0, description="XGBoost recovery likelihood score")
    reason_codes: List[str] = Field(default_factory=list, description="Top TreeSHAP feature attributions")
    model_version: Optional[str] = Field(default="v1.0.0")


# -------------------------------------------------------------
# Agent 1 (Recovery Analyst) Schemas
# -------------------------------------------------------------
class RecoveryAnalystInput(BaseModel):
    transaction: TransactionContext
    customerHistory: Optional[CustomerHistoryContext] = None
    subscription: Optional[bool] = False
    mlPrediction: Optional[MLPredictionContext] = None
    systemContext: Optional[Dict[str, Any]] = Field(default_factory=dict)


class PlaybookSource(BaseModel):
    id: Optional[str] = None
    playbookId: Optional[str] = None
    title: Optional[str] = None
    ruleTitle: Optional[str] = None
    strategy: Optional[str] = None
    similarity: Optional[float] = None
    similarityScore: Optional[float] = None
    failureType: Optional[str] = None
    summary: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def sync_aliases(cls, data: Any) -> Any:
        if isinstance(data, dict):
            pid = data.get("playbookId") or data.get("id") or data.get("playbook_id")
            if pid:
                data["playbookId"] = pid
                data["id"] = pid
            title = data.get("ruleTitle") or data.get("title")
            if title:
                data["ruleTitle"] = title
                data["title"] = title
            score = data.get("similarityScore") or data.get("similarity") or data.get("similarity_score")
            if score is not None:
                data["similarityScore"] = score
                data["similarity"] = score
        return data


class RecoveryAnalystOutput(BaseModel):
    """
    Structured recommendation output produced by Agent 1 (Recovery Analyst).
    """
    recommendation: RecoveryActionEnum = Field(
        description="Recommended action selected from the supported enum"
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="Agent confidence in the recommendation"
    )
    reasonCodes: List[str] = Field(
        default_factory=list,
        description="Machine-readable uppercase reason codes justifying the decision"
    )
    rationale: str = Field(
        min_length=5,
        max_length=1500,
        description="Detailed strategic explanation for the recommendation"
    )
    suggestedParameters: Optional[Dict[str, Any]] = Field(
        default_factory=dict,
        description="Optional initial parameter suggestions passed to Agent 2"
    )
    playbookSources: Optional[List[PlaybookSource]] = Field(
        default_factory=list,
        description="Playbook entries retrieved from Qdrant and used for grounding"
    )
    metadata: Optional[Dict[str, Any]] = Field(
        default_factory=lambda: {
            "agentName": "RecoveryAnalyst",
            "agentVersion": "v1.0",
        },
        description="Agent telemetry metadata"
    )

    @field_validator("reasonCodes")
    @classmethod
    def validate_reason_codes(cls, v):
        return [str(code).strip().upper().replace(" ", "_") for code in v if str(code).strip()]


# -------------------------------------------------------------
# Agent 2 (Recovery Executor / Action Planner) Schemas
# -------------------------------------------------------------
class RecoveryExecutorInput(BaseModel):
    """
    Strict input contract for Agent 2.
    Requires Agent 1's recommendation and full context.
    """
    transaction: TransactionContext
    customerHistory: Optional[CustomerHistoryContext] = None
    mlPrediction: Optional[MLPredictionContext] = None
    agent1Recommendation: RecoveryAnalystOutput
    systemContext: Optional[Dict[str, Any]] = Field(default_factory=dict)

    @field_validator("agent1Recommendation", mode="before")
    @classmethod
    def parse_analyst_recommendation(cls, v):
        if isinstance(v, dict):
            if "action" in v and "recommendation" not in v:
                v["recommendation"] = v["action"]
            if "reasoning" in v and "rationale" not in v:
                v["rationale"] = v["reasoning"]
            if "toolParams" in v and "suggestedParameters" not in v:
                v["suggestedParameters"] = v["toolParams"]
            return RecoveryAnalystOutput.model_validate(v)
        return v


class RecoveryExecutorOutput(BaseModel):
    """
    Strict machine-readable action plan proposal produced by Agent 2.
    Validated with Pydantic and ready for Policy Engine evaluation.
    """
    proposedAction: RecoveryActionEnum = Field(
        description="Formal proposed action from the allowed enum"
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="Executor confidence in the concrete action proposal"
    )
    reasonCodes: List[str] = Field(
        default_factory=list,
        description="Machine-readable uppercase reason codes justifying the action plan"
    )
    rationale: str = Field(
        min_length=5,
        max_length=1500,
        description="Detailed execution rationale explaining why this action plan is optimal"
    )
    parameters: Dict[str, Any] = Field(
        default_factory=dict,
        description="Validated parameters matching the schema for proposedAction"
    )
    metadata: Optional[Dict[str, Any]] = Field(
        default_factory=lambda: {
            "agentName": "RecoveryExecutor",
            "agentVersion": "v1.0",
        },
        description="Agent execution metadata"
    )

    @field_validator("reasonCodes")
    @classmethod
    def validate_reason_codes(cls, v):
        return [str(code).strip().upper().replace(" ", "_") for code in v if str(code).strip()]


# -------------------------------------------------------------
# Ask RecoverIQ Schemas
# -------------------------------------------------------------
class EvidenceReference(BaseModel):
    caseId: Optional[str] = None
    transactionId: Optional[str] = None
    stage: Optional[str] = None
    ruleId: Optional[str] = None
    playbookId: Optional[str] = None
    timestamp: Optional[str] = None
    detail: Optional[str] = None


class AskRecoverIQInput(BaseModel):
    question: str = Field(min_length=1, max_length=1000, description="Merchant inquiry question")
    evidence: List[Dict[str, Any]] = Field(default_factory=list, description="Structured factual recovery evidence")
    caseId: Optional[str] = Field(default=None, description="Optional target recovery case identifier")


class AskRecoverIQOutput(BaseModel):
    answer: str = Field(description="Strictly evidence-grounded explanatory answer")
    evidence: List[EvidenceReference] = Field(default_factory=list, description="Citations from supplied evidence")
    isGrounded: bool = Field(default=True, description="Flag indicating if the response is fully grounded in audit data")
