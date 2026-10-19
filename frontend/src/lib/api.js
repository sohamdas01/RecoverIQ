const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000/api';

/**
 * Merchant Authentication State Management
 *
 * The session is a bearer token issued by POST /auth/login. It is kept in localStorage so a
 * dashboard session survives reloads; the backend re-validates it (and the user's role) on
 * every request, so nothing stored here is trusted for authorization.
 */
const TOKEN_KEY = 'recoveriq_merchant_token';
const USER_KEY = 'recoveriq_merchant_user';

let memoryToken = null;
let memoryUser = null;

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export function getAuthToken() {
  if (typeof window !== 'undefined') {
    try {
      return localStorage.getItem(TOKEN_KEY) || memoryToken;
    } catch {
      return memoryToken;
    }
  }
  return memoryToken;
}

export function setAuthToken(token) {
  memoryToken = token;
  if (typeof window === 'undefined') return;
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // storage unavailable (private mode): keep the in-memory token only
  }
}

export function getStoredUser() {
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(USER_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // fall through to memory
    }
  }
  return memoryUser;
}

function setStoredUser(user) {
  memoryUser = user;
  if (typeof window === 'undefined') return;
  try {
    if (user) {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(USER_KEY);
    }
  } catch {
    // ignore
  }
}

export function clearSession() {
  setAuthToken(null);
  setStoredUser(null);
}

/**
 * Sign in with email + password. Resolves with the user profile; throws AuthError on failure.
 */
export async function login(email, password) {
  let res;
  try {
    res = await fetch(`${BACKEND_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    });
  } catch {
    throw new AuthError('Could not reach the server. Please try again.', 'NETWORK_ERROR');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    throw new AuthError(body.message || 'Sign in failed. Please try again.', body.code || 'LOGIN_FAILED');
  }

  setAuthToken(body.token);
  setStoredUser(body.user);
  return body.user;
}

export function logout() {
  clearSession();
}

/**
 * Validate the stored session against the backend and return the current user (fresh role).
 */
export async function fetchCurrentUser() {
  const res = await request('/auth/me');
  if (!res.ok) throw new Error(`Failed to load session: ${res.statusText}`);
  const body = await res.json();
  setStoredUser(body.user);
  return body.user;
}

let sessionExpiredHandler = null;

/**
 * Registered by <AuthProvider>: called when the backend rejects the stored session (401),
 * so the UI can send the user to /login without this module owning navigation.
 */
export function setSessionExpiredHandler(handler) {
  sessionExpiredHandler = handler;
}

function handleSessionExpired() {
  clearSession();
  if (sessionExpiredHandler) {
    sessionExpiredHandler();
  }
}

function getHeaders({ auth = true, customHeaders = {} } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };
  const token = auth ? getAuthToken() : null;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Central request helper for authenticated backend calls.
 * A 401 means the session is missing/expired/revoked: clear it and send the user to /login.
 */
async function request(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers: getHeaders({ auth }),
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });

  if (res.status === 401 && auth) {
    handleSessionExpired();
    throw new AuthError('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
  }
  return res;
}

/**
 * Parse an action (approve / reject / modify / review) response. Failures resolve to
 * `{ success: false, error }` with the server's message (e.g. "permission denied").
 */
async function actionResult(res) {
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  return {
    success: false,
    code: body.code,
    error: body.message || body.error?.message || body.error || res.statusText || 'Request failed',
  };
}

/**
 * Dashboard & Cases API Client Methods
 */

export async function fetchTransactions() {
  const res = await request('/transactions');
  if (!res.ok) throw new Error(`Failed to fetch transactions: ${res.statusText}`);
  return res.json();
}

export async function fetchDecisions(pendingOnly = false, limit = 50) {
  const query = new URLSearchParams();
  if (pendingOnly) query.set('pending', 'true');
  if (limit) query.set('limit', String(limit));

  const res = await request(`/decisions?${query.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch decisions: ${res.statusText}`);
  return res.json();
}

export async function fetchDecisionById(id) {
  const res = await request(`/decisions/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch decision: ${res.statusText}`);
  return res.json();
}

export async function fetchLiveActivity(limit = 20) {
  const query = new URLSearchParams({ limit: String(limit) });
  const res = await request(`/decisions/activity?${query.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch live activity: ${res.statusText}`);
  return res.json();
}

export async function fetchDashboardSummary() {
  // Fetch decisions and transactions concurrently to calculate real metric summary
  const [decisionsRes, transactionsRes] = await Promise.all([
    fetchDecisions(false, 100).catch((err) => {
      if (err instanceof AuthError) throw err;
      return { success: false, data: [] };
    }),
    fetchTransactions().catch((err) => {
      if (err instanceof AuthError) throw err;
      return { success: false, data: [] };
    }),
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
  let explanationRes = null;
  try {
    explanationRes = await request(`/admin/recovery-cases/${caseId}/explanation`);
    if (explanationRes.ok) {
      return explanationRes.json();
    }
  } catch (err) {
    if (err instanceof AuthError) throw err;
    console.warn('[API] Explanation endpoint unavailable, falling back to decision record:', err.message);
  }

  // Only a server-side/network failure falls back to the decision record. Authorization failures
  // and "not found" (which also covers another merchant's case) must surface, not be masked.
  if (explanationRes && explanationRes.status < 500) {
    const body = await explanationRes.json().catch(() => ({}));
    throw new Error(body.message || `Recovery case '${caseId}' not found`);
  }

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
  const res = await request(`/decisions/${decisionId}/review`, { method: 'POST', body: payload });
  return actionResult(res);
}

export async function approveCase(caseId, reasoning = 'Approved by merchant') {
  const res = await request(`/admin/recovery-cases/${caseId}/approve`, { method: 'POST', body: { reasoning } });
  return actionResult(res);
}

export async function rejectCase(caseId, reasoning = 'Rejected by merchant') {
  const res = await request(`/admin/recovery-cases/${caseId}/reject`, { method: 'POST', body: { reasoning } });
  return actionResult(res);
}

export async function modifyCase(caseId, { modifiedAction, modifiedParams, reasoning }) {
  const res = await request(`/admin/recovery-cases/${caseId}/modify`, {
    method: 'POST',
    body: { modifiedAction, modifiedParams, reasoning },
  });
  return actionResult(res);
}

export async function simulatePurchase(payload) {
  const res = await request('/simulate/purchase', { method: 'POST', body: payload });
  return actionResult(res);
}

export async function simulateBatch() {
  const res = await request('/simulate/batch', { method: 'POST' });
  return actionResult(res);
}

/**
 * Customer recovery portal calls: public by design (authorised by the signed link token).
 */
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
  const res = await request('/admin/recovery-cases/ask', {
    method: 'POST',
    body: { question, caseId: caseId || undefined },
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.message || `Ask RecoverIQ request failed: ${res.statusText}`);
  }
  return res.json();
}
