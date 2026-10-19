'use client';

import React, { useState, useEffect, useCallback, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { PolicyBadge, StatusBadge, ActionBadge } from '@/components/StatusBadge';
import DecisionTimeline from '@/components/DecisionTimeline';
import AskRecoverIQPanel from '@/components/AskRecoverIQPanel';
import { useAuth } from '@/components/AuthProvider';
import {
  fetchCaseExplanation,
  approveCase,
  rejectCase,
  modifyCase,
} from '@/lib/api';

export default function CaseDetailPage({ params }) {
  const router = useRouter();
  // React 19 / Next.js 16 params unwrap
  const resolvedParams = use(params);
  const caseId = resolvedParams.caseId;

  const [caseData, setCaseData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const { canReview } = useAuth();
  const [feedback, setFeedback] = useState(null);

  // Review & Modification Modal State
  const [reviewReason, setReviewReason] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showModifyModal, setShowModifyModal] = useState(false);

  // Supported bounded parameters for modification
  const [modifiedAction, setModifiedAction] = useState('RETRY_WITH_DISCOUNT');
  const [modifiedDiscount, setModifiedDiscount] = useState('10');
  const [modifiedChannel, setModifiedChannel] = useState('email');
  const [modifiedDelay, setModifiedDelay] = useState('2');
  const [modifiedGateway, setModifiedGateway] = useState('stripe_backup');
  const [modifyReason, setModifyReason] = useState('');
  const [modifyValidationErr, setModifyValidationErr] = useState(null);

  const fetchCase = useCallback(async () => {
    try {
      const res = await fetchCaseExplanation(caseId);
      if (res.success && res.data) {
        setCaseData(res.data);
      } else {
        throw new Error(res.error || 'Failed to load case details');
      }
    } catch (err) {
      console.error('[CaseDetail] Error loading case:', err);
      setError(err.message || 'Error loading recovery case');
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  const loadCase = () => {
    setLoading(true);
    setError(null);
    return fetchCase();
  };

  useEffect(() => {
    if (!caseId) return undefined;
    // Initial fetch is scheduled (not called inline) so state updates happen from a callback
    const initialLoad = setTimeout(fetchCase, 0);
    return () => clearTimeout(initialLoad);
  }, [caseId, fetchCase]);

  // APPROVE Action
  const handleApprove = async () => {
    setActionLoading(true);
    setFeedback(null);
    try {
      const res = await approveCase(caseId, reviewReason || 'Approved by merchant reviewer via dashboard');
      if (res.success) {
        setFeedback({
          type: 'success',
          message: 'Case successfully approved! Gated through Policy Engine and dispatched for execution.',
        });
        setReviewReason('');
        await loadCase();
      } else {
        setFeedback({ type: 'error', message: res.error || 'Failed to approve recovery action.' });
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'Error executing approval' });
    } finally {
      setActionLoading(false);
    }
  };

  // REJECT Action
  const handleRejectSubmit = async (e) => {
    e.preventDefault();
    if (!rejectReason.trim()) {
      setFeedback({ type: 'error', message: 'Please provide a reason for rejecting this case.' });
      return;
    }

    setActionLoading(true);
    setFeedback(null);
    try {
      const res = await rejectCase(caseId, rejectReason);
      if (res.success) {
        setShowRejectModal(false);
        setRejectReason('');
        setFeedback({
          type: 'success',
          message: 'Case rejected. No further automated or customer recovery action will be taken.',
        });
        await loadCase();
      } else {
        setFeedback({ type: 'error', message: res.error || 'Failed to reject recovery case.' });
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'Error executing rejection' });
    } finally {
      setActionLoading(false);
    }
  };

  // MODIFY Action
  const handleModifySubmit = async (e) => {
    e.preventDefault();
    setModifyValidationErr(null);

    // Validate frontend inputs
    if (!modifyReason.trim()) {
      setModifyValidationErr('Merchant override reason is required.');
      return;
    }

    const params = {};
    if (modifiedAction === 'RETRY_WITH_DISCOUNT') {
      const disc = parseInt(modifiedDiscount, 10);
      if (isNaN(disc) || disc < 5 || disc > 30) {
        setModifyValidationErr('Discount percentage must be between 5% and 30%.');
        return;
      }
      params.discount_percent = disc;
      params.channel = modifiedChannel;
    } else if (modifiedAction === 'SWITCH_GATEWAY') {
      if (!modifiedGateway) {
        setModifyValidationErr('A fallback payment gateway must be selected.');
        return;
      }
      params.fallback_gateway = modifiedGateway;
    } else if (modifiedAction === 'SCHEDULE_RETRY') {
      const delay = parseInt(modifiedDelay, 10);
      if (isNaN(delay) || delay < 1 || delay > 72) {
        setModifyValidationErr('Retry delay must be between 1 and 72 hours.');
        return;
      }
      params.delay_hours = delay;
    }

    setActionLoading(true);
    setFeedback(null);
    try {
      const res = await modifyCase(caseId, {
        modifiedAction,
        modifiedParams: params,
        reasoning: modifyReason,
      });

      if (res.success) {
        setShowModifyModal(false);
        setModifyReason('');
        setFeedback({
          type: 'success',
          message: `Action modified to ${modifiedAction}. Policy re-evaluated and scheduled.`,
        });
        await loadCase();
      } else {
        setFeedback({ type: 'error', message: res.error || 'Failed to modify recovery case.' });
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'Error modifying case' });
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Header title="Case Details" subtitle="Loading recovery case telemetry..." />
        <div className="flex flex-col items-center justify-center py-24 bg-slate-900/60 border border-slate-800 rounded-2xl">
          <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="mt-4 text-sm text-slate-400 font-medium">Fetching multi-agent recovery audit logs...</p>
        </div>
      </div>
    );
  }

  if (error || !caseData) {
    return (
      <div className="space-y-6">
        <Header title="Case Details" subtitle="Error viewing recovery case" />
        <div className="p-8 bg-rose-950/30 border border-rose-900/50 rounded-2xl text-center">
          <div className="w-12 h-12 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto mb-3">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-rose-200">Unable to Load Recovery Case</h3>
          <p className="text-sm text-rose-400 mt-1">{error || 'The requested case could not be found.'}</p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              onClick={loadCase}
              className="px-4 py-2 text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors"
            >
              Retry
            </button>
            <Link
              href="/dashboard/cases"
              className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
            >
              Back to Cases
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const {
    transaction = {},
    customer = {},
    ml = {},
    agent1 = {},
    agent2 = {},
    policy = {},
    overrides = [],
    execution,
    status,
    finalAction,
  } = caseData;

  const isPendingReview = status === 'pending_review' || policy.decision === 'REQUIRE_APPROVAL';
  const mlScore = typeof ml.score === 'number' ? ml.score : typeof ml.probability === 'number' ? ml.probability : 0.75;
  const scorePercent = Math.round(mlScore * 100);

  return (
    <div className="space-y-8 pb-16">
      {/* Top Header */}
      <Header
        title={`Recovery Case: ${caseId}`}
        subtitle={`Transaction ${transaction.id || caseData.transactionId || 'N/A'} • Created ${caseData.createdAt ? new Date(caseData.createdAt).toLocaleString() : 'N/A'}`}
        onRefresh={loadCase}
        refreshing={loading}
      />

      {/* Navigation Breadcrumb & Badges */}
      <div className="flex flex-wrap items-center justify-between gap-4 -mt-4">
        <Link
          href="/dashboard/cases"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-emerald-400 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to all recovery cases
        </Link>
        <div className="flex items-center gap-2">
          <PolicyBadge decision={policy.decision} />
          <StatusBadge status={status} />
          <ActionBadge action={finalAction || agent1.recommendation || agent2.proposedAction} />
        </div>
      </div>

      {/* Feedback Toast / Alert */}
      {feedback && (
        <div
          className={`p-4 rounded-xl border flex items-center justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/40 border-rose-800/60 text-rose-300'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <span className="text-lg">{feedback.type === 'success' ? '✓' : '⚠'}</span>
            <span className="text-sm font-medium">{feedback.message}</span>
          </div>
          <button
            onClick={() => setFeedback(null)}
            className="text-xs text-slate-400 hover:text-white px-2 py-1 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* HUMAN-IN-THE-LOOP REVIEW PANEL                                */}
      {/* ------------------------------------------------------------- */}
      {isPendingReview ? (
        <div className="p-6 bg-gradient-to-r from-amber-950/40 via-amber-900/20 to-slate-900 border border-amber-600/40 rounded-2xl shadow-xl shadow-amber-950/20 space-y-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-amber-800/30">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse"></span>
                <h3 className="text-base font-bold text-amber-200 uppercase tracking-wide">
                  Human-in-the-Loop Review Panel
                </h3>
                <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded">
                  REQUIRE_APPROVAL
                </span>
              </div>
              <p className="text-sm text-slate-300">
                This transaction triggered a Policy Engine safety gate. Merchant review is required before any recovery execution can proceed.
              </p>
            </div>

            {/* Action Buttons (reviewer / admin only; the backend enforces this too) */}
            {canReview ? (
            <div className="flex items-center gap-2.5">
              <button
                onClick={handleApprove}
                disabled={actionLoading}
                className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 rounded-xl shadow-md transition-all disabled:opacity-50 flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                </svg>
                {actionLoading ? 'Processing...' : 'APPROVE'}
              </button>

              <button
                onClick={() => setShowModifyModal(true)}
                disabled={actionLoading}
                className="px-4 py-2 text-xs font-bold text-cyan-200 bg-cyan-950/60 hover:bg-cyan-900/60 border border-cyan-700/50 rounded-xl transition-all disabled:opacity-50 flex items-center gap-1"
              >
                <span>MODIFY</span>
                <span>...</span>
              </button>

              <button
                onClick={() => setShowRejectModal(true)}
                disabled={actionLoading}
                className="px-4 py-2 text-xs font-bold text-rose-300 bg-rose-950/60 hover:bg-rose-900/60 border border-rose-800/50 rounded-xl transition-all disabled:opacity-50 flex items-center gap-1"
              >
                <span>REJECT</span>
              </button>
            </div>
            ) : (
              <span className="px-3 py-1.5 text-xs font-semibold text-slate-300 bg-slate-800/60 border border-slate-700/60 rounded-lg">
                Read-only access: your role cannot review cases
              </span>
            )}
          </div>

          {/* Quick Review Rationale Input */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide shrink-0">
              Reviewer Note:
            </span>
            <input
              type="text"
              value={reviewReason}
              onChange={(e) => setReviewReason(e.target.value)}
              placeholder="Optional audit log note for APPROVE action..."
              className="flex-1 px-3.5 py-2 text-xs bg-slate-950 border border-slate-700 rounded-xl text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500"
            />
          </div>

          {/* Policy Trigger Rule Alert */}
          {policy.reasons && policy.reasons.length > 0 && (
            <div className="p-3 bg-amber-950/50 border border-amber-800/40 rounded-xl text-xs text-amber-300 flex items-start gap-2">
              <span className="font-bold">Policy Gate Trigger:</span>
              <span>{policy.reasons.join(' • ')}</span>
            </div>
          )}
        </div>
      ) : (
        /* Already Reviewed / Resolved Banner */
        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm ${
              status === 'recovered' || status === 'executed'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                : status === 'blocked' || status === 'rejected'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                : 'bg-slate-800 text-slate-400'
            }`}>
              {status === 'recovered' || status === 'executed' ? '✓' : status === 'blocked' || status === 'rejected' ? '✕' : '●'}
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-200">
                Recovery Case Reviewed & Finalized ({status})
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Final Action: <strong className="text-slate-300 font-mono">{finalAction || agent1.recommendation || 'None'}</strong>
                {overrides.length > 0 && ` • Merchant Override: ${overrides[0].merchantReasoning}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-slate-500">Terminal State</span>
            <StatusBadge status={status} />
          </div>
        </div>
      )}

      {/* Main Grid: 2 Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Telemetry & Multi-Agent Details (8 Cols) */}
        <div className="lg:col-span-8 space-y-8">
          {/* Section 1: Transaction Information */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
                Transaction Telemetry
              </h3>
              <span className="text-xs font-mono text-slate-400">ID: {transaction.id || caseData.transactionId}</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-slate-950/50 p-3.5 rounded-xl border border-slate-800/50">
                <div className="text-[11px] font-semibold text-slate-400 uppercase">Amount</div>
                <div className="text-lg font-bold text-slate-100 mt-0.5">
                  {transaction.currency || 'USD'} {Number(transaction.amount || 0).toFixed(2)}
                </div>
              </div>
              <div className="bg-slate-950/50 p-3.5 rounded-xl border border-slate-800/50">
                <div className="text-[11px] font-semibold text-slate-400 uppercase">Gateway</div>
                <div className="text-sm font-semibold text-slate-200 mt-1 capitalize">
                  {transaction.paymentGateway || transaction.gateway || 'Stripe'}
                </div>
              </div>
              <div className="bg-slate-950/50 p-3.5 rounded-xl border border-slate-800/50">
                <div className="text-[11px] font-semibold text-slate-400 uppercase">Customer Tier</div>
                <div className="text-sm font-semibold text-emerald-400 mt-1 uppercase">
                  {customer.riskTier || customer.segment || 'Standard'}
                </div>
              </div>
              <div className="bg-slate-950/50 p-3.5 rounded-xl border border-slate-800/50">
                <div className="text-[11px] font-semibold text-slate-400 uppercase">Customer</div>
                <div className="text-xs font-medium text-slate-300 mt-1 truncate" title={customer.email || 'N/A'}>
                  {customer.name || customer.email || 'Guest User'}
                </div>
              </div>
            </div>

            <div className="mt-4 p-3.5 bg-rose-950/20 border border-rose-900/40 rounded-xl">
              <div className="flex items-start gap-2.5">
                <div className="text-rose-400 mt-0.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <div className="text-xs font-bold text-rose-300 uppercase tracking-wide">
                    Failure Reason: {transaction.failureReason || 'INSUFFICIENT_FUNDS'}
                  </div>
                  <div className="text-xs text-rose-400/90 mt-0.5">
                    Error Code: <code className="font-mono text-rose-300">{transaction.errorCode || 'card_declined'}</code> • {transaction.errorMessage || 'The card issuer declined the transaction.'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: ML Recovery Probability & Attributions */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                ML Recovery Probability Engine
              </h3>
              <span className="text-xs font-mono text-cyan-400/80 bg-cyan-950/60 px-2.5 py-0.5 rounded border border-cyan-800/40">
                Model: {ml.modelVersion || 'v1.0.0'}
              </span>
            </div>

            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
                  <span className="text-slate-300">Predicted Recovery Likelihood</span>
                  <span className={`font-mono text-sm ${scorePercent >= 70 ? 'text-emerald-400' : scorePercent >= 40 ? 'text-amber-400' : 'text-rose-400'}`}>
                    {scorePercent}% (Score: {mlScore.toFixed(3)})
                  </span>
                </div>
                <div className="w-full bg-slate-950 h-3 rounded-full overflow-hidden border border-slate-800 p-0.5">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      scorePercent >= 70
                        ? 'bg-gradient-to-r from-emerald-600 to-emerald-400'
                        : scorePercent >= 40
                        ? 'bg-gradient-to-r from-amber-600 to-amber-400'
                        : 'bg-gradient-to-r from-rose-600 to-rose-400'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(5, scorePercent))}%` }}
                  ></div>
                </div>
              </div>

              {/* Feature Attributions / SHAP Reason Codes */}
              {ml.reasonCodes && ml.reasonCodes.length > 0 && (
                <div>
                  <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-2">Key Factor Attributions</div>
                  <div className="flex flex-wrap gap-2">
                    {ml.reasonCodes.map((code, idx) => (
                      <span
                        key={idx}
                        className="text-xs font-mono px-2.5 py-1 rounded-md bg-slate-950 border border-slate-800 text-slate-300"
                      >
                        • {code}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Section 3: Agent 1 (Recovery Analyst) Recommendation & RAG Playbook Sources */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-400"></span>
                Agent 1: Recovery Analyst
              </h3>
              <span className="text-xs text-blue-400 font-mono">
                Confidence: {Math.round((agent1.confidence || 0.85) * 100)}%
              </span>
            </div>

            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-slate-400 uppercase">Recommended Strategy:</span>
                <ActionBadge action={agent1.recommendation || finalAction} />
              </div>

              {agent1.rationale && (
                <div className="p-4 bg-slate-950/60 rounded-xl border border-slate-800 text-sm text-slate-300 leading-relaxed font-sans">
                  {agent1.rationale}
                </div>
              )}

              {/* Qdrant RAG Playbook Sources */}
              {agent1.playbookSources && agent1.playbookSources.length > 0 && (
                <div className="mt-4 pt-4 border-t border-slate-800/80">
                  <div className="text-xs font-bold text-cyan-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                    Qdrant Vector RAG Playbooks Retrieved ({agent1.playbookSources.length})
                  </div>
                  <div className="space-y-2">
                    {agent1.playbookSources.map((pb, idx) => (
                      <div
                        key={idx}
                        className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                      >
                        <div>
                          <span className="font-semibold text-slate-200">{pb.title || pb.id || `Playbook #${idx + 1}`}</span>
                          <span className="text-slate-400 ml-2">Action: <strong className="text-slate-300">{pb.strategy || pb.action}</strong></span>
                        </div>
                        {pb.similarity && (
                          <span className="text-[11px] font-mono text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/40 self-start sm:self-auto">
                            Score: {(pb.similarity * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Section 4: Agent 2 (Recovery Executor) Proposed Execution */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
                Agent 2: Recovery Executor
              </h3>
              <span className="text-xs text-indigo-400 font-mono">
                Tool Parameters Configured
              </span>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-slate-400 uppercase">Proposed Action:</span>
                <ActionBadge action={agent2.proposedAction || finalAction} />
              </div>

              {agent2.parameters && Object.keys(agent2.parameters).length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] font-bold text-slate-400 uppercase mb-1.5">Execution Tool Payload:</div>
                  <pre className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-xs font-mono text-emerald-400 overflow-x-auto">
                    {JSON.stringify(agent2.parameters, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Policy Decision, Review, Execution & Timeline (4 Cols) */}
        <div className="lg:col-span-4 space-y-8">
          {/* Policy Decision Card */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-6 shadow-sm">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              Policy Engine Guardrail
            </h3>

            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800">
                <span className="text-xs font-semibold text-slate-400">Verdict</span>
                <PolicyBadge decision={policy.decision} />
              </div>

              {policy.primaryRuleId && (
                <div className="text-xs text-slate-300">
                  <span className="text-slate-400">Primary Rule:</span>{' '}
                  <code className="font-mono text-cyan-400">{policy.primaryRuleId}</code>
                </div>
              )}

              {policy.reasons && policy.reasons.length > 0 && (
                <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800 text-xs text-slate-300">
                  <div className="font-semibold text-slate-400 mb-1">Guardrail Rationale:</div>
                  <ul className="list-disc list-inside space-y-1 text-slate-300">
                    {policy.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {/* Execution & Outcome Card */}
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-6 shadow-sm">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Recovery Outcome
            </h3>

            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800">
                <span className="text-xs font-semibold text-slate-400">Execution Status</span>
                <StatusBadge status={status} />
              </div>

              {execution && (
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-xs space-y-2">
                  <div className="text-slate-400 font-semibold">Execution Details:</div>
                  {execution.toolName && (
                    <div className="text-slate-300">Tool: <code className="font-mono text-emerald-400">{execution.toolName}</code></div>
                  )}
                  {execution.dispatchedAt && (
                    <div className="text-slate-400 text-[11px]">Dispatched: {new Date(execution.dispatchedAt).toLocaleTimeString()}</div>
                  )}
                  {execution.recoveryUrl && (
                    <div className="pt-2">
                      <a
                        href={execution.recoveryUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 underline font-medium"
                      >
                        Open Customer Recovery Link ↗
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Step-by-Step Multi-Agent Explanation Timeline */}
          <DecisionTimeline caseData={caseData} />
        </div>
      </div>

      {/* Ask RecoverIQ Interactive Explainer for this specific case */}
      <AskRecoverIQPanel
        activeCaseId={caseId}
        cases={[{ id: caseId, decision: { id: caseId }, transaction }]}
      />

      {/* ------------------------------------------------------------- */}
      {/* REJECT MODAL                                                  */}
      {/* ------------------------------------------------------------- */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4 animate-in fade-in">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-rose-300">Reject Recovery Action</h3>
              <button
                onClick={() => setShowRejectModal(false)}
                className="text-slate-400 hover:text-white text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleRejectSubmit} className="space-y-4">
              <p className="text-xs text-slate-300 leading-relaxed">
                Rejecting this case will immediately halt all automated recovery interventions for Transaction <code className="text-rose-400">{transaction.id || caseData.transactionId}</code>.
              </p>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase mb-1.5">
                  Rejection Reason (Required for Audit Trail)
                </label>
                <textarea
                  rows={3}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="e.g., Customer contacted support directly / Disputed charge / Known fraudulent account"
                  className="w-full px-3.5 py-2 text-sm bg-slate-950 border border-slate-700 rounded-xl text-slate-200 focus:outline-none focus:border-rose-500"
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowRejectModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-xl transition-all shadow-md disabled:opacity-50"
                >
                  {actionLoading ? 'Rejecting...' : 'Confirm Rejection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODIFY ACTION MODAL                                           */}
      {/* ------------------------------------------------------------- */}
      {showModifyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg p-6 shadow-2xl space-y-5 animate-in fade-in">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div>
                <h3 className="text-base font-bold text-slate-100">Modify Recovery Action</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Select bounded action parameters. Modified actions are re-evaluated by Policy Engine.
                </p>
              </div>
              <button
                onClick={() => setShowModifyModal(false)}
                className="text-slate-400 hover:text-white text-sm font-bold"
              >
                ✕
              </button>
            </div>

            {modifyValidationErr && (
              <div className="p-3 bg-rose-950/50 border border-rose-800 text-rose-300 text-xs rounded-xl">
                ⚠ {modifyValidationErr}
              </div>
            )}

            <form onSubmit={handleModifySubmit} className="space-y-4">
              {/* Action Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase mb-1.5">Action Strategy</label>
                <select
                  value={modifiedAction}
                  onChange={(e) => setModifiedAction(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-slate-950 border border-slate-700 rounded-xl text-slate-200 focus:outline-none focus:border-cyan-500"
                >
                  <option value="RETRY_WITH_DISCOUNT">RETRY_WITH_DISCOUNT (Discount Incentive & Message)</option>
                  <option value="SWITCH_GATEWAY">SWITCH_GATEWAY (Alternative Gateway Fallback)</option>
                  <option value="SCHEDULE_RETRY">SCHEDULE_RETRY (Deferred Gateway Retry)</option>
                  <option value="REQUEST_NEW_PAYMENT_METHOD">REQUEST_NEW_PAYMENT_METHOD (Self-Service Recovery Link)</option>
                  <option value="OFFER_ALTERNATIVE_GATEWAY">OFFER_ALTERNATIVE_GATEWAY (Customer Fallback Offer)</option>
                </select>
              </div>

              {/* Bounded parameters based on strategy */}
              {modifiedAction === 'RETRY_WITH_DISCOUNT' && (
                <div className="grid grid-cols-2 gap-4 p-3 bg-slate-950/50 rounded-xl border border-slate-800">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Discount % (5% - 30%)</label>
                    <input
                      type="number"
                      min="5"
                      max="30"
                      value={modifiedDiscount}
                      onChange={(e) => setModifiedDiscount(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-xl text-slate-200 focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Channel</label>
                    <select
                      value={modifiedChannel}
                      onChange={(e) => setModifiedChannel(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-xl text-slate-200 focus:outline-none focus:border-cyan-500"
                    >
                      <option value="email">Email</option>
                      <option value="sms">SMS</option>
                      <option value="in_app">In-App Notification</option>
                    </select>
                  </div>
                </div>
              )}

              {modifiedAction === 'SWITCH_GATEWAY' && (
                <div className="p-3 bg-slate-950/50 rounded-xl border border-slate-800">
                  <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Fallback Gateway</label>
                  <select
                    value={modifiedGateway}
                    onChange={(e) => setModifiedGateway(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-xl text-slate-200 focus:outline-none focus:border-cyan-500"
                  >
                    <option value="stripe_backup">Stripe Backup Gateway</option>
                    <option value="razorpay">Razorpay Gateway</option>
                    <option value="adyen">Adyen Secondary Connector</option>
                  </select>
                </div>
              )}

              {modifiedAction === 'SCHEDULE_RETRY' && (
                <div className="p-3 bg-slate-950/50 rounded-xl border border-slate-800">
                  <label className="block text-xs font-semibold text-slate-300 uppercase mb-1">Retry Delay (1 - 72 Hours)</label>
                  <input
                    type="number"
                    min="1"
                    max="72"
                    value={modifiedDelay}
                    onChange={(e) => setModifiedDelay(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-xl text-slate-200 focus:outline-none focus:border-cyan-500"
                  />
                </div>
              )}

              {/* Merchant Override Reasoning (Required) */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase mb-1.5">
                  Merchant Override Reason (Required)
                </label>
                <textarea
                  rows={2}
                  value={modifyReason}
                  onChange={(e) => setModifyReason(e.target.value)}
                  placeholder="Explain why this modified strategy was selected..."
                  className="w-full px-3.5 py-2 text-sm bg-slate-950 border border-slate-700 rounded-xl text-slate-200 focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              {/* Readonly info notice */}
              <div className="text-[11px] text-slate-500 italic">
                * Transaction ID, customer data, and amounts are immutable and cannot be modified.
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowModifyModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl transition-all shadow-md disabled:opacity-50"
                >
                  {actionLoading ? 'Saving...' : 'Apply & Re-evaluate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
