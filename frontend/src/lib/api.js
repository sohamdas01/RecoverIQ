const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000/api';

export async function simulatePurchase(payload) {
  const res = await fetch(`${BACKEND_URL}/simulate/purchase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function simulateBatch() {
  const res = await fetch(`${BACKEND_URL}/simulate/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return res.json();
}

export async function fetchTransactions() {
  const res = await fetch(`${BACKEND_URL}/transactions`, { cache: 'no-store' });
  return res.json();
}

export async function fetchDecisions(pendingOnly = false) {
  const res = await fetch(`${BACKEND_URL}/decisions?pending=${pendingOnly}`, { cache: 'no-store' });
  return res.json();
}

export async function reviewDecision(decisionId, payload) {
  const res = await fetch(`${BACKEND_URL}/decisions/${decisionId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function getRecoveryDetails(token) {
  const res = await fetch(`${BACKEND_URL}/recover/${token}`, { cache: 'no-store' });
  return res.json();
}

export async function submitRecoveryPayment(token, payload) {
  const res = await fetch(`${BACKEND_URL}/recover/${token}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
