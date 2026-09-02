from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict, Any
from agents.single_agent import SingleRecoveryAgent
import uvicorn
import os

app = FastAPI(
    title="RecoverIQ GenAI Service",
    description="Agentic Decision & RAG Service for Payment Recovery",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

agent = SingleRecoveryAgent()

class TransactionPayload(BaseModel):
    transactionId: Optional[str] = None
    customerName: Optional[str] = None
    customerEmail: Optional[str] = None
    amount: float
    currency: Optional[str] = "INR"
    paymentMethod: str
    failureReason: str
    attemptCount: Optional[int] = 1

@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "service": "recoveriq-genai-service",
        "version": "1.0.0"
    }

@app.post("/analyze")
async def analyze_transaction(payload: TransactionPayload):
    try:
        recommendation = await agent.analyze_and_recommend(payload.model_dump())
        return recommendation
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8001))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
