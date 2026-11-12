'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ScoreMeter } from './StatusBadge';
import { approveCase, rejectCase } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { actionLabel, formatMoney, isAwaitingReview, reasonLabel, relativeTime, shortId, toScore } from '@/lib/format';

export default function PendingReviewQueue({ cases = [], loading = false, onActionComplete = null, limit = 5 }) {
  const [processingId, setProcessingId] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const { canReview } = useAuth();

  const pendingCases = cases.filter((item) => isAwaitingReview(item.decision));
  const visible = pendingCases.slice(0, limit);

  const run = async (caseId, fn, successMessage) => {
    setProcessingId(caseId);
    setFeedback(null);
    try {
      const res = await fn();
      if (res.success) {
        setFeedback({ type: 'success', message: successMessage });
        onActionComplete?.();
      } else {
        setFeedback({ type: 'error', message: res.error || res.message || 'The review could not be saved.' });
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'The review could not be saved.' });
    } finally {
      setProcessingId(null);
    }
  };

  const handleApprove = (caseId) => {
    if (!confirm(`Approve recovery case ${shortId(caseId)}? The proposed action runs immediately.`)) return;
    run(caseId, () => approveCase(caseId, 'Approved from the overview review queue'), `Case ${shortId(caseId)} approved and dispatched.`);
  };

  const handleReject = (caseId) => {
    const reason = prompt(`Why are you rejecting case ${shortId(caseId)}?`, 'Rejected by merchant reviewer');
    if (reason === null) return;
    run(caseId, () => rejectCase(caseId, reason || 'Rejected by merchant'), `Case ${shortId(caseId)} rejected. No action will be taken.`);
  };

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-ink-raised">
      <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
        <div>
          <h2 className="flex items-center gap-3 font-display text-2xl tracking-tight text-paper">
            Needs your review
            {pendingCases.length > 0 && (
              <span className="rounded-full bg-hold px-2 py-0.5 font-sans text-xs font-semibold tabular-nums text-ink">
                {pendingCases.length}
              </span>
            )}
          </h2>
          <p className="mt-1 text-xs text-muted">High-value or sensitive cases the policy engine held for a person to decide.</p>
        </div>
        {pendingCases.length > limit && (
          <Link href="/dashboard/cases?view=review" className="shrink-0 text-xs font-medium text-signal hover:text-paper">
            View all
          </Link>
        )}
      </div>

      {feedback && (
        <div
          role="status"
          className={`mx-6 mt-4 flex items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 text-xs ${
            feedback.type === 'success' ? 'bg-signal/10 text-signal' : 'bg-stop/10 text-stop'
          }`}
        >
          <span>{feedback.message}</span>
          <button type="button" onClick={() => setFeedback(null)} aria-label="Dismiss" className="text-base leading-none text-muted hover:text-paper">
            ×
          </button>
        </div>
      )}

      {loading && pendingCases.length === 0 ? (
        <div className="space-y-px p-6" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-line/40" />
          ))}
        </div>
      ) : pendingCases.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-14 text-center">
          <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-signal/10 text-signal">
            <svg className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </span>
          <p className="mt-4 text-sm font-medium text-paper">Queue is clear</p>
          <p className="mt-1 max-w-xs text-xs text-muted">Every held case has a decision. New ones appear here the moment the policy engine holds them.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((item) => {
            const dec = item.decision || {};
            const txn = item.transaction || {};
            const busy = processingId === dec.id;
            return (
              <li key={dec.id} className="group relative flex flex-col gap-3 px-6 py-4 transition-colors hover:bg-paper/[0.02] sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-3">
                    <Link
                      href={`/dashboard/cases/${dec.id}`}
                      className="font-display text-2xl leading-none tracking-tight text-paper after:absolute after:inset-0 hover:text-signal focus-visible:outline-none"
                    >
                      {formatMoney(txn.amount, txn.currency)}
                    </Link>
                    <span className="truncate text-sm text-paper/85">{item.customer?.name || 'Unknown customer'}</span>
                  </div>
                  <p className="mt-1.5 truncate text-xs text-muted">
                    {reasonLabel(txn.failureReason)} · proposes <span className="text-paper/85">{actionLabel(dec.recommendedAction)}</span> ·{' '}
                    {relativeTime(dec.createdAt)}
                  </p>
                </div>

                <ScoreMeter score={toScore(dec.mlScore)} className="relative shrink-0" />

                {canReview && (
                  <div className="relative flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleReject(dec.id)}
                      disabled={busy}
                      className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-paper/85 transition-colors hover:border-stop hover:text-stop disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => handleApprove(dec.id)}
                      disabled={busy}
                      className="rounded-full bg-signal px-3.5 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-paper disabled:opacity-50"
                    >
                      {busy ? 'Saving…' : 'Approve'}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
