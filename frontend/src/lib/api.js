const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000/api';

/**
 * Merchant Authentication State Management
 */
let memoryToken = null;

export function getAuthToken() {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('recoveriq_merchant_token') || memoryToken;
  }
  return memoryToken;
}

export function setAuthToken(token) {
  memoryToken = token;
  if (typeof window !== 'undefined' && token) {
    localStorage.setItem('recoveriq_merchant_token', token);
  } else if (typeof window !== 'undefined' && !token) {
    localStorage.removeItem('recoveriq_merchant_token');
  }
}

export async function ensureAuthToken(merchantId = 'merchant_admin') {
  let token = getAuthToken();
  if (token) return token;

  try {
    const res = await fetch(`${BACKEND_URL}/admin/recovery-cases/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantId, role: 'admin' }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.token) {
        setAuthToken(data.token);
        return data.token;
      }
    }
  } catch (err) {
    console.warn('[API] Could not auto-generate merchant token:', err.message);
  }
  return null;
}

function getHeaders(customHeaders = {}) {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Dashboard & Cases API Client Methods
 */

export async function fetchTransactions() {
  const res = await fetch(`${BACKEND_URL}/transactions`, {
    headers: getHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Failed to fetch transactions: ${res.statusText}`);
  return res.json();
}

export async function fetchDecisions(pendingOnly = false, limit = 50) {
  const query = new URLSearchParams();
  if (pendingOnly) query.set('pending', 'true');
  if (limit) query.set('limit', String(limit));

  const res = await fetch(`${BACKEND_URL}/decisions?${query.toString()}`, {
    headers: getHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Failed to fetch decisions: ${res.statusText}`);
  return res.json();
}

export async function fetchDecisionById(id) {
  const res = await fetch(`${BACKEND_URL}/decisions/${id}`, {
    headers: getHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Failed to fetch decision: ${res.statusText}`);
  return res.json();
}

export async function fetchLiveActivity(limit = 20) {
  const query = new URLSearchParams({ limit: String(limit) });
  const res = await fetch(`${BACKEND_URL}/decisions/activity?${query.toString()}`, {
    headers: getHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Failed to fetch live activity: ${res.statusText}`);
  return res.json();
}

export async function fetchDashboardSummary() {
  // Fetch decisions and transactions concurrently to calculate real metric summary
  const [decisionsRes, transactionsRes] = await Promise.all([
    fetchDecisions(false, 100).catch(() => ({ success: false, data: [] })),
    fetchTransactions().catch(() => ({ success: false, data: [] })),
  ]);

  const cases = decisionsRes.data || [];
  const txns = transactionsRes.data || [];

  const totalCases = cases.length;

  // Pending review cases (status == 'pending_review' or guardrailResult == 'REQUIRE_APPROVAL')
  const pendingReview = cases.filter(
    (c) => c.decision?.status === 'pending_review' || c.decision?.guardrailResult === 'REQUIRE_APPROVAL'
  ).length;

  // Blocked or failed cases
  const blockedOrFailed = cases.filter(
    (c) => c.decision?.status === 'blocked' || c.decision?.guardrailResult === 'BLOCK' || c.decision?.status === 'failed'
  ).length;

  // Recovered revenue calculation (from transactions with status 'recovered' or executed decisions)
  const recoveredTxns = txns.filter(
    (t) => t.transaction?.status === 'recovered' || t.status === 'recovered'
  );

  const recoveredRevenue = recoveredTxns.reduce((acc, t) => {
    const amt = parseFloat(t.transaction?.amount || t.amount || 0);
    return acc + (isNaN(amt) ? 0 : amt);
  }, 0);

  // Active currency
  const currency = txns[0]?.transaction?.currency || cases[0]?.transaction?.currency || 'USD';

  return {
    totalCases,
    recoveredRevenue,
    recoveredCount: recoveredTxns.length,
    pendingReview,
    blockedOrFailed,
    currency,
    recentCases: cases.slice(0, 10),
  };
}

export async function fetchCaseExplanation(caseId) {
  await ensureAuthToken();
  try {
    const res = await fetch(`${BACKEND_URL}/admin/recovery-cases/${caseId}/explanation`, {
      headers: getHeaders(),
      cache: 'no-store',
    });
    if (res.ok) {
      return res.json();
    }
  } catch (err) {
    console.warn('[API] Explanation endpoint unavailable, falling back to decision record:', err.message);
  }

  // Fallback to decision record if admin explanation is unauthenticated or unavailable
  const decRes = await fetchDecisionById(caseId);
  if (decRes.success && decRes.data) {
    const { decision, transaction, customer } = decRes.data;
    const analystData = decision.agentAnalystResponse || {};
    return {
      success: true,
      data: {
        caseId: decision.id,
        transactionId: transaction?.id || decision.transactionId,
        customer: customer || {},
        transaction: transaction || {},
        status: decision.status,
        finalAction: decision.finalAction || decision.recommendedAction,
        ml: {
          score: decision.mlScore,
          probability: decision.mlScore,
          modelVersion: analystData.ml?.modelVersion || 'v1.0.0',
          reasonCodes: analystData.ml?.reasonCodes || [],
          attributions: analystData.ml?.attributions || [],
        },
        agent1: analystData.agent1 || {
          agentName: 'RecoveryAnalyst',
          recommendation: decision.recommendedAction,
          confidence: analystData.confidence || 0.8,
          rationale: decision.reasoning,
          reasonCodes: analystData.reasonCodes || [],
          playbookSources: analystData.playbookSources || [],
        },
        agent2: analystData.agent2 || {
          agentName: 'RecoveryExecutor',
          proposedAction: decision.recommendedAction,
          confidence: analystData.confidence || 0.8,
          rationale: decision.reasoning,
          parameters: analystData.toolParams || {},
        },
        policy: {
          decision: decision.guardrailResult,
          policyVersion: analystData.policyVersion || 'v1',
          primaryRuleId: analystData.ruleId,
          appliedRules: analystData.appliedRules || [],
          reasons: [decision.reasoning],
        },
        humanReview: analystData.humanReview || null,
        execution: analystData.execution || null,
        actions: [],
        timeline: [],
        createdAt: decision.createdAt,
      },
    };
  }
  throw new Error(`Recovery case '${caseId}' not found`);
}

export async function reviewDecision(decisionId, payload) {
  await ensureAuthToken();
  const res = await fetch(`${BACKEND_URL}/decisions/${decisionId}/review`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function approveCase(caseId, reasoning = 'Approved by merchant') {
  await ensureAuthToken();
  const res = await fetch(`${BACKEND_URL}/admin/recovery-cases/${caseId}/approve`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ reasoning }),
  });
  if (!res.ok) {
    // Fallback to decisions review endpoint
    return reviewDecision(caseId, { reviewAction: 'approve', merchantReasoning: reasoning });
  }
  return res.json();
}

export async function rejectCase(caseId, reasoning = 'Rejected by merchant') {
  await ensureAuthToken();
  const res = await fetch(`${BACKEND_URL}/admin/recovery-cases/${caseId}/reject`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ reasoning }),
  });
  if (!res.ok) {
    return reviewDecision(caseId, { reviewAction: 'reject', merchantReasoning: reasoning });
  }
  return res.json();
}

export async function modifyCase(caseId, { modifiedAction, modifiedParams, reasoning }) {
  await ensureAuthToken();
  const res = await fetch(`${BACKEND_URL}/admin/recovery-cases/${caseId}/modify`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ modifiedAction, modifiedParams, reasoning }),
  });
  if (!res.ok) {
    return reviewDecision(caseId, {
      reviewAction: 'modify',
      modifiedAction,
      modifiedParams,
      merchantReasoning: reasoning,
    });
  }
  return res.json();
}

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

/**
 * Ask RecoverIQ Grounded Explainer Query
 *
 * @param {Object} params
 * @param {string} params.question Natural language question
 * @param {string} [params.caseId] Optional case ID filter
 * @returns {Promise<Object>}
 */
export async function askRecoverIQ({ question, caseId }) {
  await ensureAuthToken();
  try {
    const res = await fetch(`${BACKEND_URL}/admin/recovery-cases/ask`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ question, caseId: caseId || undefined }),
    });
    if (res.ok) {
      return res.json();
    }
  } catch (err) {
    console.warn('[API] /admin/recovery-cases/ask failed, trying /admin/ask fallback:', err.message);
  }

  const fallbackRes = await fetch(`${BACKEND_URL}/admin/ask`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ question, caseId: caseId || undefined }),
  });
  if (!fallbackRes.ok) {
    const errBody = await fallbackRes.json().catch(() => ({}));
    throw new Error(errBody.message || `Ask RecoverIQ request failed: ${fallbackRes.statusText}`);
  }
  return fallbackRes.json();
}
