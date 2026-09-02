'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { simulatePurchase, simulateBatch } from '../../lib/api';

export default function SimulatePage() {
  const [formData, setFormData] = useState({
    customerName: 'Priya Sharma',
    customerEmail: 'priya.sharma@example.com',
    amount: 4999,
    currency: 'INR',
    paymentMethod: 'card',
    failureReason: 'card_expired',
    attemptCount: 1,
  });

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [batchLoading, setBatchLoading] = useState(false);

  const presets = [
    {
      label: 'Card Expired (Triggers Recovery Link)',
      data: {
        customerName: 'Aarav Patel',
        customerEmail: 'aarav.patel@techcorp.in',
        amount: 2999,
        paymentMethod: 'card',
        failureReason: 'card_expired',
        attemptCount: 1,
      },
    },
    {
      label: 'Bank Outage (Triggers Immediate Retry)',
      data: {
        customerName: 'Ananya Iyer',
        customerEmail: 'ananya.iyer@gmail.com',
        amount: 7999,
        paymentMethod: 'upi',
        failureReason: 'bank_outage',
        attemptCount: 1,
      },
    },
    {
      label: 'High Amount ₹75,000 (Requires Human Approval)',
      data: {
        customerName: 'Devika Nair',
        customerEmail: 'devika.nair@startup.io',
        amount: 75000,
        paymentMethod: 'card',
        failureReason: 'insufficient_funds',
        attemptCount: 1,
      },
    },
    {
      label: 'Fraud Flag (Triggers Guardrail BLOCK)',
      data: {
        customerName: 'Suspicious User',
        customerEmail: 'flagged_user_99@tempmail.com',
        amount: 95000,
        paymentMethod: 'card',
        failureReason: 'high_risk_fraud',
        attemptCount: 1,
      },
    },
  ];

  const handleSimulate = async (e) => {
    e?.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await simulatePurchase(formData);
      setResult(res.data);
    } catch (err) {
      alert('Simulation failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleBatch = async () => {
    setBatchLoading(true);
    try {
      const res = await simulateBatch();
      alert(`Batch completed! ${res.processedCount} simulated scenarios processed.`);
    } catch (err) {
      alert('Batch simulation error: ' + err.message);
    } finally {
      setBatchLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Navigation & Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-800 pb-6">
          <div>
            <div className="flex items-center gap-3">
              <span className="px-3 py-1 text-xs font-semibold uppercase tracking-wider bg-indigo-600 text-white rounded-full">Phase 1 Demo</span>
              <h1 className="text-3xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-300">
                RecoverIQ Simulation Engine
              </h1>
            </div>
            <p className="text-slate-400 mt-1 text-sm">
              Trigger payment failure events to test the autonomous two-agent decision loop, guardrails, and customer recovery flow.
            </p>
          </div>

          <div className="flex gap-3">
            <Link
              href="/dashboard"
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium border border-slate-700 transition"
            >
              Merchant Dashboard
            </Link>
            <button
              onClick={handleBatch}
              disabled={batchLoading}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50"
            >
              {batchLoading ? 'Generating...' : '⚡ Run Batch Simulation'}
            </button>
          </div>
        </div>

        {/* Quick Presets */}
        <div>
          <h2 className="text-xs uppercase tracking-wider font-semibold text-slate-400 mb-3">Quick Failure Presets:</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {presets.map((p, idx) => (
              <button
                key={idx}
                onClick={() => setFormData({ ...formData, ...p.data })}
                className="text-left p-3 rounded-lg bg-slate-900 border border-slate-800 hover:border-indigo-500/50 hover:bg-slate-850 transition text-xs font-medium text-slate-300"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Form */}
          <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
              Simulate Failed Purchase
            </h2>

            <form onSubmit={handleSimulate} className="space-y-4 text-sm">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Customer Name</label>
                <input
                  type="text"
                  value={formData.customerName}
                  onChange={(e) => setFormData({ ...formData, customerName: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Customer Email</label>
                <input
                  type="email"
                  value={formData.customerEmail}
                  onChange={(e) => setFormData({ ...formData, customerEmail: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Amount (INR)</label>
                  <input
                    type="number"
                    value={formData.amount}
                    onChange={(e) => setFormData({ ...formData, amount: Number(e.target.value) })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Attempt Count</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={formData.attemptCount}
                    onChange={(e) => setFormData({ ...formData, attemptCount: Number(e.target.value) })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Payment Method</label>
                <select
                  value={formData.paymentMethod}
                  onChange={(e) => setFormData({ ...formData, paymentMethod: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="card">Credit / Debit Card</option>
                  <option value="upi">UPI (GPay / PhonePe)</option>
                  <option value="netbanking">Net Banking</option>
                  <option value="subscription_mandate">Subscription Auto-Debit Mandate</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Failure Reason</label>
                <select
                  value={formData.failureReason}
                  onChange={(e) => setFormData({ ...formData, failureReason: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="card_expired">card_expired (Card expired on file)</option>
                  <option value="insufficient_funds">insufficient_funds (Insufficient account balance)</option>
                  <option value="bank_outage">bank_outage (Issuing bank network downtime)</option>
                  <option value="network_timeout">network_timeout (Gateway network timeout)</option>
                  <option value="authentication_failed">authentication_failed (3D Secure / OTP failed)</option>
                  <option value="high_risk_fraud">high_risk_fraud (Fraud risk flagged)</option>
                </select>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white font-semibold rounded-lg shadow-lg shadow-indigo-500/20 transition disabled:opacity-50 mt-4"
              >
                {loading ? 'Diagnosing & Executing...' : 'Simulate Payment Failure'}
              </button>
            </form>
          </div>

          {/* Realtime Inspection Output */}
          <div className="lg:col-span-7 space-y-4">
            {result ? (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl space-y-6">
                
                {/* Status Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
                  <div>
                    <span className="text-xs text-slate-500 font-mono">TX ID: {result.transaction?.id}</span>
                    <h3 className="text-xl font-bold text-white mt-0.5">
                      ₹{parseFloat(result.transaction?.amount).toLocaleString()} — {result.transaction?.failureReason}
                    </h3>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`px-3 py-1 text-xs font-bold rounded-full ${
                        result.guardrail?.decision === 'ALLOW'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                          : result.guardrail?.decision === 'REQUIRE_APPROVAL'
                          ? 'bg-amber-950 text-amber-400 border border-amber-800'
                          : 'bg-rose-950 text-rose-400 border border-rose-800'
                      }`}
                    >
                      Guardrail: {result.guardrail?.decision}
                    </span>

                    <span className="px-3 py-1 text-xs font-semibold bg-slate-800 text-slate-300 rounded-full border border-slate-700">
                      Status: {result.decision?.status}
                    </span>
                  </div>
                </div>

                {/* Agent & Guardrail Reasoning */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 bg-slate-950 rounded-lg border border-slate-800/80 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs uppercase font-semibold text-indigo-400 tracking-wider">Agent Diagnosis (RAG)</span>
                      {result.decision?.agentAnalystResponse?.playbookStrategy?.ruleCode && (
                        <span className="text-[10px] bg-indigo-950 text-indigo-300 border border-indigo-800 px-2 py-0.5 rounded font-mono font-bold">
                          {result.decision?.agentAnalystResponse?.playbookStrategy?.ruleCode}
                        </span>
                      )}
                    </div>

                    <p className="text-sm font-semibold text-white">Action: {result.decision?.recommendedAction}</p>

                    {result.decision?.agentAnalystResponse?.playbookStrategy && (
                      <div className="p-2.5 bg-slate-900 border border-indigo-900/40 rounded-md text-xs space-y-1">
                        <div className="flex justify-between items-center text-[11px] text-indigo-300 font-semibold">
                          <span>📚 Playbook: {result.decision.agentAnalystResponse.playbookStrategy.title}</span>
                          <span className="font-mono text-indigo-400">
                            Match: {(result.decision.agentAnalystResponse.playbookStrategy.similarityScore * 100).toFixed(1)}%
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          {result.decision.agentAnalystResponse.playbookStrategy.rationale}
                        </p>
                      </div>
                    )}

                    <p className="text-xs text-slate-400 leading-relaxed">{result.decision?.reasoning}</p>
                  </div>

                  <div className="p-4 bg-slate-950 rounded-lg border border-slate-800/80">
                    <span className="text-xs uppercase font-semibold text-amber-400 tracking-wider">Guardrail Policy Checks</span>
                    <p className="text-sm font-semibold text-white mt-1">Decision: {result.guardrail?.decision}</p>
                    <p className="text-xs text-slate-400 mt-2 leading-relaxed">{result.guardrail?.reason}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {result.guardrail?.appliedRules?.map((r, i) => (
                        <span key={i} className="text-[10px] bg-slate-900 text-slate-400 px-2 py-0.5 rounded font-mono">
                          {r}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Action Result / Customer Recovery Link */}
                {result.executionResult && (
                  <div className="p-4 bg-slate-950 rounded-lg border border-emerald-900/50">
                    <div className="flex items-center justify-between">
                      <span className="text-xs uppercase font-semibold text-emerald-400 tracking-wider">
                        MCP Tool Execution: {result.executionResult?.toolName}
                      </span>
                      <span className="text-xs text-emerald-400 font-mono font-bold">
                        {result.executionResult?.success ? 'SUCCESS' : 'FAILED'}
                      </span>
                    </div>

                    {result.executionResult?.output?.recoveryUrl && (
                      <div className="mt-3 p-3 bg-emerald-950/40 border border-emerald-800/60 rounded-lg">
                        <p className="text-xs font-semibold text-emerald-300">
                          ✨ Customer Recovery Link Generated (Single-Use, Signed Token):
                        </p>
                        <p className="text-xs text-slate-400 break-all font-mono mt-1">
                          {result.executionResult?.output?.recoveryUrl}
                        </p>
                        <div className="mt-3">
                          <Link
                            href={result.executionResult?.output?.recoveryUrl.replace('http://localhost:3000', '')}
                            target="_blank"
                            className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-bold transition"
                          >
                            Open Customer Recovery Page ↗
                          </Link>
                        </div>
                      </div>
                    )}

                    {result.executionResult?.output?.message && (
                      <p className="text-xs text-slate-300 mt-2">
                        {result.executionResult.output.message}
                      </p>
                    )}
                  </div>
                )}

              </div>
            ) : (
              <div className="h-full min-h-[380px] flex flex-col items-center justify-center p-8 bg-slate-900/50 border border-dashed border-slate-800 rounded-xl text-center text-slate-500">
                <span className="text-4xl mb-2">⚡</span>
                <h3 className="text-base font-semibold text-slate-400">Awaiting Simulation Event</h3>
                <p className="text-xs max-w-sm mt-1">
                  Fill out the form on the left or select a preset to trigger a failed transaction and watch the autonomous recovery pipeline execute in real time.
                </p>
              </div>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}
