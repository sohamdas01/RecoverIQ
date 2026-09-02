from typing import List, Dict, Any
from rag.embeddings import EmbeddingService
from rag.qdrant_store import QdrantManager

class PlaybookRetriever:
    def __init__(self):
        self.embedding_service = EmbeddingService()
        self.qdrant_manager = QdrantManager()

    def retrieve_strategies(self, transaction: Dict[str, Any], top_k: int = 2) -> List[Dict[str, Any]]:
        """
        Retrieves the top-k recovery playbook strategies from Qdrant vector store
        based on transaction failure reason, method, amount, and attempt count.
        """
        failure_reason = transaction.get("failureReason", "")
        payment_method = transaction.get("paymentMethod", "")
        attempt_count = transaction.get("attemptCount", 1)
        amount = transaction.get("amount", 0)

        # Formulate rich semantic search query
        query_text = (
            f"Payment recovery playbook strategy for failure reason '{failure_reason}' "
            f"using payment method '{payment_method}' at attempt count {attempt_count} "
            f"with amount {amount}."
        )

        query_vector = self.embedding_service.get_embedding(query_text)
        results = self.qdrant_manager.search_playbook(query_vector, limit=top_k)

        if not results:
            print(f"[PlaybookRetriever] No vector results found for query. Fallback to keyword match.")
            from rag.playbook_data import PLAYBOOK_ENTRIES
            matched = [
                entry for entry in PLAYBOOK_ENTRIES
                if entry.get("failure_reason") == failure_reason
            ]
            return matched[:top_k]

        return results
