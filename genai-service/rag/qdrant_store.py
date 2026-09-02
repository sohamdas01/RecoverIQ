import os
from typing import List, Dict, Any, Optional
from qdrant_client import QdrantClient
from qdrant_client.http import models
from rag.embeddings import EMBEDDING_DIM

PLAYBOOK_COLLECTION = "recovery-playbook"
DECISION_SUMMARIES_COLLECTION = "decision-summaries"

class QdrantManager:
    def __init__(self):
        url = os.getenv("QDRANT_URL", "http://localhost:6333")
        api_key = os.getenv("QDRANT_API_KEY", None)
        self.client = QdrantClient(url=url, api_key=api_key or None, timeout=5.0, check_compatibility=False)
        self._initialize_collections()

    def _initialize_collections(self):
        """
        Create recovery-playbook and decision-summaries collections if they do not exist.
        """
        try:
            collections = self.client.get_collections().collections
            existing_names = [c.name for c in collections]

            if PLAYBOOK_COLLECTION not in existing_names:
                print(f"[Qdrant] Creating '{PLAYBOOK_COLLECTION}' collection...")
                self.client.create_collection(
                    collection_name=PLAYBOOK_COLLECTION,
                    vectors_config=models.VectorParams(
                        size=EMBEDDING_DIM,
                        distance=models.Distance.COSINE
                    )
                )

            if DECISION_SUMMARIES_COLLECTION not in existing_names:
                print(f"[Qdrant] Creating '{DECISION_SUMMARIES_COLLECTION}' collection...")
                self.client.create_collection(
                    collection_name=DECISION_SUMMARIES_COLLECTION,
                    vectors_config=models.VectorParams(
                        size=EMBEDDING_DIM,
                        distance=models.Distance.COSINE
                    )
                )
        except Exception as e:
            print(f"[Qdrant] Warning initializing collections: {e}")

    def upsert_playbook_entries(self, entries: List[Dict[str, Any]], vectors: List[List[float]]) -> bool:
        """
        Upsert structured playbook entries with vector embeddings into Qdrant.
        """
        try:
            points = []
            for idx, (entry, vector) in enumerate(zip(entries, vectors)):
                points.append(
                    models.PointStruct(
                        id=idx + 1,
                        vector=vector,
                        payload=entry
                    )
                )

            self.client.upsert(
                collection_name=PLAYBOOK_COLLECTION,
                points=points
            )
            print(f"[Qdrant] Successfully indexed {len(points)} playbook strategies into '{PLAYBOOK_COLLECTION}'.")
            return True
        except Exception as e:
            print(f"[Qdrant] Failed to upsert playbook entries: {e}")
            return False

    def search_playbook(self, query_vector: List[float], limit: int = 3) -> List[Dict[str, Any]]:
        """
        Search for top-k matching playbook strategies using Cosine similarity.
        """
        try:
            results = self.client.query_points(
                collection_name=PLAYBOOK_COLLECTION,
                query=query_vector,
                limit=limit,
                with_payload=True
            )

            hits = []
            for hit in results.points:
                payload = hit.payload or {}
                hits.append({
                    "id": payload.get("id"),
                    "rule_code": payload.get("rule_code"),
                    "title": payload.get("title"),
                    "failure_reason": payload.get("failure_reason"),
                    "recommended_action": payload.get("recommended_action"),
                    "tool_params": payload.get("tool_params", {}),
                    "rationale": payload.get("rationale"),
                    "ml_threshold": payload.get("ml_threshold", 0.7),
                    "similarity_score": round(float(hit.score), 4)
                })
            return hits
        except Exception as e:
            print(f"[Qdrant] Search error: {e}")
            return []
