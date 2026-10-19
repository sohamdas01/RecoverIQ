"""
Tests for Recovery Playbook RAG integration with Agent 1 (Recovery Analyst).
Phase 7 - Step 1
"""
import pytest
import asyncio
from unittest.mock import MagicMock, patch

from rag.playbook_retriever import PlaybookRetriever
from agents.recovery_analyst import RecoveryAnalystAgent
from agents.schemas import RecoveryAnalystInput, RecoveryAnalystOutput, PlaybookSource






def test_rag_retrieval_success_with_relevance_threshold():
    """Test that query returns only results meeting similarity threshold and top-k."""
    mock_embed = MagicMock()
    mock_embed.get_embedding.return_value = [0.1] * 384

    mock_qdrant = MagicMock()
    mock_qdrant.search_playbook.return_value = [
        {
            "rule_code": "PB-01",
            "failure_reason": "insufficient_funds",
            "title": "Insufficient Funds - Transient Off-Hours Decline",
            "recommended_action": "retry_with_delay",
            "similarity_score": 0.88,
            "tool_params": {"delay_hours": 48},
            "rationale": "High success on payroll mornings."
        },
        {
            "rule_code": "PB-99",
            "failure_reason": "other",
            "title": "Low similarity rule",
            "recommended_action": "escalate_to_human",
            "similarity_score": 0.45,
            "tool_params": {},
            "rationale": "Irrelevant"
        }
    ]

    retriever = PlaybookRetriever(embedding_service=mock_embed, qdrant_manager=mock_qdrant)
    txn = {"failureReason": "insufficient_funds", "paymentMethod": "card", "attemptCount": 1, "amount": 450.0}
    results = retriever.retrieve_strategies(txn, top_k=3, min_similarity=0.65)

    assert len(results) == 1
    assert results[0]["playbook_id"] == "PB-01"
    assert results[0]["similarity_score"] == 0.88
    assert results[0]["is_fallback"] is False


def test_rag_retrieval_qdrant_offline_fallback():
    """Test graceful keyword fallback when Qdrant is unavailable."""
    mock_embed = MagicMock()
    mock_embed.get_embedding.side_effect = ConnectionError("Qdrant offline")

    retriever = PlaybookRetriever(embedding_service=mock_embed, qdrant_manager=None)
    txn = {"failureReason": "insufficient_funds", "paymentMethod": "card", "attemptCount": 1, "amount": 450.0}
    results = retriever.retrieve_strategies(txn, top_k=3)

    assert len(results) > 0
    assert results[0]["playbook_id"] == "PB-01"
    assert results[0]["is_fallback"] is True
    assert results[0]["similarity_score"] is None


def test_rag_retrieval_bounded_top_k():
    """Test top-k is strictly bounded to max 5."""
    mock_embed = MagicMock()
    mock_embed.get_embedding.return_value = [0.1] * 384

    mock_qdrant = MagicMock()
    mock_qdrant.search_playbook.return_value = [
        {
            "rule_code": f"PB-0{i}",
            "failure_reason": "insufficient_funds",
            "title": f"Rule {i}",
            "recommended_action": "retry_with_delay",
            "similarity_score": 0.90 - (i * 0.01),
            "tool_params": {},
            "rationale": "Rule"
        }
        for i in range(10)
    ]

    retriever = PlaybookRetriever(embedding_service=mock_embed, qdrant_manager=mock_qdrant)
    txn = {"failureReason": "insufficient_funds", "paymentMethod": "card", "attemptCount": 1, "amount": 450.0}
    results = retriever.retrieve_strategies(txn, top_k=10)
    assert len(results) <= 5


def test_agent_1_receives_playbook_context_and_outputs_sources():
    """Test that Agent 1 parses retrieved playbooks and outputs playbookSources."""
    agent = RecoveryAnalystAgent()
    payload = {
        "transaction": {
            "id": "txn_insufficient_funds",
            "amount": 450.0,
            "currency": "USD",
            "paymentMethod": "card",
            "failureReason": "insufficient_funds",
            "attemptCount": 1,
        },
        "customerHistory": {
            "previousSuccesses": 4,
            "previousFailures": 0,
            "previousRecoverySuccess": True,
        },
        "mlPrediction": {
            "probability": 0.82,
            "reason_codes": ["LOW_PRIOR_FAILURES"],
        },
    }

    res = asyncio.run(agent.analyze(payload))

    assert "recommendation" in res
    assert "confidence" in res
    assert "playbookSources" in res
    assert isinstance(res["playbookSources"], list)
    if len(res["playbookSources"]) > 0:
        source = res["playbookSources"][0]
        assert "playbookId" in source
        assert source["playbookId"].startswith("PB-")
        assert "failureType" in source
        assert "ruleTitle" in source


def test_playbook_retriever_empty_query_fallback():
    """Test fallback when empty or unparseable query is provided."""
    mock_embed = MagicMock()
    mock_embed.get_embedding.side_effect = ConnectionError("Qdrant offline")
    retriever = PlaybookRetriever(embedding_service=mock_embed, qdrant_manager=None)
    results = retriever.retrieve_strategies({}, top_k=3)
    assert isinstance(results, list)
    assert len(results) >= 1
