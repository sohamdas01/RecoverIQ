import os
import hashlib
import numpy as np
from typing import List

EMBEDDING_DIM = 1536

STOP_WORDS = {
    "the", "is", "a", "an", "for", "with", "to", "at", "in", "of", "and", "or",
    "rule", "strategy", "reason", "payment", "failure", "method", "condition",
    "rationale", "using", "recommended", "trigger", "details", "details:"
}

KEYWORD_WEIGHTS = {
    "expired": 4.5,
    "card_expired": 5.0,
    "insufficient": 4.5,
    "funds": 4.0,
    "insufficient_funds": 5.0,
    "outage": 4.5,
    "bank_outage": 5.0,
    "timeout": 4.5,
    "network_timeout": 5.0,
    "fraud": 5.0,
    "high_risk_fraud": 5.5,
    "mandate": 4.5,
    "subscription_mandate": 5.0,
    "limit": 4.0,
    "limit_exceeded": 5.0,
    "authentication": 4.5,
    "authentication_failed": 5.0,
    "3ds": 4.5,
    "upi": 4.0,
    "upi_timeout": 5.0,
    "international": 4.5,
    "currency_mismatch": 5.0,
    "retry": 3.0,
    "schedule": 3.0,
    "salary": 3.5,
    "maintenance": 3.5,
}

class EmbeddingService:
    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "")
        self.is_live = bool(self.api_key and not self.api_key.startswith("sk-placeholder"))

    def get_embedding(self, text: str) -> List[float]:
        if self.is_live:
            try:
                from openai import OpenAI
                client = OpenAI(api_key=self.api_key)
                response = client.embeddings.create(
                    input=text,
                    model="text-embedding-3-small"
                )
                return response.data[0].embedding
            except Exception as e:
                print(f"[EmbeddingService] OpenAI call failed ({e}), falling back to deterministic dense embeddings.")

        return self._generate_deterministic_embedding(text)

    def get_embeddings_batch(self, texts: List[str]) -> List[List[float]]:
        if self.is_live:
            try:
                from openai import OpenAI
                client = OpenAI(api_key=self.api_key)
                response = client.embeddings.create(
                    input=texts,
                    model="text-embedding-3-small"
                )
                return [item.embedding for item in response.data]
            except Exception as e:
                print(f"[EmbeddingService] OpenAI batch call failed ({e}), falling back to deterministic dense embeddings.")

        return [self._generate_deterministic_embedding(t) for t in texts]

    def _generate_deterministic_embedding(self, text: str) -> List[float]:
        """
        Generates a 1536-dim normalized vector using semantic token hashing with TF-IDF weighting.
        """
        vec = np.zeros(EMBEDDING_DIM, dtype=np.float32)
        clean_text = text.lower().replace("_", " ").replace("-", " ").strip()
        tokens = [t.strip(",.:;\"'()") for t in clean_text.split() if t.strip(",.:;\"'()")]

        for idx, token in enumerate(tokens):
            if token in STOP_WORDS:
                weight = 0.15
            else:
                weight = KEYWORD_WEIGHTS.get(token, 1.5)

            # Direct word hash projection
            h = int(hashlib.sha256(token.encode('utf-8')).hexdigest(), 16)
            pos = h % EMBEDDING_DIM
            vec[pos] += weight

            # Secondary harmonic for projection spread
            pos2 = (h >> 16) % EMBEDDING_DIM
            vec[pos2] += weight * 0.5

        # Character tri-grams for sub-word semantic resilience
        for i in range(len(clean_text) - 2):
            trigram = clean_text[i:i+3]
            if trigram.strip():
                h_tg = int(hashlib.md5(trigram.encode('utf-8')).hexdigest(), 16)
                pos_tg = h_tg % EMBEDDING_DIM
                vec[pos_tg] += 0.2

        # L2 Normalization
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        else:
            vec[0] = 1.0

        return vec.tolist()
