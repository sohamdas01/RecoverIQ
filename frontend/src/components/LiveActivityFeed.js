'use client';

import React from 'react';
import Link from 'next/link';
import { actionLabel, relativeTime, shortId } from '@/lib/format';

const EVENT_TITLES = {
  payment_received: 'Failed payment received',
  ml_predicted: 'Recovery likelihood scored',
  analysis_completed: 'Analyst agent diagnosed',
  agent_recommended: 'Executor agent proposed',
  policy_evaluated: 'Policy engine evaluated',
  pending_review: 'Held for human review',
  human_approved: 'Approved by reviewer',
  human_modified: 'Modified by reviewer',
  human_rejected: 'Rejected by reviewer',
  action_executed: 'Action executed',
  recovery_completed: 'Payment recovered',
  recovery_blocked: 'Blocked by policy',
  recovery_failed: 'Recovery failed',
};

const DOT = {
  success: 'bg-signal',
  review: 'bg-hold',
  blocked: 'bg-stop',
  failed: 'bg-stop',
};

function titleFor(event) {
  return EVENT_TITLES[event.eventType] || (event.eventType ? event.eventType.replace(/_/g, ' ') : 'Lifecycle event');
}

// The activity endpoint can return the same event more than once (retries and
// reconciliation write repeats). Show each case/event pair once.
function dedupe(activity) {
  const seen = new Set();
  return activity.filter((event) => {
    const key = `${event.caseId}|${event.eventType}|${event.action}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function LiveActivityFeed({ activity = [], loading = false, error = null, onRetry = null, limit = 8 }) {
  const events = dedupe(activity).slice(0, limit);

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-ink-raised">
      <div className="flex items-center justify-between gap-4 border-b border-line px-6 py-5">
        <div>
          <h2 className="font-display text-2xl tracking-tight text-paper">Live activity</h2>
          <p className="mt-1 text-xs text-muted">What the agents did most recently.</p>
        </div>
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
          <span className="relative flex size-1.5" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-signal opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-1.5 rounded-full bg-signal" />
          </span>
          Live
        </span>
      </div>

      {loading && events.length === 0 && (
        <div className="space-y-3 p-6" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg bg-line/40" />
          ))}
        </div>
      )}

      {!loading && error && events.length === 0 && (
        <div className="p-6 text-center">
          <p className="text-sm font-medium text-stop">Activity stream unavailable</p>
          <p className="mt-1 text-xs text-muted">{error}</p>
          {onRetry && (
            <button type="button" onClick={onRetry} className="mt-4 rounded-full border border-line px-4 py-1.5 text-xs text-paper hover:border-paper/60">
              Retry
            </button>
          )}
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-14 text-center">
          <p className="text-sm font-medium text-paper">No activity yet</p>
          <p className="mt-1 max-w-xs text-xs text-muted">Simulate a failed payment to watch the agents work.</p>
        </div>
      )}

      {events.length > 0 && (
        <ol className="relative flex-1 px-6 py-5">
          <span aria-hidden="true" className="absolute bottom-7 left-[1.78rem] top-7 w-px bg-line" />
          {events.map((event, idx) => (
            <li key={`${event.caseId}_${event.eventType}_${idx}`} className="relative">
              <Link
                href={`/dashboard/cases/${event.caseId}`}
                className="group -mx-2 flex items-start gap-4 rounded-lg px-2 py-2.5 transition-colors hover:bg-paper/[0.03]"
              >
                <span aria-hidden="true" className="relative mt-1.5 flex size-2.5 shrink-0 items-center justify-center rounded-full bg-ink-raised">
                  <span className={`size-2 rounded-full ${DOT[event.status] || 'bg-paper/50'}`} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm text-paper group-hover:text-signal">{titleFor(event)}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted">{relativeTime(event.timestamp)}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {event.action ? `${actionLabel(event.action)} · ` : ''}
                    <span className="font-mono">{shortId(event.caseId)}</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
