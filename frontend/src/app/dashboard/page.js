'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchTransactions, fetchDecisions, reviewDecision } from '../../lib/api';

export default function MerchantDashboardPage() {
  const [transactions, setTransactions] = useState([]);
  const [pendingDecisions, setPendingDecisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const [txRes, decRes] = await Promise.all([
        fetchTransactions(),
        fetchDecisions(true),
      ]);
      if (txRes.success) setTransactions(txRes.data);
      if (decRes.success) setPendingDecisions(decRes.data);
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleReview = async (decisionId, action) => {
    setReviewingId(decisionId);
    try {
      const res = await reviewDecision(decisionId, {
        reviewAction: action,
        merchantReasoning: `Merchant manual ${action} from dashboard queue`,
      });
      if (res.success) {
        await loadData();
      } else {
        alert(res.message || 'Review action failed');
      }
    } catch (err) {
      alert('Error reviewing decision: ' + err.message);
    } finally {
      setReviewingId(null);
    }
  };

  // Metrics
  const totalCount = transactions.length;
  const recoveredCount = transactions.filter((t) => t.transaction?.status === 'recovered').length;
  const recoveredAmount = transactions
    .filter((t) => t.transaction?.status === 'recovered')
    .reduce((acc, t) => acc + parseFloat(t.transaction?.amount || 0), 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Top Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-800 pb-6">
          <div>
            <div className="flex items-center gap-3">
              <span className="px-3 py-1 text-xs font-bold uppercase tracking-wider bg-emerald-600 text-white rounded-full">Live Monitor</span>
              <h1 className="text-3xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-indigo-300 to-teal-300">
                RecoverIQ Merchant Command Center
              </h1>
            </div>
            <p className="text-slate-400 mt-1 text-sm">
              Autonomous payment leakage detection, real-time guardrail gate, and human-in-the-loop review queue.
            </p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={loadData}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium border border-slate-700 transition"
            >
              ↻ Refresh
            </button>
            <Link
              href="/simulate"
              className="px-4 py-2 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white rounded-lg text-sm font-bold shadow-lg shadow-indigo-500/20 transition"
            >
              + Simulate Purchase
            </Link>
          </div>
        </div>

        {/* Metric Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
            <span className="text-xs uppercase font-semibold text-slate-400 tracking-wider">Total Ingested Failures</span>
            <p className="text-2xl font-extrabold text-white mt-1">{totalCount}</p>
            <span className="text-[11px] text-slate-500 mt-1 block">Live stream events</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
            <span className="text-xs uppercase font-semibold text-emerald-400 tracking-wider">Recovered Revenue</span>
            <p className="text-2xl font-extrabold text-emerald-400 mt-1">₹{recoveredAmount.toLocaleString()}</p>
            <span className="text-[11px] text-emerald-500/80 mt-1 block">{recoveredCount} payments recovered</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
            <span className="text-xs uppercase font-semibold text-amber-400 tracking-wider">Pending Human Review</span>
            <p className="text-2xl font-extrabold text-amber-400 mt-1">{pendingDecisions.length}</p>
            <span className="text-[11px] text-amber-500/80 mt-1 block">Requires merchant action</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
            <span className="text-xs uppercase font-semibold text-indigo-400 tracking-wider">Autonomous Recovery Rate</span>
            <p className="text-2xl font-extrabold text-indigo-400 mt-1">
              {totalCount > 0 ? `${((recoveredCount / totalCount) * 100).toFixed(1)}%` : '0%'}
            </p>
            <span className="text-[11px] text-slate-500 mt-1 block">Closed-loop recovery</span>
          </div>
        </div>

        {/* Human-in-the-Loop Review Queue */}
        {pendingDecisions.length > 0 && (
          <div className="bg-amber-950/20 border border-amber-800/60 rounded-xl p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-amber-400 animate-pulse"></span>
                <h2 className="text-lg font-bold text-amber-300">
                  Human-in-the-Loop Review Queue ({pendingDecisions.length} Cases Gated)
                </h2>
              </div>
              <span className="text-xs text-amber-400/80 font-mono">Policy Guardrail Enforced</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {pendingDecisions.map((item) => (
                <div
                  key={item.decision?.id}
                  className="bg-slate-900 border border-amber-900/50 rounded-xl p-5 space-y-3"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h4 className="font-bold text-white text-base">
                        ₹{parseFloat(item.transaction?.amount).toLocaleString()} — {item.customer?.name}
                      </h4>
                      <p className="text-xs text-slate-400">{item.customer?.email} • {item.transaction?.failureReason}</p>
                    </div>
                    <span className="text-xs px-2.5 py-1 bg-amber-950 text-amber-400 rounded-full font-bold border border-amber-800">
                      REQUIRE_APPROVAL
                    </span>
                  </div>

                  <div className="p-3 bg-slate-950 rounded-lg text-xs space-y-1.5 border border-slate-800">
                    <div className="flex justify-between items-center">
                      <p className="text-slate-300 font-semibold">
                        Proposed Tool: <span className="text-indigo-400">{item.decision?.recommendedAction}</span>
                      </p>
                      {item.decision?.agentAnalystResponse?.playbookStrategy?.ruleCode && (
                        <span className="text-[10px] bg-indigo-950 text-indigo-300 border border-indigo-800 px-2 py-0.5 rounded font-mono font-bold">
                          {item.decision.agentAnalystResponse.playbookStrategy.ruleCode}
                        </span>
                      )}
                    </div>
                    {item.decision?.agentAnalystResponse?.playbookStrategy?.title && (
                      <p className="text-[11px] text-indigo-300 font-medium">
                        📚 Strategy: {item.decision.agentAnalystResponse.playbookStrategy.title}
                      </p>
                    )}
                    <p className="text-slate-400 text-[11px] leading-relaxed">{item.decision?.reasoning}</p>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => handleReview(item.decision?.id, 'approve')}
                      disabled={reviewingId === item.decision?.id}
                      className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition disabled:opacity-50"
                    >
                      Approve & Execute
                    </button>
                    <button
                      onClick={() => handleReview(item.decision?.id, 'reject')}
                      disabled={reviewingId === item.decision?.id}
                      className="flex-1 py-2 bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-800 rounded-lg text-xs font-bold transition disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Live Activity Feed */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-400"></span>
              Live Transaction & Decision Activity Feed
            </h2>
            <span className="text-xs text-slate-500 font-mono">Showing latest {transactions.length} items</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
                <tr>
                  <th className="py-3 px-4">Customer</th>
                  <th className="py-3 px-4">Amount</th>
                  <th className="py-3 px-4">Method</th>
                  <th className="py-3 px-4">Failure Reason</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-medium">
                {transactions.length > 0 ? (
                  transactions.map((t) => (
                    <tr key={t.transaction?.id} className="hover:bg-slate-850/50 transition">
                      <td className="py-3 px-4">
                        <div className="text-slate-200 font-bold">{t.customer?.name}</div>
                        <div className="text-slate-500 text-[11px]">{t.customer?.email}</div>
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-200">
                        ₹{parseFloat(t.transaction?.amount).toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-slate-400 capitalize">
                        {t.transaction?.paymentMethod?.replace('_', ' ')}
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-mono text-slate-300 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                          {t.transaction?.failureReason}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                            t.transaction?.status === 'recovered'
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                              : t.transaction?.status === 'failed'
                              ? 'bg-rose-950 text-rose-400 border border-rose-800'
                              : t.transaction?.status === 'escalated'
                              ? 'bg-amber-950 text-amber-400 border border-amber-800'
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {t.transaction?.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-500 text-[11px]">
                        {new Date(t.transaction?.createdAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="6" className="py-8 text-center text-slate-500">
                      No transactions recorded yet. Go to{' '}
                      <Link href="/simulate" className="text-indigo-400 hover:underline font-bold">
                        Simulate Purchase
                      </Link>{' '}
                      to generate sample payment failures.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
