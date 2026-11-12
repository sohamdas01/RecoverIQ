import React from 'react';
import { actionLabel, deriveOutcome } from '@/lib/format';

const TONE = {
  signal: 'bg-signal/10 text-signal ring-signal/25',
  hold: 'bg-hold/10 text-hold ring-hold/25',
  stop: 'bg-stop/10 text-stop ring-stop/25',
  neutral: 'bg-paper/[0.06] text-paper/85 ring-paper/10',
  muted: 'bg-transparent text-muted ring-line',
};

const DOT = {
  signal: 'bg-signal',
  hold: 'bg-hold',
  stop: 'bg-stop',
  neutral: 'bg-paper/60',
  muted: 'bg-muted',
};

export function Badge({ tone = 'neutral', children, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[tone]} ${className}`}
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

export function PolicyBadge({ decision }) {
  const norm = (decision || '').toUpperCase();
  if (norm === 'ALLOW') return <Badge tone="signal">Allowed</Badge>;
  if (norm === 'REQUIRE_APPROVAL') return <Badge tone="hold">Needs approval</Badge>;
  if (norm === 'BLOCK') return <Badge tone="stop">Blocked</Badge>;
  return <Badge tone="muted">{decision || 'Not evaluated'}</Badge>;
}

export function StatusBadge({ status }) {
  const norm = (status || '').toLowerCase();
  if (norm === 'executed' || norm === 'success') return <Badge tone="neutral">Executed</Badge>;
  if (norm === 'recovered') return <Badge tone="signal">Recovered</Badge>;
  if (norm === 'pending_review') return <Badge tone="hold">Needs review</Badge>;
  if (norm === 'blocked') return <Badge tone="stop">Blocked</Badge>;
  if (norm === 'failed') return <Badge tone="stop">Failed</Badge>;
  return <Badge tone="muted">{status || 'Unknown'}</Badge>;
}

export function OutcomeBadge({ decision, transaction }) {
  const outcome = deriveOutcome(decision, transaction);
  return <Badge tone={outcome.tone}>{outcome.label}</Badge>;
}

export function ActionBadge({ action }) {
  return <span className="whitespace-nowrap text-sm text-paper/85">{actionLabel(action)}</span>;
}

export function ScoreMeter({ score, className = '' }) {
  if (score === null || score === undefined) return <span className="text-sm text-muted">—</span>;
  const pct = Math.round(score * 100);
  const bar = score >= 0.7 ? 'bg-signal' : score >= 0.4 ? 'bg-hold' : 'bg-stop';
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`} title={`Recovery likelihood ${pct}%`}>
      <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <span className={`absolute inset-y-0 left-0 rounded-full ${bar}`} style={{ width: `${Math.max(4, pct)}%` }} />
      </span>
      <span className="w-9 font-mono text-xs tabular-nums text-paper/85">{pct}%</span>
    </span>
  );
}
