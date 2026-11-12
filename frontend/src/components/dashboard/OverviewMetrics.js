import React from 'react';
import { deriveOutcome, formatMoney } from '@/lib/format';

// Fixed order and fixed colour per outcome group; every segment is also named
// in the legend with its count, so colour never carries meaning on its own.
const GROUPS = [
  { key: 'recovered', label: 'Recovered', bar: 'bg-signal' },
  { key: 'progress', label: 'In progress', bar: 'bg-paper/45' },
  { key: 'review', label: 'With a reviewer', bar: 'bg-hold' },
  { key: 'stopped', label: 'Blocked or failed', bar: 'bg-stop' },
  { key: 'closed', label: 'Closed', bar: 'bg-muted/40' },
];

function groupOf(item) {
  const { key } = deriveOutcome(item.decision, item.transaction);
  if (key === 'review' || key === 'escalated') return 'review';
  if (key === 'blocked' || key === 'failed') return 'stopped';
  return key;
}

export default function OverviewMetrics({ cases = [], loading = false }) {
  const currency = cases[0]?.transaction?.currency || 'INR';
  const total = cases.length;

  const counts = Object.fromEntries(GROUPS.map((g) => [g.key, 0]));
  // Every figure on this card comes from the same set of cases, so they always agree.
  let atRisk = 0;
  let recoveredRevenue = 0;
  for (const item of cases) {
    const group = groupOf(item);
    const amount = Number(item.transaction?.amount) || 0;
    counts[group] += 1;
    if (group === 'recovered') recoveredRevenue += amount;
    else atRisk += amount;
  }
  const recoveryRate = total ? Math.round((counts.recovered / total) * 100) : 0;
  const pending = cases.filter((c) => c.decision?.status === 'pending_review').length;

  const stats = [
    { label: 'Cases evaluated', value: total, note: 'Latest 100 failed payments' },
    { label: 'Recovery rate', value: `${recoveryRate}%`, note: `${counts.recovered} of ${total} cases paid` },
    { label: 'Awaiting review', value: pending, note: pending ? 'Gated by the policy engine' : 'Queue is clear', tone: pending ? 'text-hold' : '' },
    { label: 'Still at risk', value: formatMoney(atRisk, currency), note: 'Unrecovered value in view' },
  ];

  return (
    <section aria-label="Recovery summary" className="overflow-hidden rounded-2xl border border-line bg-ink-raised">
      <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)]">
        <div className="relative border-b border-line p-6 sm:p-8 lg:border-b-0 lg:border-r">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Recovered revenue</p>
          <p className="mt-5 font-display text-5xl leading-none tracking-tight text-paper sm:text-6xl">
            {loading && !total ? <span className="text-muted">—</span> : formatMoney(recoveredRevenue, currency)}
          </p>
          <p className="mt-4 text-sm text-muted">
            <span className="text-paper">{counts.recovered.toLocaleString('en-IN')}</span> failed payments in view turned back into
            captured revenue.
          </p>
          <span aria-hidden="true" className="absolute bottom-0 left-6 h-px w-16 bg-signal sm:left-8" />
        </div>

        <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="bg-ink-raised p-5 sm:p-6">
              <dt className="text-xs text-muted">{stat.label}</dt>
              <dd className={`mt-3 font-display text-3xl leading-none tracking-tight tabular-nums ${stat.tone || 'text-paper'}`}>
                {loading && !total ? '—' : stat.value}
              </dd>
              <dd className="mt-2 text-xs leading-snug text-muted">{stat.note}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="border-t border-line px-6 py-5 sm:px-8">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-medium text-paper">Where every case stands</h2>
          <span className="font-mono text-[11px] text-muted">{total} cases</span>
        </div>

        <div className="mt-3 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-line" role="img" aria-label={GROUPS.map((g) => `${g.label}: ${counts[g.key]}`).join(', ')}>
          {total > 0 &&
            GROUPS.filter((g) => counts[g.key] > 0).map((g) => (
              <span
                key={g.key}
                className={`h-full first:rounded-l-full last:rounded-r-full ${g.bar}`}
                style={{ width: `${(counts[g.key] / total) * 100}%` }}
                title={`${g.label}: ${counts[g.key]} (${Math.round((counts[g.key] / total) * 100)}%)`}
              />
            ))}
        </div>

        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
          {GROUPS.map((g) => (
            <li key={g.key} className="flex items-center gap-2 text-xs text-muted">
              <span aria-hidden="true" className={`size-2 rounded-sm ${g.bar}`} />
              {g.label}
              <span className="font-mono tabular-nums text-paper">{counts[g.key]}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
