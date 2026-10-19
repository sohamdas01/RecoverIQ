'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { PolicyBadge, ActionBadge } from './StatusBadge';
import { approveCase, rejectCase } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';

export default function PendingReviewQueue({
  cases = [],
  loading = false,
  onActionComplete = null,
}) {
  const [processingId, setProcessingId] = useState(null);
  const { canReview } = useAuth();
  const [feedback, setFeedback] = useState(null);

  // Filter only pending review cases
  const pendingCases = cases.filter((item) => {
    const dec = item.decision || {};
    return dec.status === 'pending_review' || dec.guardrailResult === 'REQUIRE_APPROVAL';
  });

  const handleQuickApprove = async (e, caseId) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Quick approve recovery case ${caseId.slice(0, 8)}?`)) return;

    setProcessingId(caseId);
    setFeedback(null);
    try {
      const res = await approveCase(caseId, 'Quick approved from Dashboard Queue');
      if (res.success) {
        setFeedback({ type: 'success', message: `Case ${caseId.slice(0, 8)} approved and dispatched!` });
        if (onActionComplete) onActionComplete();
      } else {
        setFeedback({ type: 'error', message: res.error || 'Failed to approve case' });
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'Approval error' });
    } finally {
      setProcessingId(null);
    }
  };

  const handleQuickReject = async (e, caseId) => {
    e.preventDefault();
    e.stopPropagation();
    const reason = prompt(`Enter rejection reason for case ${caseId.slice(0, 8)}:`, 'Rejected by merchant reviewer');
    if (reason === null) return;

    setProcessingId(caseId);
    setFeedback(null);
    try {
      const res = await rejectCase(caseId, reason || 'Rejected by merchant');
      if (res.success) {
        setFeedback({ type: 'success', message: `Case ${caseId.slice(0, 8)} rejected.` });
        if (onActionComplete) onActionComplete();
      } else {
        setFeedback({ type: 'error', message: res.error || 'Failed to reject case' });
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'Rejection error' });
    } finally {
      setProcessingId(null);
    }
  };

  if (pendingCases.length === 0 && !loading) {
    return null; // Banner in page handles zero cases or quiet state
  }

  return (
    <div className="bg-slate-900 border border-amber-500/30 rounded-2xl overflow-hidden shadow-xl shadow-amber-950/10">
      {/* Header */}
      <div className="p-4 sm:p-6 border-b border-slate-800 bg-amber-950/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-300 flex items-center justify-center font-bold text-lg animate-pulse">
            ⚠
          </div>
          <div>
            <h2 className="text-lg font-bold text-amber-200 tracking-tight flex items-center gap-2">
              Human-in-the-Loop Review Queue
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                {pendingCases.length} awaiting approval
              </span>
            </h2>
            <p className="text-xs text-slate-300 mt-0.5">
              High-value or sensitive transactions gated by Policy Engine requiring merchant authorization
            </p>
          </div>
        </div>

        <Link
          href="/dashboard/cases"
          className="text-xs font-semibold text-amber-400 hover:text-amber-300 transition flex items-center gap-1 self-end sm:self-auto"
        >
          <span>View all in cases</span>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>

      {/* Action Feedback Banner */}
      {feedback && (
        <div
          className={`p-3.5 mx-4 sm:mx-6 my-3 rounded-xl border flex items-center justify-between text-xs ${
            feedback.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/40 border-rose-800/60 text-rose-300'
          }`}
        >
          <span>{feedback.message}</span>
          <button onClick={() => setFeedback(null)} className="text-slate-400 hover:text-white ml-3 font-bold">✕</button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs text-slate-300">
          <thead className="bg-slate-950/70 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800 text-[11px]">
            <tr>
              <th className="py-3 px-4 font-mono">Case ID</th>
              <th className="py-3 px-4">Amount</th>
              <th className="py-3 px-4">Failure Reason</th>
              <th className="py-3 px-4">ML Prob</th>
              <th className="py-3 px-4">Recommended Action</th>
              <th className="py-3 px-4">Policy Trigger</th>
              <th className="py-3 px-4 text-right">Review Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {pendingCases.map((item) => {
              const dec = item.decision || {};
              const txn = item.transaction || {};
              const cust = item.customer || {};
              const isProcessing = processingId === dec.id;

              const amount = parseFloat(txn.amount || 0);
              const currency = txn.currency || 'USD';
              const formattedAmount = new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency,
              }).format(amount);

              const mlScore = dec.mlScore !== null && dec.mlScore !== undefined ? parseFloat(dec.mlScore) : null;

              return (
                <tr
                  key={dec.id}
                  className="hover:bg-amber-950/10 transition group"
                >
                  <td className="py-3.5 px-4 font-mono">
                    <Link
                      href={`/dashboard/cases/${dec.id}`}
                      className="font-semibold text-amber-300 hover:underline"
                    >
                      {dec.id ? `${dec.id.slice(0, 8)}...` : 'N/A'}
                    </Link>
                    <div className="text-[10px] text-slate-500 truncate max-w-[120px]">
                      {cust.name || txn.id}
                    </div>
                  </td>

                  <td className="py-3.5 px-4 font-bold text-white">
                    {formattedAmount}
                  </td>

                  <td className="py-3.5 px-4">
                    <span className="font-mono text-[11px] text-rose-300 bg-rose-950/40 px-2 py-0.5 rounded border border-rose-900/40">
                      {txn.failureReason || 'unknown'}
                    </span>
                  </td>

                  <td className="py-3.5 px-4 font-mono">
                    {mlScore !== null ? (
                      <span className={`font-bold ${mlScore >= 0.7 ? 'text-emerald-400' : mlScore >= 0.4 ? 'text-amber-400' : 'text-rose-400'}`}>
                        {(mlScore * 100).toFixed(0)}%
                      </span>
                    ) : '-'}
                  </td>

                  <td className="py-3.5 px-4">
                    <ActionBadge action={dec.recommendedAction} />
                  </td>

                  <td className="py-3.5 px-4">
                    <PolicyBadge decision="REQUIRE_APPROVAL" />
                  </td>

                  <td className="py-3.5 px-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {canReview && (<>
                      <button
                        onClick={(e) => handleQuickApprove(e, dec.id)}
                        disabled={isProcessing}
                        className="px-2.5 py-1 text-xs font-semibold text-emerald-300 bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-800/50 rounded-lg transition disabled:opacity-50"
                        title="Quick Approve"
                      >
                        {isProcessing ? '...' : 'Approve'}
                      </button>
                      <button
                        onClick={(e) => handleQuickReject(e, dec.id)}
                        disabled={isProcessing}
                        className="px-2.5 py-1 text-xs font-semibold text-rose-300 bg-rose-950/60 hover:bg-rose-900/60 border border-rose-800/50 rounded-lg transition disabled:opacity-50"
                        title="Quick Reject"
                      >
                        Reject
                      </button>
                      </>)}
                      <Link
                        href={`/dashboard/cases/${dec.id}`}
                        className="px-2.5 py-1 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition"
                      >
                        Review →
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
