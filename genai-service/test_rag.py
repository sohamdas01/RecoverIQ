import asyncio
from agents.single_agent import SingleRecoveryAgent

async def main():
    agent = SingleRecoveryAgent()
    test_cases = [
        {"failureReason": "card_expired", "paymentMethod": "card", "amount": 2999, "attemptCount": 1},
        {"failureReason": "bank_outage", "paymentMethod": "upi", "amount": 4999, "attemptCount": 1},
        {"failureReason": "high_risk_fraud", "paymentMethod": "card", "amount": 95000, "attemptCount": 1},
        {"failureReason": "insufficient_funds", "paymentMethod": "card", "amount": 1499, "attemptCount": 1},
    ]

    print("\n--- Testing Qdrant RAG Playbook Retrieval ---")
    for tc in test_cases:
        res = await agent.analyze_and_recommend(tc)
        strat = res.get("playbookStrategy", {})
        print(f"Reason: {tc['failureReason']} -> Strategy: [{strat.get('ruleCode')}] {strat.get('title')} | Action: {res.get('action')}")
        print(f"   Reasoning: {res.get('reasoning')}\n")

if __name__ == "__main__":
    asyncio.run(main())
