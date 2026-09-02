import os
import json
from typing import Dict, Any
from rag.playbook_retriever import PlaybookRetriever
from prompts.recovery_prompts import RECOVERY_ANALYST_SYSTEM_PROMPT

class SingleRecoveryAgent:
    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "")
        self.model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        self.retriever = PlaybookRetriever()

    async def analyze_and_recommend(self, transaction: Dict[str, Any]) -> Dict[str, Any]:
        """
        Analyze a failed payment transaction, retrieve relevant playbook strategies
        from Qdrant vector store, and generate a strategy-grounded recommendation.
        """
        failure_reason = transaction.get("failureReason", "")
        amount = float(transaction.get("amount", 0))
        attempt_count = int(transaction.get("attemptCount", 1))
        payment_method = transaction.get("paymentMethod", "card")

        # 1. RAG Retrieval from Qdrant Vector Store
        retrieved_strategies = self.retriever.retrieve_strategies(transaction, top_k=2)
        top_strategy = retrieved_strategies[0] if retrieved_strategies else None

        # 2. If OpenAI key is active, use LLM with RAG injected context
        if self.api_key and not self.api_key.startswith("sk-placeholder"):
            try:
                return await self._call_openai_with_rag(transaction, retrieved_strategies)
            except Exception as e:
                print(f"[SingleRecoveryAgent] OpenAI call error ({e}), using RAG deterministic engine.")

        # 3. Deterministic RAG Reasoning Engine
        return self._synthesize_rag_decision(transaction, top_strategy, retrieved_strategies)

    def _synthesize_rag_decision(
        self,
        transaction: Dict[str, Any],
        top_strategy: Dict[str, Any],
        all_strategies: list
    ) -> Dict[str, Any]:
        if not top_strategy:
            return {
                "action": "send_recovery_message",
                "toolParams": {"channel": "email"},
                "confidence": 0.75,
                "reasoning": "Standard recovery message fallback.",
                "mlScore": 0.70,
                "playbookStrategy": None
            }

        rule_code = top_strategy.get("rule_code", "PB-GEN")
        title = top_strategy.get("title", "Standard Recovery Policy")
        action = top_strategy.get("recommended_action", "send_recovery_message")
        tool_params = top_strategy.get("tool_params", {})
        rationale = top_strategy.get("rationale", "")
        similarity = top_strategy.get("similarity_score", 0.90)
        ml_score = top_strategy.get("ml_threshold", 0.75)

        grounded_reasoning = (
            f"[{rule_code}: {title}] (Qdrant Match: {similarity * 100:.1f}%) — {rationale}"
        )

        return {
            "action": action,
            "toolParams": tool_params,
            "confidence": min(0.98, max(0.80, similarity)),
            "reasoning": grounded_reasoning,
            "mlScore": ml_score,
            "playbookStrategy": {
                "ruleCode": rule_code,
                "title": title,
                "similarityScore": similarity,
                "rationale": rationale,
                "retrievedCount": len(all_strategies)
            }
        }

    async def _call_openai_with_rag(self, transaction: Dict[str, Any], strategies: list) -> Dict[str, Any]:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=self.api_key)

        rag_context = "\n\n".join([
            f"- Strategy {s.get('rule_code')}: {s.get('title')}\n"
            f"  Action: {s.get('recommended_action')}\n"
            f"  Params: {json.dumps(s.get('tool_params'))}\n"
            f"  Rationale: {s.get('rationale')}\n"
            f"  Relevance Score: {s.get('similarity_score')}"
            for s in strategies
        ])

        user_content = (
            f"Transaction Details:\n"
            f"- Failure Reason: {transaction.get('failureReason')}\n"
            f"- Payment Method: {transaction.get('paymentMethod')}\n"
            f"- Amount: {transaction.get('currency', 'INR')} {transaction.get('amount')}\n"
            f"- Attempt Count: {transaction.get('attemptCount')}\n\n"
            f"Retrieved Playbook Strategies (Qdrant):\n{rag_context}\n\n"
            f"Recommend the optimal recovery action strictly following the playbook."
        )

        response = await client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": RECOVERY_ANALYST_SYSTEM_PROMPT},
                {"role": "user", "content": user_content}
            ],
            response_format={"type": "json_object"},
            temperature=0.2
        )

        content = response.choices[0].message.content
        parsed = json.loads(content)
        top = strategies[0] if strategies else {}
        parsed["playbookStrategy"] = {
            "ruleCode": top.get("rule_code", "PB-RAG"),
            "title": top.get("title", "Retrieved Strategy"),
            "similarityScore": top.get("similarity_score", 0.92),
            "rationale": top.get("rationale", "")
        }
        return parsed
