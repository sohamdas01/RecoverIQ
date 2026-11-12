// Display helpers shared by the merchant console. Raw API values stay untouched;
// these only decide how they read on screen.

const ACTION_LABELS = {
  send_recovery_message: 'Recovery link',
  schedule_retry: 'Scheduled retry',
  attempt_recovery: 'Instant retry',
  escalate_to_human: 'Escalate to human',
  log_outcome: 'Close case',
  RETRY_WITH_DISCOUNT: 'Retry with discount',
  SWITCH_GATEWAY: 'Switch gateway',
  SCHEDULE_RETRY: 'Scheduled retry',
  REQUEST_NEW_PAYMENT_METHOD: 'Request new payment method',
  OFFER_ALTERNATIVE_GATEWAY: 'Offer alternative gateway',
};

const REASON_LABELS = {
  card_expired: 'Card expired',
  insufficient_funds: 'Insufficient funds',
  high_risk_fraud: 'Suspected fraud',
  bank_outage: 'Bank outage',
  network_timeout: 'Network timeout',
  authentication_failed: 'Authentication failed',
  payment_gateway_down: 'Gateway down',
  do_not_honor: 'Do not honor',
};

export function humanize(value) {
  if (!value) return '';
  const text = String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .trim()
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function actionLabel(action) {
  if (!action) return '—';
  return ACTION_LABELS[action] || humanize(action);
}

export function reasonLabel(reason) {
  if (!reason) return 'Unknown';
  return REASON_LABELS[reason] || humanize(reason);
}

const METHOD_LABELS = {
  card: 'Card',
  upi: 'UPI',
  netbanking: 'Net banking',
  subscription_mandate: 'Subscription mandate',
};

export function methodLabel(method) {
  if (!method) return '—';
  return METHOD_LABELS[method] || humanize(method);
}

export function formatMoney(amount, currency = 'INR', { decimals = 0 } = {}) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency: currency || 'INR',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(decimals)}`;
  }
}

export function shortId(id, length = 8) {
  return id ? String(id).slice(0, length) : '—';
}

export function relativeTime(timestamp, now = Date.now()) {
  if (!timestamp) return '—';
  const then = new Date(timestamp).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function formatDateTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function toScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function scoreTone(score) {
  if (score === null) return 'muted';
  if (score >= 0.7) return 'signal';
  if (score >= 0.4) return 'hold';
  return 'stop';
}

// A case waits on a human only while its decision is still pending. Cases that
// needed approval and were since approved, modified or rejected are not pending.
export function isAwaitingReview(decision = {}) {
  return decision.status === 'pending_review';
}

// One plain-language outcome per case, combining the decision with what
// actually happened to the payment.
export function deriveOutcome(decision = {}, transaction = {}) {
  const txStatus = transaction?.status;
  const status = decision.status;
  const action = decision.finalAction || decision.recommendedAction;

  if (txStatus === 'recovered') return { key: 'recovered', label: 'Recovered', tone: 'signal' };
  if (status === 'pending_review') return { key: 'review', label: 'Needs review', tone: 'hold' };
  if (status === 'blocked') return { key: 'blocked', label: 'Blocked', tone: 'stop' };
  if (status === 'failed') return { key: 'failed', label: 'Failed', tone: 'stop' };
  if (txStatus === 'escalated' || action === 'escalate_to_human') {
    return { key: 'escalated', label: 'Escalated', tone: 'hold' };
  }
  if (txStatus === 'abandoned') return { key: 'closed', label: 'Closed', tone: 'muted' };
  if (action === 'send_recovery_message') return { key: 'progress', label: 'Link sent', tone: 'neutral' };
  if (action === 'schedule_retry') return { key: 'progress', label: 'Retry scheduled', tone: 'neutral' };
  return { key: 'progress', label: 'In progress', tone: 'neutral' };
}
