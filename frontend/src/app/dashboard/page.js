'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import Header from '@/components/Header';
import SummaryCards from '@/components/SummaryCards';
import PendingReviewQueue from '@/components/PendingReviewQueue';
import LiveActivityFeed from '@/components/LiveActivityFeed';
import AskRecoverIQPanel from '@/components/AskRecoverIQPanel';
import CasesTable from '@/components/CasesTable';
import { fetchDashboardSummary, fetchDecisions, fetchLiveActivity } from '@/lib/api';

export default function MerchantDashboardOverview() {
  const [summary, setSummary] = useState(null);
  const [cases, setCases] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const loadData = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const [sumData, decRes, actRes] = await Promise.all([
        fetchDashboardSummary(),
        fetchDecisions(false, 30),
        fetchLiveActivity(25).catch(() => ({ success: false, data: [] })),
      ]);
      setError(null);
      setSummary(sumData);
      if (decRes.success) {
        setCases(decRes.data || []);
      }
      if (actRes.success) {
        setActivity(actRes.data || []);
      }
    } catch (err) {
      console.error('Error loading dashboard data:', err);
      setError(err.message || 'Failed to fetch live dashboard metrics.');
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch is scheduled (not called inline) so state updates happen from a callback
    const initialLoad = setTimeout(loadData, 0);
    // Live polling every 6 seconds to stream updates
    const interval = setInterval(() => {
      loadData();
    }, 6000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(interval);
    };
  }, [loadData]);

  return (
    <div className="space-y-8 pb-12">
      <Header
        title="Merchant Command Center"
        subtitle="Autonomous payment recovery monitoring & human-in-the-loop review"
        onRefresh={() => loadData(true)}
        refreshing={refreshing}
      />

      {/* Summary Metric Cards */}
      <SummaryCards
        totalCases={summary?.totalCases || 0}
        recoveredRevenue={summary?.recoveredRevenue || 0}
        recoveredCount={summary?.recoveredCount || 0}
        pendingReview={summary?.pendingReview || 0}
        blockedOrFailed={summary?.blockedOrFailed || 0}
        currency={summary?.currency || 'USD'}
      />

      {/* Human-in-the-Loop Review Queue (Shown when cases require approval) */}
      <PendingReviewQueue
        cases={cases}
        loading={loading}
        onActionComplete={() => loadData(true)}
      />

      {/* Live Recovery Activity Stream */}
      <LiveActivityFeed
        activity={activity}
        loading={loading}
        error={error}
        onRetry={() => loadData(true)}
      />

      {/* Ask RecoverIQ Interactive Explainer */}
      <AskRecoverIQPanel cases={cases} />

      {/* Recent Cases Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-white tracking-tight">
              Recent Recovery Cases
            </h2>
            <p className="text-xs text-slate-400">
              Latest transactions evaluated through ML and dual-agent policy gate
            </p>
          </div>
          <Link
            href="/dashboard/cases"
            className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition flex items-center gap-1"
          >
            <span>View all cases</span>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>

        <CasesTable
          cases={cases}
          loading={loading}
          error={error}
          onRetry={() => loadData(true)}
          showFilters={false}
          title="Recent Decisions"
        />
      </div>
    </div>
  );
}
