'use client';

import React, { useEffect, useState, useCallback, use } from 'react';
import Header from '@/components/Header';
import CasesTable from '@/components/CasesTable';
import { fetchDecisions } from '@/lib/api';

export default function RecoveryCasesExplorer({ searchParams }) {
  const { view } = use(searchParams);
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const loadData = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const res = await fetchDecisions(false, 100);
      setError(null);
      if (res.success) {
        setCases(res.data || []);
      }
    } catch (err) {
      console.error('Error loading recovery cases:', err);
      setError(err.message || 'Failed to fetch recovery cases list.');
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch is scheduled (not called inline) so state updates happen from a callback
    const initialLoad = setTimeout(loadData, 0);
    const interval = setInterval(() => {
      loadData();
    }, 10000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(interval);
    };
  }, [loadData]);

  return (
    <div className="space-y-6 pb-12">
      <Header
        eyebrow="Recovery cases"
        title="Every failed payment, and what happened next"
        subtitle="Search by customer or case, filter by outcome, and open any case for its full decision trail."
        onRefresh={() => loadData(true)}
        refreshing={refreshing}
      />

      <CasesTable
        cases={cases}
        loading={loading}
        error={error}
        onRetry={() => loadData(true)}
        showFilters
        initialView={typeof view === 'string' ? view : 'all'}
        title="All cases"
        subtitle="Latest 100 cases, refreshed every 10 seconds."
      />
    </div>
  );
}
