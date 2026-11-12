'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import OverviewMetrics from '@/components/dashboard/OverviewMetrics';
import Breakdown from '@/components/dashboard/Breakdown';
import PendingReviewQueue from '@/components/PendingReviewQueue';
import LiveActivityFeed from '@/components/LiveActivityFeed';
import AskRecoverIQPanel from '@/components/AskRecoverIQPanel';
import CasesTable from '@/components/CasesTable';
import { useAuth } from '@/components/AuthProvider';
import { fetchDecisions, fetchLiveActivity } from '@/lib/api';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function MerchantDashboardOverview() {
  const { user } = useAuth();
  const [cases, setCases] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [hello, setHello] = useState('Overview');

  const loadData = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const [decRes, actRes] = await Promise.all([
        fetchDecisions(false, 100),
        fetchLiveActivity(40).catch(() => ({ success: false, data: [] })),
      ]);
      setError(null);
      if (decRes.success) setCases(decRes.data || []);
      if (actRes.success) setActivity(actRes.data || []);
    } catch (err) {
      console.error('Error loading dashboard data:', err);
      setError(err.message || 'Failed to fetch live dashboard metrics.');
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch and greeting are scheduled (not called inline) so state updates happen from a callback
    const initialLoad = setTimeout(() => {
      setHello(greeting());
      loadData();
    }, 0);
    const interval = setInterval(() => loadData(), 6000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(interval);
    };
  }, [loadData]);

  const merchant = user?.merchant?.name || 'Merchant console';

  return (
    <div className="space-y-6 pb-12">
      <Header
        live
        eyebrow={`Live · ${merchant}`}
        title={hello}
        subtitle="Here is what the recovery agents did, what they are waiting on you for, and where the money stands."
        onRefresh={() => loadData(true)}
        refreshing={refreshing}
      />

      <OverviewMetrics cases={cases} loading={loading} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <PendingReviewQueue cases={cases} loading={loading} onActionComplete={() => loadData(true)} />
        <LiveActivityFeed activity={activity} loading={loading} error={error} onRetry={() => loadData(true)} limit={7} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Breakdown cases={cases} view="reason" />
        <Breakdown cases={cases} view="action" />
      </div>

      <CasesTable
        cases={cases}
        loading={loading}
        error={error}
        onRetry={() => loadData(true)}
        showFilters={false}
        limit={8}
        title="Latest cases"
        subtitle="The newest failed payments and what happened to each."
      />

      <AskRecoverIQPanel cases={cases.slice(0, 30)} />
    </div>
  );
}
