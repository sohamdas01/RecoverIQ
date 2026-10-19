'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { PolicyBadge, StatusBadge, ActionBadge } from './StatusBadge';

export default function CasesTable({
  cases = [],
  loading = false,
  error = null,
  onRetry = null,
  showFilters = true,
  title = 'Recovery Cases',
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [policyFilter, setPolicyFilter] = useState('ALL');

  const filteredCases = cases.filter((item) => {
    const dec = item.decision || {};
    const txn = item.transaction || {};
    const cust = item.customer || {};

    const matchesSearch =
      !searchTerm ||
      dec.id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      txn.id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      txn.failureReason?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cust.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cust.email?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus =
      statusFilter === 'ALL' ||
      (statusFilter === 'PENDING' && (dec.status === 'pending_review' || dec.guardrailResult === 'REQUIRE_APPROVAL')) ||
      (statusFilter === 'EXECUTED' && (dec.status === 'executed' || dec.status === 'recovered')) ||
      (statusFilter === 'BLOCKED' && (dec.status === 'blocked' || dec.guardrailResult === 'BLOCK'));

    const matchesPolicy =
      policyFilter === 'ALL' ||
      (dec.guardrailResult || '').toUpperCase() === policyFilter;

    return matchesSearch && matchesStatus && matchesPolicy;
  });

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
      <div className="p-4 sm:p-6 border-b border-slate-800 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
            {title}
            <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
              {filteredCases.length}
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time multi-agent recovery lifecycle & policy decision audit trail
          </p>
        </div>

        {showFilters && (
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative min-w-[200px]">
              <input
                type="text"
                placeholder="Search case, txn, customer..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-xl text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
              />
              <svg className="w-4 h-4 text-slate-500 absolute left-2.5 top-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>

            <select
              value={policyFilter}
              onChange={(e) => setPolicyFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-xl text-slate-300 focus:outline-none focus:border-indigo-500"
            >
              <option value="ALL">Policy: All</option>
              <option value="ALLOW">Policy: ALLOW</option>
              <option value="REQUIRE_APPROVAL">Policy: REQUIRE APPROVAL</option>
              <option value="BLOCK">Policy: BLOCK</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-xl text-slate-300 focus:outline-none focus:border-indigo-500"
            >
              <option value="ALL">Status: All</option>
              <option value="PENDING">Pending Review</option>
              <option value="EXECUTED">Executed / Recovered</option>
              <option value="BLOCKED">Blocked</option>
            </select>
          </div>
        )}
      </div>

      {loading && (
        <div className="p-12 text-center">
          <div className="inline-block w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm text-slate-400">Fetching live recovery cases...</p>
        </div>
      )}

      {!loading && error && (
        <div className="p-8 text-center bg-rose-500/5 border-b border-rose-500/20">
          <p className="text-sm font-semibold text-rose-300">Unable to load recovery cases</p>
          <p className="text-xs text-slate-400 mt-1">{error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-4 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition"
            >
              Try Again
            </button>
          )}
        </div>
      )}

      {!loading && !error && filteredCases.length === 0 && (
        <div className="p-12 text-center">
          <p className="text-sm font-semibold text-slate-300">No recovery cases found</p>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            Trigger failed transactions via the simulator to see autonomous recovery cases in action.
          </p>
          <div className="mt-4">
            <Link
              href="/simulate"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-indigo-300 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 rounded-xl transition"
            >
              <span>⚡ Simulate Failed Payment</span>
            </Link>
          </div>
        </div>
      )}

      {!loading && !error && filteredCases.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/60 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800 text-[11px]">
              <tr>
                <th className="py-3.5 px-4 font-mono">Case / Txn ID</th>
                <th className="py-3.5 px-4">Amount</th>
                <th className="py-3.5 px-4">Failure Reason</th>
                <th className="py-3.5 px-4">ML Prob</th>
                <th className="py-3.5 px-4">Action</th>
                <th className="py-3.5 px-4">Policy</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4">Created</th>
                <th className="py-3.5 px-4 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredCases.map((item) => {
                const dec = item.decision || {};
                const txn = item.transaction || {};
                const cust = item.customer || {};

                const amount = parseFloat(txn.amount || 0);
                const currency = txn.currency || 'USD';
                const formattedAmount = new Intl.NumberFormat('en-US', {
                  style: 'currency',
                  currency,
                }).format(amount);

                const mlScore = dec.mlScore !== null && dec.mlScore !== undefined ? parseFloat(dec.mlScore) : null;
                const createdAt = dec.createdAt ? new Date(dec.createdAt).toLocaleTimeString() : '-';

                return (
                  <tr
                    key={dec.id || txn.id}
                    className="hover:bg-slate-800/40 transition group"
                  >
                    <td className="py-3.5 px-4 font-mono">
                      <div className="font-semibold text-slate-200 group-hover:text-indigo-300 transition">
                        {dec.id ? `${dec.id.slice(0, 8)}...` : 'N/A'}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate max-w-[120px]">
                        {txn.id || '-'}
                      </div>
                    </td>

                    <td className="py-3.5 px-4">
                      <span className="font-bold text-white">{formattedAmount}</span>
                      {cust.name && (
                        <div className="text-[10px] text-slate-400 truncate max-w-[120px]">
                          {cust.name}
                        </div>
                      )}
                    </td>

                    <td className="py-3.5 px-4">
                      <span className="font-mono text-[11px] text-slate-300 px-2 py-0.5 rounded bg-slate-950 border border-slate-800">
                        {txn.failureReason || 'unknown'}
                      </span>
                    </td>

                    <td className="py-3.5 px-4">
                      {mlScore !== null ? (
                        <div className="flex items-center gap-1.5">
                          <span className={`font-mono font-bold ${mlScore >= 0.7 ? 'text-emerald-400' : mlScore >= 0.4 ? 'text-amber-400' : 'text-rose-400'}`}>
                            {(dec.mlScore * 100).toFixed(0)}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </td>

                    <td className="py-3.5 px-4">
                      <ActionBadge action={dec.finalAction || dec.recommendedAction} />
                    </td>

                    <td className="py-3.5 px-4">
                      <PolicyBadge decision={dec.guardrailResult} />
                    </td>

                    <td className="py-3.5 px-4">
                      <StatusBadge status={dec.status} />
                    </td>

                    <td className="py-3.5 px-4 text-slate-400 font-mono text-[11px]">
                      {createdAt}
                    </td>

                    <td className="py-3.5 px-4 text-right">
                      <Link
                        href={`/dashboard/cases/${dec.id}`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-400 hover:text-white bg-indigo-500/10 hover:bg-indigo-600 border border-indigo-500/20 rounded-lg transition"
                      >
                        <span>View</span>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
