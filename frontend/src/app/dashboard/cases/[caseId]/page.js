'use client';

import React, { useState, useEffect, useCallback, use } from 'react';
import Link from 'next/link';
import Header from '@/components/Header';
import { Badge, OutcomeBadge, PolicyBadge } from '@/components/StatusBadge';
import AskRecoverIQPanel from '@/components/AskRecoverIQPanel';
import { useAuth } from '@/components/AuthProvider';
import { fetchCaseExplanation, approveCase, rejectCase, modifyCase } from '@/lib/api';
import {
  actionLabel,
  formatDateTime,
  formatMoney,
  formatTime,
  humanize,
  methodLabel,
  reasonLabel,
  scoreTone,
  shortId,
  toScore,
} from '@/lib/format';

const TONE_TEXT = { signal: 'text-signal', hold: 'text-hold', stop: 'text-stop', muted: 'text-muted' };
const field =
  'w-full rounded-lg border border-line bg-ink px-3.5 py-2.5 text-sm text-paper placeholder:text-muted/70 focus-visible:border-signal focus-visible:outline-none';
const labelText = 'block text-xs font-medium text-paper/85';

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function Step({ index, title, meta, time, tone = 'neutral', last = false, children }) {
  const node = {
    signal: 'border-signal text-signal',
    hold: 'border-hold text-hold',
    stop: 'border-stop text-stop',
    neutral: 'border-line text-paper/85',
  }[tone];
  return (
    <li className="relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 sm:gap-x-5">
      {!last && <span aria-hidden="true" className="absolute bottom-0 left-[1.125rem] top-10 w-px -translate-x-1/2 bg-line" />}
      <span
        aria-hidden="true"
        className={`relative z-10 flex size-9 items-center justify-center rounded-full border bg-ink-raised font-mono text-xs ${node}`}
      >
        {String(index).padStart(2, '0')}
      </span>
      <div className={last ? 'pb-1' : 'pb-9'}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pt-1.5">
          <h3 className="text-base font-medium text-paper">{title}</h3>
          {time && <span className="font-mono text-[11px] text-muted">{time}</span>}
        </div>
        {meta && <p className="mt-0.5 text-xs text-muted">{meta}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </li>
  );
}

function Fact({ label, children, mono = false }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className={`min-w-0 truncate text-right text-sm text-paper ${mono ? 'font-mono text-xs' : ''}`}>{children}</dd>
    </div>
  );
}

// Diverging bars around a zero line: green pushes toward recovery, red away.
// Each bar carries its signed value and a description, so colour is never the only cue.
function AttributionBars({ attributions = [] }) {
  const merged = new Map();
  for (const a of attributions) {
    const prev = merged.get(a.code);
    merged.set(a.code, prev ? { ...prev, shap_value: (Number(prev.shap_value) || 0) + (Number(a.shap_value) || 0) } : a);
  }
  const rows = [...merged.values()].sort((a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value)).slice(0, 6);
  const max = Math.max(...rows.map((r) => Math.abs(Number(r.shap_value) || 0)), 0.01);
  return (
    <ul className="space-y-3">
      {rows.map((r, i) => {
        const value = Number(r.shap_value) || 0;
        const width = `${(Math.abs(value) / max) * 50}%`;
        const positive = value >= 0;
        return (
          <li key={`${r.code}-${i}`} title={r.description}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-paper/90">{humanize(r.code)}</span>
              <span className={`shrink-0 font-mono tabular-nums ${positive ? 'text-signal' : 'text-stop'}`}>
                {positive ? '+' : '−'}
                {Math.abs(value).toFixed(2)}
              </span>
            </div>
            <div className="relative mt-1.5 h-1.5 rounded-full bg-line/60" aria-hidden="true">
              <span className="absolute inset-y-[-3px] left-1/2 w-px bg-muted/50" />
              <span
                className={`absolute inset-y-0 rounded-full ${positive ? 'left-1/2 bg-signal' : 'right-1/2 bg-stop'}`}
                style={{ width }}
              />
            </div>
            {r.description && <p className="mt-1 text-[11px] leading-snug text-muted">{r.description}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function Modal({ title, description, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-lg rounded-2xl border border-line bg-ink-raised p-6 shadow-2xl shadow-black/40">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-display text-2xl tracking-tight text-paper">{title}</h3>
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-xl leading-none text-muted hover:text-paper">
            ×
          </button>
        </div>
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function CaseDetailPage({ params }) {
  const { caseId } = use(params);

  const [caseData, setCaseData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const { canReview } = useAuth();
  const [feedback, setFeedback] = useState(null);

  const [reviewReason, setReviewReason] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showModifyModal, setShowModifyModal] = useState(false);

  // Supported bounded parameters for modification
  const [modifiedAction, setModifiedAction] = useState('RETRY_WITH_DISCOUNT');
  const [modifiedDiscount, setModifiedDiscount] = useState('10');
  const [modifiedChannel, setModifiedChannel] = useState('email');
  const [modifiedDelay, setModifiedDelay] = useState('2');
  const [modifiedGateway, setModifiedGateway] = useState('stripe_backup');
  const [modifyReason, setModifyReason] = useState('');
  const [modifyValidationErr, setModifyValidationErr] = useState(null);

  const fetchCase = useCallback(async () => {
    try {
      const res = await fetchCaseExplanation(caseId);
      if (res.success && res.data) {
        setCaseData(res.data);
      } else {
        throw new Error(res.error || 'Failed to load case details');
      }
    } catch (err) {
      console.error('[CaseDetail] Error loading case:', err);
      setError(err.message || 'Error loading recovery case');
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  const loadCase = () => {
    setLoading(true);
    setError(null);
    return fetchCase();
  };

  useEffect(() => {
    if (!caseId) return undefined;
    // Initial fetch is scheduled (not called inline) so state updates happen from a callback
    const initialLoad = setTimeout(fetchCase, 0);
    return () => clearTimeout(initialLoad);
  }, [caseId, fetchCase]);

  const handleApprove = async () => {
    setActionLoading(true);
    setFeedback(null);
    try {
      const res = await approveCase(caseId, reviewReason || 'Approved by merchant reviewer via dashboard');
      if (res.success) {
        setFeedback({ type: 'success', message: 'Approved. The policy engine re-checked the action and dispatched it.' });
        setReviewReason('');
        await loadCase();
      } else {
        setFeedback({ type: 'error', message: res.error || 'Failed to approve recovery action.' });
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'Error executing approval' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleRejectSubmit = async (e) => {
    e.preventDefault();
    if (!rejectReason.trim()) {
      setFeedback({ type: 'error', message: 'Please provide a reason for rejecting this case.' });
      return;
    }
    setActionLoading(true);
    setFeedback(null);
    try {
      const res = await rejectCase(caseId, rejectReason);
      if (res.success) {
        setShowRejectModal(false);
        setRejectReason('');
        setFeedback({ type: 'success', message: 'Rejected. No automated or customer-facing action will be taken.' });
        await loadCase();
      } else {
        setFeedback({ type: 'error', message: res.error || 'Failed to reject recovery case.' });
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'Error executing rejection' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleModifySubmit = async (e) => {
    e.preventDefault();
    setModifyValidationErr(null);

    if (!modifyReason.trim()) {
      setModifyValidationErr('Merchant override reason is required.');
      return;
    }

    const modifiedParams = {};
    if (modifiedAction === 'RETRY_WITH_DISCOUNT') {
      const disc = parseInt(modifiedDiscount, 10);
      if (isNaN(disc) || disc < 5 || disc > 30) {
        setModifyValidationErr('Discount percentage must be between 5% and 30%.');
        return;
      }
      modifiedParams.discount_percent = disc;
      modifiedParams.channel = modifiedChannel;
    } else if (modifiedAction === 'SWITCH_GATEWAY') {
      if (!modifiedGateway) {
        setModifyValidationErr('A fallback payment gateway must be selected.');
        return;
      }
      modifiedParams.fallback_gateway = modifiedGateway;
    } else if (modifiedAction === 'SCHEDULE_RETRY') {
      const delay = parseInt(modifiedDelay, 10);
      if (isNaN(delay) || delay < 1 || delay > 72) {
        setModifyValidationErr('Retry delay must be between 1 and 72 hours.');
        return;
      }
      modifiedParams.delay_hours = delay;
    }

    setActionLoading(true);
    setFeedback(null);
    try {
      const res = await modifyCase(caseId, { modifiedAction, modifiedParams, reasoning: modifyReason });
      if (res.success) {
        setShowModifyModal(false);
        setModifyReason('');
        setFeedback({ type: 'success', message: `Changed to ${actionLabel(modifiedAction)}. The policy engine re-evaluated it.` });
        await loadCase();
      } else {
        setFeedback({ type: 'error', message: res.error || 'Failed to modify recovery case.' });
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'Error modifying case' });
    } finally {
      setActionLoading(false);
    }
  };

  /* ----------------------------- states ----------------------------- */

  if (loading && !caseData) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Header eyebrow={`Recovery case · ${shortId(caseId)}`} title="Loading case…" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="h-[32rem] animate-pulse rounded-2xl bg-ink-raised" />
          <div className="h-80 animate-pulse rounded-2xl bg-ink-raised" />
        </div>
      </div>
    );
  }

  if (error || !caseData) {
    return (
      <div className="space-y-6">
        <Header eyebrow={`Recovery case · ${shortId(caseId)}`} title="Case unavailable" />
        <div className="rounded-2xl border border-line bg-ink-raised px-6 py-14 text-center">
          <p className="text-sm font-medium text-stop">{error || 'The requested case could not be found.'}</p>
          <div className="mt-6 flex justify-center gap-3">
            <button type="button" onClick={loadCase} className="rounded-full border border-line px-4 py-2 text-xs text-paper hover:border-paper/60">
              Retry
            </button>
            <Link href="/dashboard/cases" className="rounded-full bg-signal px-4 py-2 text-xs font-semibold text-ink hover:bg-paper">
              Back to cases
            </Link>
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------ data ------------------------------ */

  const {
    transaction = {},
    customer = {},
    ml = {},
    agent1 = {},
    agent2 = {},
    policy = {},
    overrides = [],
    humanReview,
    execution,
    status,
    finalAction,
    createdAt,
  } = caseData;

  const decision = { status, finalAction, recommendedAction: agent1.recommendation };
  const isPendingReview = status === 'pending_review';
  const score = toScore(ml.score ?? ml.probability);
  const scorePct = score === null ? null : Math.round(score * 100);
  const confidence = toScore(agent1.confidence);
  const playbooks = agent1.playbookSources || [];
  const toolParams = agent2.parameters || {};
  const recoveryUrl = execution?.result?.recoveryUrl || execution?.recoveryUrl;
  const review = humanReview || (overrides[0] ? { reviewAction: overrides[0].merchantAction, reasoning: overrides[0].merchantReasoning, reviewedAt: overrides[0].createdAt } : null);
  const policyTone = policy.decision === 'ALLOW' ? 'signal' : policy.decision === 'BLOCK' ? 'stop' : policy.decision ? 'hold' : 'neutral';
  const executed = execution && (execution.success || execution.status === 'success');

  const steps = [
    {
      key: 'ingest',
      title: 'Failed payment received',
      meta: 'Ingested from the payments stream',
      time: formatTime(transaction.createdAt),
      tone: 'stop',
      body: (
        <p className="text-sm leading-relaxed text-paper/85">
          A payment of{' '}
          <span className="text-paper">{formatMoney(transaction.amount, transaction.currency, { decimals: 2 })}</span> was declined:{' '}
          <span className="text-stop">{reasonLabel(transaction.failureReason)}</span>
          {transaction.attemptCount ? ` on attempt ${transaction.attemptCount}` : ''}.
        </p>
      ),
    },
    {
      key: 'ml',
      title: 'Recovery likelihood scored',
      meta: `XGBoost model ${ml.modelVersion || ''}${ml.isFallback ? ' · fallback score' : ''}`.trim(),
      tone: scoreTone(score) === 'muted' ? 'neutral' : scoreTone(score),
      body: (
        <div className="grid gap-6 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <div>
            <p className={`font-display text-5xl leading-none tracking-tight ${TONE_TEXT[scoreTone(score)]}`}>
              {scorePct === null ? '—' : `${scorePct}%`}
            </p>
            <p className="mt-2 text-xs text-muted">chance this payment can be recovered</p>
          </div>
          {ml.attributions?.length > 0 ? (
            <div>
              <p className="mb-3 text-[11px] uppercase tracking-[0.12em] text-muted">What moved the score</p>
              <AttributionBars attributions={ml.attributions} />
            </div>
          ) : ml.reasonCodes?.length > 0 ? (
            <ul className="flex flex-wrap gap-2 self-start">
              {ml.reasonCodes.map((code, i) => (
                <li key={`${code}-${i}`} className="rounded-full border border-line px-2.5 py-1 text-xs text-paper/85">{humanize(code)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ),
    },
    {
      key: 'analyst',
      title: 'Analyst agent recommended',
      meta: confidence !== null ? `${Math.round(confidence * 100)}% confidence · grounded in ${playbooks.length} playbook${playbooks.length === 1 ? '' : 's'}` : null,
      tone: 'neutral',
      body: (
        <div className="space-y-4">
          <p className="text-sm text-paper">
            Recommends <span className="font-medium text-signal">{actionLabel(agent1.recommendation)}</span>
          </p>
          {agent1.rationale && (
            <blockquote className="border-l-2 border-signal/60 pl-4 text-sm leading-relaxed text-paper/85">{agent1.rationale}</blockquote>
          )}
          {playbooks.length > 0 && (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {playbooks.map((pb, idx) => {
                const sim = toScore(pb.similarity ?? pb.similarityScore);
                return (
                  <li key={`${pb.id || "pb"}-${idx}`} className="flex items-center gap-4 px-4 py-3">
                    <span className="font-mono text-[11px] text-muted">{pb.playbookId || pb.id || `PB-${idx + 1}`}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-paper/90">{pb.title || pb.ruleTitle}</span>
                    {sim !== null && (
                      <span className="shrink-0 font-mono text-xs tabular-nums text-paper/85" title="Vector similarity">
                        {(sim * 100).toFixed(0)}% match
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ),
    },
    {
      key: 'executor',
      title: 'Executor agent proposed',
      meta: agent2.latencyMs ? `Planned in ${agent2.latencyMs} ms` : null,
      tone: 'neutral',
      body: (
        <div className="space-y-4">
          <p className="text-sm text-paper">
            Proposes <span className="font-medium text-signal">{actionLabel(agent2.proposedAction || finalAction)}</span>
          </p>
          {Object.keys(toolParams).length > 0 && (
            <dl className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
              {Object.entries(toolParams).map(([k, v]) => (
                <div key={k} className={`bg-ink px-4 py-3 sm:last:odd:col-span-2 ${String(v).length > 40 ? 'sm:col-span-2' : ''}`}>
                  <dt className="text-[11px] text-muted">{humanize(k)}</dt>
                  <dd className="mt-1 break-words text-sm text-paper">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ),
    },
    {
      key: 'policy',
      title: 'Policy engine checked it',
      meta: [policy.policyVersion && `Policy ${policy.policyVersion}`, policy.primaryRuleId].filter(Boolean).join(' · ') || null,
      time: formatTime(policy.evaluatedAt),
      tone: policyTone,
      body: (
        <div className="space-y-3">
          <PolicyBadge decision={policy.decision} />
          {policy.reasons?.length > 0 && (
            <ul className="space-y-1.5 text-sm text-paper/85">
              {policy.reasons.map((r, i) => (
                <li key={i} className="flex gap-2.5">
                  <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-muted" />
                  {r}
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
    },
    ...(review
      ? [
          {
            key: 'review',
            title: `Reviewer ${review.reviewAction === 'REJECT' ? 'rejected' : review.reviewAction === 'APPROVE' ? 'approved' : 'changed'} it`,
            time: formatDateTime(review.reviewedAt),
            tone: review.reviewAction === 'REJECT' ? 'stop' : 'hold',
            body: (
              <p className="text-sm leading-relaxed text-paper/85">
                {review.reasoning ? `“${review.reasoning}”` : 'No note was left.'}
                {review.reviewAction && !['APPROVE', 'REJECT'].includes(review.reviewAction) && (
                  <> New action: <span className="text-paper">{actionLabel(review.reviewAction)}</span>.</>
                )}
              </p>
            ),
          },
        ]
      : []),
    {
      key: 'execution',
      title: isPendingReview ? 'Waiting for a reviewer' : executed ? 'Action executed' : status === 'blocked' ? 'Nothing was executed' : 'Execution',
      time: formatTime(execution?.executedAt),
      tone: isPendingReview ? 'hold' : executed ? 'signal' : status === 'blocked' ? 'stop' : 'neutral',
      body: isPendingReview ? (
        <p className="text-sm text-paper/85">The proposed action is held until someone approves, changes or rejects it.</p>
      ) : executed ? (
        <div className="space-y-3 text-sm text-paper/85">
          <p>
            Ran <span className="text-paper">{actionLabel(execution.toolName)}</span>
            {execution.result?.channel ? ` over ${execution.result.channel}` : ''}
            {execution.result?.outcome ? ` · ${humanize(execution.result.outcome).toLowerCase()}` : ''}.
          </p>
          {recoveryUrl && (
            <a href={recoveryUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-signal hover:text-paper">
              Open the customer&apos;s recovery page ↗
            </a>
          )}
        </div>
      ) : (
        <p className="text-sm text-paper/85">
          {review?.reviewAction === 'REJECT'
            ? 'The reviewer rejected the case, so no action ran.'
            : status === 'blocked'
              ? 'The policy engine stopped this case before any action ran.'
              : execution
                ? `The action did not complete (${humanize(execution.status || 'unknown').toLowerCase()}).`
                : 'No execution has been recorded yet.'}
        </p>
      ),
    },
  ];

  return (
    <div className="space-y-6 pb-16">
      <Link href="/dashboard/cases" className="inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-paper">
        <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
        </svg>
        All cases
      </Link>

      <Header
        eyebrow={`Case ${shortId(caseId)} · opened ${formatDateTime(createdAt || transaction.createdAt)}`}
        title={`${formatMoney(transaction.amount, transaction.currency)} from ${customer.name || 'an unknown customer'}`}
        subtitle={`${reasonLabel(transaction.failureReason)} · ${actionLabel(finalAction || agent1.recommendation)} · ${
          policy.decision === 'ALLOW' ? 'cleared automatically' : policy.decision === 'BLOCK' ? 'blocked by policy' : isPendingReview ? 'waiting for a reviewer' : 'needed a reviewer'
        }`}
        onRefresh={loadCase}
        refreshing={loading}
      >
        <OutcomeBadge decision={decision} transaction={transaction} />
      </Header>

      {feedback && (
        <div
          role="status"
          className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm ${
            feedback.type === 'success' ? 'bg-signal/10 text-signal' : 'bg-stop/10 text-stop'
          }`}
        >
          <span>{feedback.message}</span>
          <button type="button" onClick={() => setFeedback(null)} aria-label="Dismiss" className="text-lg leading-none text-muted hover:text-paper">
            ×
          </button>
        </div>
      )}

      {isPendingReview && (
        <section className="overflow-hidden rounded-2xl border border-hold/40 bg-hold/[0.06]">
          <div className="flex flex-col gap-5 p-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-hold">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-hold" />
                Decision needed
              </p>
              <h2 className="mt-2 font-display text-3xl tracking-tight text-paper">
                Approve {actionLabel(agent2.proposedAction || agent1.recommendation).toLowerCase()}?
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-paper/80">
                {policy.reasons?.[0] || 'This case crossed a policy threshold, so nothing runs until a reviewer decides.'}
              </p>
            </div>
            {canReview ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowRejectModal(true)}
                  disabled={actionLoading}
                  className="rounded-full border border-line px-4 py-2 text-sm text-paper transition-colors hover:border-stop hover:text-stop disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  type="button"
                  onClick={() => setShowModifyModal(true)}
                  disabled={actionLoading}
                  className="rounded-full border border-line px-4 py-2 text-sm text-paper transition-colors hover:border-paper/60 disabled:opacity-50"
                >
                  Change action
                </button>
                <button
                  type="button"
                  onClick={handleApprove}
                  disabled={actionLoading}
                  className="rounded-full bg-signal px-5 py-2 text-sm font-semibold text-ink transition-colors hover:bg-paper disabled:opacity-50"
                >
                  {actionLoading ? 'Saving…' : 'Approve'}
                </button>
              </div>
            ) : (
              <Badge tone="muted">Read-only: your role cannot review cases</Badge>
            )}
          </div>
          {canReview && (
            <div className="border-t border-hold/25 px-6 py-4">
              <label htmlFor="review-note" className="sr-only">Reviewer note</label>
              <input
                id="review-note"
                type="text"
                value={reviewReason}
                onChange={(e) => setReviewReason(e.target.value)}
                placeholder="Optional note for the audit log, saved with your approval"
                className="w-full bg-transparent text-sm text-paper placeholder:text-muted/80 focus-visible:outline-none"
              />
            </div>
          )}
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="rounded-2xl border border-line bg-ink-raised p-6 sm:p-8">
          <div className="mb-8 flex items-baseline justify-between gap-4">
            <h2 className="font-display text-3xl tracking-tight text-paper">Decision trail</h2>
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{steps.length} steps</span>
          </div>
          <ol>
            {steps.map((step, i) => (
              <Step key={step.key} index={i + 1} title={step.title} meta={step.meta} time={step.time} tone={step.tone} last={i === steps.length - 1}>
                {step.body}
              </Step>
            ))}
          </ol>
        </section>

        <aside className="space-y-6 lg:sticky lg:top-8 lg:self-start">
          <section className="rounded-2xl border border-line bg-ink-raised p-6">
            <h2 className="text-sm font-medium text-paper">Case facts</h2>
            <dl className="mt-3 divide-y divide-line">
              <Fact label="Customer">{customer.name || '—'}</Fact>
              <Fact label="Email">
                <span title={customer.email}>{customer.email || '—'}</span>
              </Fact>
              <Fact label="Amount">{formatMoney(transaction.amount, transaction.currency, { decimals: 2 })}</Fact>
              <Fact label="Method">{methodLabel(transaction.paymentMethod)}</Fact>
              <Fact label="Decline">{reasonLabel(transaction.failureReason)}</Fact>
              <Fact label="Attempt">{transaction.attemptCount ?? '—'}</Fact>
              <Fact label="Payment status">{humanize(transaction.status) || '—'}</Fact>
            </dl>
          </section>

          <section className="rounded-2xl border border-line bg-ink-raised p-6">
            <h2 className="text-sm font-medium text-paper">References</h2>
            <dl className="mt-3 divide-y divide-line">
              <Fact label="Case" mono>
                <span title={caseId}>{shortId(caseId, 13)}</span>
              </Fact>
              <Fact label="Transaction" mono>
                <span title={transaction.id}>{shortId(transaction.id || caseData.transactionId, 13)}</span>
              </Fact>
              <Fact label="Model" mono>{ml.modelVersion || '—'}</Fact>
              <Fact label="Policy" mono>{policy.policyVersion || '—'}</Fact>
              <Fact label="Rule" mono>
                <span title={policy.primaryRuleId}>{policy.primaryRuleId || '—'}</span>
              </Fact>
            </dl>
          </section>
        </aside>
      </div>

      <AskRecoverIQPanel activeCaseId={caseId} cases={[{ id: caseId, decision: { id: caseId }, transaction }]} />

      {showRejectModal && (
        <Modal
          title="Reject this case"
          description="No automated or customer-facing action will run for this payment."
          onClose={() => setShowRejectModal(false)}
        >
          <form onSubmit={handleRejectSubmit} className="space-y-5">
            <label className="block">
              <span className={labelText}>Reason, saved to the audit trail</span>
              <textarea
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. Customer contacted support directly"
                className={`${field} mt-2`}
                required
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowRejectModal(false)} className="rounded-full px-4 py-2 text-sm text-muted hover:text-paper">
                Cancel
              </button>
              <button type="submit" disabled={actionLoading} className="rounded-full bg-stop px-5 py-2 text-sm font-semibold text-ink hover:bg-paper disabled:opacity-50">
                {actionLoading ? 'Rejecting…' : 'Reject case'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showModifyModal && (
        <Modal
          title="Change the action"
          description="Choose a bounded alternative. The policy engine checks it again before it runs."
          onClose={() => setShowModifyModal(false)}
        >
          <form onSubmit={handleModifySubmit} className="space-y-5">
            {modifyValidationErr && <p className="rounded-lg bg-stop/10 px-3.5 py-2.5 text-sm text-stop">{modifyValidationErr}</p>}

            <label className="block">
              <span className={labelText}>Action</span>
              <select value={modifiedAction} onChange={(e) => setModifiedAction(e.target.value)} className={`${field} mt-2`}>
                <option value="RETRY_WITH_DISCOUNT">Retry with a discount</option>
                <option value="SWITCH_GATEWAY">Switch to a fallback gateway</option>
                <option value="SCHEDULE_RETRY">Schedule a later retry</option>
                <option value="REQUEST_NEW_PAYMENT_METHOD">Ask for a new payment method</option>
                <option value="OFFER_ALTERNATIVE_GATEWAY">Offer an alternative gateway</option>
              </select>
            </label>

            {modifiedAction === 'RETRY_WITH_DISCOUNT' && (
              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className={labelText}>Discount (5–30%)</span>
                  <input type="number" min="5" max="30" value={modifiedDiscount} onChange={(e) => setModifiedDiscount(e.target.value)} className={`${field} mt-2`} />
                </label>
                <label className="block">
                  <span className={labelText}>Channel</span>
                  <select value={modifiedChannel} onChange={(e) => setModifiedChannel(e.target.value)} className={`${field} mt-2`}>
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="in_app">In-app</option>
                  </select>
                </label>
              </div>
            )}

            {modifiedAction === 'SWITCH_GATEWAY' && (
              <label className="block">
                <span className={labelText}>Fallback gateway</span>
                <select value={modifiedGateway} onChange={(e) => setModifiedGateway(e.target.value)} className={`${field} mt-2`}>
                  <option value="stripe_backup">Stripe backup</option>
                  <option value="razorpay">Razorpay</option>
                  <option value="adyen">Adyen secondary</option>
                </select>
              </label>
            )}

            {modifiedAction === 'SCHEDULE_RETRY' && (
              <label className="block">
                <span className={labelText}>Delay (1–72 hours)</span>
                <input type="number" min="1" max="72" value={modifiedDelay} onChange={(e) => setModifiedDelay(e.target.value)} className={`${field} mt-2`} />
              </label>
            )}

            <label className="block">
              <span className={labelText}>Why this change (required)</span>
              <textarea
                rows={2}
                value={modifyReason}
                onChange={(e) => setModifyReason(e.target.value)}
                placeholder="Explain why this strategy fits better"
                className={`${field} mt-2`}
                required
              />
            </label>

            <p className="text-xs text-muted">Customer, amount and transaction details cannot be changed.</p>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowModifyModal(false)} className="rounded-full px-4 py-2 text-sm text-muted hover:text-paper">
                Cancel
              </button>
              <button type="submit" disabled={actionLoading} className="rounded-full bg-signal px-5 py-2 text-sm font-semibold text-ink hover:bg-paper disabled:opacity-50">
                {actionLoading ? 'Saving…' : 'Apply and re-check'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
