'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { OutcomeBadge, PolicyBadge, ScoreMeter } from './StatusBadge';
import { actionLabel, deriveOutcome, formatMoney, reasonLabel, relativeTime, shortId, toScore } from '@/lib/format';

const VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'Needs review' },
  { key: 'progress', label: 'In progress' },
  { key: 'recovered', label: 'Recovered' },
  { key: 'stopped', label: 'Blocked' },
];

function viewOf(item) {
  const { key } = deriveOutcome(item.decision, item.transaction);
  if (key === 'review' || key === 'escalated') return 'review';
  if (key === 'blocked' || key === 'failed') return 'stopped';
  if (key === 'recovered') return 'recovered';
  return 'progress';
}

const inputBase =
  'rounded-full border border-line bg-ink px-3.5 py-2 text-xs text-paper placeholder:text-muted/70 transition-colors hover:border-muted/60 focus-visible:border-signal focus-visible:outline-none';

export default function CasesTable({
  cases = [],
  loading = false,
  error = null,
  onRetry = null,
  showFilters = true,
  title = 'Recovery cases',
  subtitle = null,
  limit = null,
  initialView = 'all',
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [view, setView] = useState(VIEWS.some((v) => v.key === initialView) ? initialView : 'all');
  const [policy, setPolicy] = useState('ALL');

  const counts = useMemo(() => {
    const out = { all: cases.length, review: 0, progress: 0, recovered: 0, stopped: 0 };
    for (const item of cases) out[viewOf(item)] += 1;
    return out;
  }, [cases]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cases.filter((item) => {
      const dec = item.decision || {};
      const txn = item.transaction || {};
      const cust = item.customer || {};
      if (showFilters && view !== 'all' && viewOf(item) !== view) return false;
      if (showFilters && policy !== 'ALL' && (dec.guardrailResult || '').toUpperCase() !== policy) return false;
      if (!q) return true;
      return [dec.id, txn.id, txn.failureReason, reasonLabel(txn.failureReason), cust.name, cust.email]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q));
    });
  }, [cases, search, view, policy, showFilters]);

  const rows = limit ? filtered.slice(0, limit) : filtered;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-ink-raised">
      <div className="flex flex-col gap-4 px-6 pt-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="font-display text-2xl tracking-tight text-paper">{title}</h2>
          {subtitle && <p className="mt-1 text-xs text-muted">{subtitle}</p>}
        </div>
        {showFilters && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative">
              <span className="sr-only">Search cases</span>
              <svg className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search customer, case or reason"
                className={`${inputBase} w-64 max-w-full pl-8`}
              />
            </label>
            <label>
              <span className="sr-only">Policy verdict</span>
              <select value={policy} onChange={(e) => setPolicy(e.target.value)} className={`${inputBase} pr-8`}>
                <option value="ALL">Any policy verdict</option>
                <option value="ALLOW">Allowed</option>
                <option value="REQUIRE_APPROVAL">Needed approval</option>
                <option value="BLOCK">Blocked</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {showFilters ? (
        <div role="tablist" aria-label="Filter by outcome" className="mt-4 flex gap-1 overflow-x-auto border-b border-line px-4">
          {VIEWS.map((v) => {
            const active = view === v.key;
            return (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setView(v.key)}
                className={`relative flex shrink-0 items-center gap-2 px-3 pb-3 pt-1 text-sm transition-colors ${
                  active ? 'text-paper' : 'text-muted hover:text-paper'
                }`}
              >
                {v.label}
                <span className={`rounded-full px-1.5 font-mono text-[11px] tabular-nums ${active ? 'bg-paper/10 text-paper' : 'text-muted'}`}>
                  {counts[v.key]}
                </span>
                {active && <span aria-hidden="true" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-signal" />}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mt-5 border-b border-line" />
      )}

      {loading && cases.length === 0 && (
        <div className="space-y-px" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="mx-6 my-3 h-10 animate-pulse rounded-lg bg-line/40" />
          ))}
        </div>
      )}

      {!loading && error && cases.length === 0 && (
        <div className="px-6 py-12 text-center">
          <p className="text-sm font-medium text-stop">Unable to load recovery cases</p>
          <p className="mt-1 text-xs text-muted">{error}</p>
          {onRetry && (
            <button type="button" onClick={onRetry} className="mt-4 rounded-full border border-line px-4 py-1.5 text-xs text-paper hover:border-paper/60">
              Try again
            </button>
          )}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="px-6 py-14 text-center">
          <p className="text-sm font-medium text-paper">{cases.length ? 'No cases match these filters' : 'No recovery cases yet'}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
            {cases.length ? 'Try a different search or outcome.' : 'Simulate a failed payment to see the agents open a case.'}
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-[0.12em] text-muted">
                <th scope="col" className="py-3 pl-6 pr-4 font-medium">Customer</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
                <th scope="col" className="px-4 py-3 font-medium">Failure</th>
                <th scope="col" className="px-4 py-3 font-medium">Likelihood</th>
                <th scope="col" className="px-4 py-3 font-medium">Action</th>
                {showFilters && <th scope="col" className="px-4 py-3 font-medium">Policy</th>}
                <th scope="col" className="px-4 py-3 font-medium">Outcome</th>
                <th scope="col" className="py-3 pl-4 pr-6 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line border-t border-line">
              {rows.map((item) => {
                const dec = item.decision || {};
                const txn = item.transaction || {};
                const cust = item.customer || {};
                const href = `/dashboard/cases/${dec.id}`;
                return (
                  <tr
                    key={dec.id || txn.id}
                    onClick={(e) => {
                      if (e.target.closest('a')) return;
                      router.push(href);
                    }}
                    className="group cursor-pointer transition-colors hover:bg-paper/[0.03]"
                  >
                    <td className="py-3.5 pl-6 pr-4">
                      <Link href={href} className="block max-w-[14rem] truncate text-paper group-hover:text-signal focus-visible:text-signal focus-visible:outline-none">
                        {cust.name || 'Unknown customer'}
                      </Link>
                      <span className="font-mono text-[11px] text-muted">{shortId(dec.id)}</span>
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-[13px] tabular-nums text-paper">
                      {formatMoney(txn.amount, txn.currency)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5 text-paper/85">{reasonLabel(txn.failureReason)}</td>
                    <td className="px-4 py-3.5">
                      <ScoreMeter score={toScore(dec.mlScore)} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5 text-paper/85">{actionLabel(dec.finalAction || dec.recommendedAction)}</td>
                    {showFilters && (
                      <td className="px-4 py-3.5">
                        <PolicyBadge decision={dec.guardrailResult} />
                      </td>
                    )}
                    <td className="px-4 py-3.5">
                      <OutcomeBadge decision={dec} transaction={txn} />
                    </td>
                    <td className="whitespace-nowrap py-3.5 pl-4 pr-6 text-right text-xs text-muted" title={dec.createdAt ? new Date(dec.createdAt).toLocaleString('en-IN') : undefined}>
                      {relativeTime(dec.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex items-center justify-between border-t border-line px-6 py-3 text-xs text-muted">
          <span>
            Showing <span className="text-paper">{rows.length}</span> of {filtered.length}
          </span>
          {limit && filtered.length > limit && (
            <Link href="/dashboard/cases" className="font-medium text-signal hover:text-paper">
              View all cases →
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
