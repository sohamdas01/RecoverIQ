'use client';

import React from 'react';
import Link from 'next/link';
import { PolicyBadge, ActionBadge } from './StatusBadge';

export default function LiveActivityFeed({
  activity = [],
  loading = false,
  error = null,
  onRetry = null,
}) {
  const getStatusIcon = (status, eventType) => {
    switch (status) {
      case 'success':
        return (
          <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        );
      case 'review':
        return (
          <div className="w-8 h-8 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0 animate-pulse shadow-sm shadow-amber-500/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
        );
      case 'blocked':
        return (
          <div className="w-8 h-8 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center justify-center shrink-0 shadow-sm shadow-rose-500/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
        );
      case 'failed':
        return (
          <div className="w-8 h-8 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 flex items-center justify-center shrink-0 shadow-sm shadow-red-500/10">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        );
      case 'processing':
      default:
        return (
          <div className="w-8 h-8 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 flex items-center justify-center shrink-0 shadow-sm shadow-cyan-500/10">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
          </div>
        );
    }
  };

  const formatEventTitle = (eventType) => {
    switch (eventType) {
      case 'payment_received':
        return 'Payment Failure Received';
      case 'ml_predicted':
        return 'ML Recovery Likelihood Scored';
      case 'analysis_completed':
        return 'Recovery Analyst Diagnosis';
      case 'agent_recommended':
        return 'Recovery Executor Plan Formulated';
      case 'policy_evaluated':
        return 'Policy Engine Guardrail Evaluated';
      case 'pending_review':
        return 'Pending Human Review';
      case 'human_approved':
        return 'Merchant Review: Approved';
      case 'human_modified':
        return 'Merchant Review: Modified';
      case 'human_rejected':
        return 'Merchant Review: Rejected';
      case 'action_executed':
        return 'Recovery Action Executed';
      case 'recovery_completed':
        return 'Payment Recovery Succeeded';
      case 'recovery_blocked':
        return 'Recovery Blocked by Policy';
      case 'recovery_failed':
        return 'Recovery Attempt Failed';
      default:
        return eventType ? eventType.replace(/_/g, ' ') : 'Lifecycle Event';
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
      {/* Header */}
      <div className="p-4 sm:p-6 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center">
            <span className="w-3 h-3 rounded-full bg-emerald-500 animate-ping absolute opacity-75" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 relative" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
              Live Recovery Activity
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                {activity.length} events
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Real-time stream of multi-agent decisions, guardrails, and customer recoveries
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono font-medium text-emerald-400 bg-emerald-950/60 px-2.5 py-1 rounded-lg border border-emerald-800/40 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Auto-refreshing
          </span>
        </div>
      </div>

      {/* Loading State */}
      {loading && activity.length === 0 && (
        <div className="p-10 text-center">
          <div className="inline-block w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm text-slate-400 font-medium">Connecting to recovery activity stream...</p>
        </div>
      )}

      {/* Error State */}
      {!loading && error && activity.length === 0 && (
        <div className="p-6 text-center bg-rose-500/5 border-b border-rose-500/20">
          <p className="text-sm font-semibold text-rose-300">Unable to load activity stream</p>
          <p className="text-xs text-slate-400 mt-1">{error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && activity.length === 0 && (
        <div className="p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-800/60 text-slate-500 flex items-center justify-center mx-auto border border-slate-700/60">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-300">No recent activity detected</p>
            <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
              Simulate a failed transaction to watch the dual-agent recovery lifecycle in real time.
            </p>
          </div>
          <div className="pt-2">
            <Link
              href="/simulate"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-emerald-300 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 rounded-xl transition"
            >
              <span>⚡ Simulate Failed Payment</span>
            </Link>
          </div>
        </div>
      )}

      {/* Activity List */}
      {activity.length > 0 && (
        <div className="divide-y divide-slate-800/60 max-h-[420px] overflow-y-auto">
          {activity.map((event, idx) => {
            const timeStr = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : 'Just now';

            return (
              <Link
                key={`${event.caseId}_${event.eventType}_${idx}`}
                href={`/dashboard/cases/${event.caseId}`}
                className="p-4 sm:px-6 hover:bg-slate-800/40 transition-colors flex items-start justify-between gap-4 group cursor-pointer"
              >
                <div className="flex items-start gap-3.5 min-w-0">
                  {getStatusIcon(event.status, event.eventType)}

                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold text-slate-200 group-hover:text-cyan-300 transition-colors capitalize">
                        {formatEventTitle(event.eventType)}
                      </span>
                      {event.action && (
                        <ActionBadge action={event.action} />
                      )}
                      {event.policyDecision && event.policyDecision !== 'N/A' && (
                        <PolicyBadge decision={event.policyDecision} />
                      )}
                    </div>

                    <p className="text-xs text-slate-400 line-clamp-1 leading-relaxed">
                      {event.summary}
                    </p>

                    <div className="flex items-center gap-2 text-[11px] font-mono text-slate-500">
                      <span>Case: {event.caseId ? `${event.caseId.slice(0, 8)}...` : 'N/A'}</span>
                      <span>•</span>
                      <span>Txn: {event.transactionId ? `${event.transactionId.slice(0, 10)}...` : 'N/A'}</span>
                    </div>
                  </div>
                </div>

                <div className="text-right shrink-0 flex flex-col items-end justify-between self-stretch">
                  <span className="text-[11px] font-mono text-slate-500">
                    {timeStr}
                  </span>
                  <span className="text-[11px] font-semibold text-cyan-400 group-hover:translate-x-0.5 transition-transform flex items-center gap-1 opacity-0 group-hover:opacity-100">
                    View Case →
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
