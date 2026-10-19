'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import CasesTable from '@/components/CasesTable';
import { fetchDecisions } from '@/lib/api';

export default function RecoveryCasesExplorer() {
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
        title="Recovery Cases Explorer"
        subtitle="Search, filter, and inspect all payment recovery decisions and lifecycle outcomes"
        onRefresh={() => loadData(true)}
        refreshing={refreshing}
      />

      <CasesTable
        cases={cases}
        loading={loading}
        error={error}
        onRetry={() => loadData(true)}
        showFilters={true}
        title="All Recovery Cases"
      />
    </div>
  );
}
