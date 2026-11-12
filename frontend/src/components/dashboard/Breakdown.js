import React from 'react';
import { actionLabel, formatMoney, reasonLabel } from '@/lib/format';

function aggregate(cases, keyOf) {
  const rows = new Map();
  for (const item of cases) {
    const key = keyOf(item) || 'unknown';
    const row = rows.get(key) || { key, count: 0, amount: 0, recovered: 0 };
    row.count += 1;
    row.amount += Number(item.transaction?.amount) || 0;
    if (item.transaction?.status === 'recovered') row.recovered += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count);
}

const VIEWS = {
  reason: {
    title: 'Why payments failed',
    note: 'Share of cases by decline reason, with how many came back.',
    keyOf: (item) => item.transaction?.failureReason,
    label: reasonLabel,
  },
  action: {
    title: 'What the agents chose',
    note: 'Recovery action taken per case, with how many came back.',
    keyOf: (item) => item.decision?.finalAction || item.decision?.recommendedAction,
    label: actionLabel,
  },
};

export default function Breakdown({ cases = [], view = 'reason', limit = 6 }) {
  const config = VIEWS[view];
  const rows = aggregate(cases, config.keyOf).slice(0, limit);
  const max = rows[0]?.count || 1;
  const currency = cases[0]?.transaction?.currency || 'INR';

  return (
    <section className="rounded-2xl border border-line bg-ink-raised p-6">
      <h2 className="font-display text-2xl tracking-tight text-paper">{config.title}</h2>
      <p className="mt-1 text-xs text-muted">{config.note}</p>

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-muted">No cases yet.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {rows.map((row) => {
            const rate = Math.round((row.recovered / row.count) * 100);
            return (
              <li key={row.key} title={`${config.label(row.key)}: ${row.count} cases, ${formatMoney(row.amount, currency)}, ${row.recovered} recovered`}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate text-paper">{config.label(row.key)}</span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                    <span className="text-paper">{row.count}</span> · {formatMoney(row.amount, currency)}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
                    <span className="absolute inset-y-0 left-0 rounded-full bg-paper/40" style={{ width: `${(row.count / max) * 100}%` }} />
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-signal"
                      style={{ width: `${(row.recovered / max) * 100}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 whitespace-nowrap text-right text-[11px] text-muted">
                    <span className="tabular-nums text-paper/85">{rate}%</span> recovered
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-6 flex gap-5 border-t border-line pt-4 text-[11px] text-muted">
        <span className="flex items-center gap-2"><span aria-hidden="true" className="size-2 rounded-sm bg-paper/40" />All cases</span>
        <span className="flex items-center gap-2"><span aria-hidden="true" className="size-2 rounded-sm bg-signal" />Recovered</span>
      </div>
    </section>
  );
}
