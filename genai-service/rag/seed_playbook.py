import sys
import os

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rag.playbook_data import PLAYBOOK_ENTRIES
from rag.embeddings import EmbeddingService
from rag.qdrant_store import QdrantManager

def seed_playbook_vectors():
    print(f"[Seed Playbook] Initializing Qdrant and Embedding Service...")
    embedding_service = EmbeddingService()
    qdrant_manager = QdrantManager()

    texts_to_embed = []
    for entry in PLAYBOOK_ENTRIES:
        # Construct dense semantic representation for retrieval
        semantic_repr = (
            f"Rule {entry['rule_code']}: {entry['title']}. "
            f"Failure Reason: {entry['failure_reason']}. "
            f"Payment Method: {entry['payment_method']}. "
            f"Trigger Condition: {entry['trigger']}. "
            f"Recommended Strategy: {entry['recommended_action']}. "
            f"Rationale: {entry['rationale']}"
        )
        texts_to_embed.append(semantic_repr)

    print(f"[Seed Playbook] Generating vector embeddings for {len(texts_to_embed)} playbook strategies...")
    vectors = embedding_service.get_embeddings_batch(texts_to_embed)

    print(f"[Seed Playbook] Upserting vectors into Qdrant 'recovery-playbook' collection...")
    success = qdrant_manager.upsert_playbook_entries(PLAYBOOK_ENTRIES, vectors)

    if success:
        print("[Seed Playbook] [OK] Successfully seeded 16 recovery playbook strategies into Qdrant vector store!")
    else:
        print("[Seed Playbook] [ERROR] Failed to seed playbook entries into Qdrant.")

if __name__ == "__main__":
    seed_playbook_vectors()
