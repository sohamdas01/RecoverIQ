import os
from typing import List, Dict, Any, Optional
from rag.embeddings import EmbeddingService
from rag.qdrant_store import QdrantManager
from rag.playbook_data import PLAYBOOK_ENTRIES

DEFAULT_TOP_K = 3
MAX_TOP_K = 5
DEFAULT_MIN_SIMILARITY = 0.65


class PlaybookRetriever:
    """
    Production-grade recovery playbook retriever for Agent 1.
    Retrieves bounded, relevance-filtered playbook entries from Qdrant vector store
    with automatic keyword / deterministic fallback if vector search is unavailable or below threshold.
    """

    def __init__(self, embedding_service: Optional[EmbeddingService] = None, qdrant_manager: Optional[QdrantManager] = None):
        self.embedding_service = embedding_service or EmbeddingService()
        self.qdrant_manager = qdrant_manager or QdrantManager()

    def retrieve_strategies(
        self,
        transaction: Dict[str, Any],
        top_k: int = DEFAULT_TOP_K,
        min_similarity: float = DEFAULT_MIN_SIMILARITY
    ) -> List[Dict[str, Any]]:
        """
        Retrieves top-k recovery playbook strategies from Qdrant vector store.
        Applies strict relevance threshold filtering and bounds results to max 5.
        Falls back to keyword matching if Qdrant returns no relevant hits or is offline.
        """
        bounded_k = min(max(1, top_k), MAX_TOP_K)
        failure_reason = str(transaction.get("failureReason") or "").strip()
        payment_method = str(transaction.get("paymentMethod") or "").strip()
        attempt_count = int(transaction.get("attemptCount") or 1)
        amount = float(transaction.get("amount") or 0)

        # 1. Formulate rich semantic search query
        query_text = (
            f"Payment recovery playbook strategy for failure reason '{failure_reason}' "
            f"using payment method '{payment_method}' at attempt count {attempt_count} "
            f"with amount {amount}."
        )

        vector_results: List[Dict[str, Any]] = []

        try:
            query_vector = self.embedding_service.get_embedding(query_text)
            raw_hits = self.qdrant_manager.search_playbook(query_vector, limit=bounded_k)

            # Filter by relevance threshold
            for hit in (raw_hits or []):
                score = hit.get("similarity_score", 0.0)
                if score is not None and float(score) >= min_similarity:
                    vector_results.append(self._normalize_entry(hit, is_fallback=False, score=float(score)))

        except Exception as err:
            # Qdrant unavailable or search error: Graceful degradation to keyword fallback
            print(f"[PlaybookRetriever] Vector retrieval failed ({err}). Using keyword fallback.")
            vector_results = []

        # 2. If vector results satisfy threshold, return top-k
        if vector_results:
            return vector_results[:bounded_k]

        # 3. Deterministic / Keyword Fallback
        return self._keyword_fallback(failure_reason, bounded_k)

    def _normalize_entry(self, entry: Dict[str, Any], is_fallback: bool = False, score: Optional[float] = None) -> Dict[str, Any]:
        """
        Normalizes playbook metadata for Agent 1 consumption.
        """
        playbook_id = entry.get("rule_code") or entry.get("id") or "PB-GEN"
        return {
            "playbook_id": playbook_id,
            "rule_code": playbook_id,
            "failure_type": entry.get("failure_reason") or "unknown",
            "failure_reason": entry.get("failure_reason") or "unknown",
            "title": entry.get("title") or "Recovery Strategy",
            "recommended_strategy": entry.get("recommended_action") or "send_recovery_message",
            "recommended_action": entry.get("recommended_action") or "send_recovery_message",
            "conditions": entry.get("trigger") or "",
            "trigger": entry.get("trigger") or "",
            "tool_params": entry.get("tool_params") or {},
            "rationale": entry.get("rationale") or "",
            "ml_threshold": float(entry.get("ml_threshold") or 0.70),
            "similarity_score": score,
            "is_fallback": is_fallback,
        }

    def _keyword_fallback(self, failure_reason: str, top_k: int) -> List[Dict[str, Any]]:
        """
        Deterministic keyword match from static playbook entries.
        """
        matched = [
            self._normalize_entry(entry, is_fallback=True, score=None)
            for entry in PLAYBOOK_ENTRIES
            if entry.get("failure_reason") == failure_reason
        ]

        if not matched:
            # Fallback to general entries
            matched = [
                self._normalize_entry(entry, is_fallback=True, score=None)
                for entry in PLAYBOOK_ENTRIES
            ]

        return matched[:top_k]
