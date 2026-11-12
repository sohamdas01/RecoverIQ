'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { simulatePurchase, simulateBatch, fetchDecisions, fetchCaseExplanation } from '@/lib/api';
import AuthGuard from '@/components/AuthGuard';
import Header from '@/components/Header';
import { Badge, PolicyBadge } from '@/components/StatusBadge';
import { actionLabel, formatMoney, humanize, methodLabel, reasonLabel, scoreTone, toScore } from '@/lib/format';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 45000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The simulate API only queues the event on Kafka, so the decision is written later by the
 * recovery consumer. Poll until the case exists and, for an allowed action, the tool has finished.
 * Returns the latest state seen, or null if no decision appeared before the timeout.
 */
async function waitForCase(transactionId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let latest = null;

  while (Date.now() < deadline) {
    const res = await fetchDecisions(false, 50);
    const item = (res.data || []).find((c) => c.decision?.transactionId === transactionId);

    if (item) {
      const explanation = await fetchCaseExplanation(item.decision.id);
      latest = { item, caseData: explanation.data };

      const toolFinished = latest.caseData?.execution && latest.caseData.execution.status !== 'pending';
      if (item.decision.status !== 'executed' || toolFinished) return latest;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return latest;
}

/** Shape a finished case into the structure the result panel renders. */
function toSimulationResult(transaction, { item, caseData }) {
  const { decision } = item;
  const analyst = decision.agentAnalystResponse || {};
  const execution = caseData?.execution;

  return {
    caseId: decision.id,
    transaction,
    decision,
    score: toScore(decision.mlScore),
    playbook: caseData?.agent1?.playbookSources?.[0] || null,
    rationale: caseData?.agent1?.rationale || decision.reasoning,
    guardrail: {
      decision: decision.guardrailResult,
      reason: (caseData?.policy?.reasons || analyst.reasons || []).join(' '),
      rule: caseData?.policy?.primaryRuleId,
    },
    // Held or blocked cases record the tool as 'skipped': it never ran, so there is no result to show
    executionResult: execution && execution.status !== 'skipped' && {
      toolName: execution.toolName,
      success: execution.success,
      output: execution.result || {},
    },
  };
}

const PRESETS = [
  {
    title: 'Card expired',
    expect: 'Sends a recovery link',
    tone: 'signal',
    data: { customerName: 'Aarav Patel', customerEmail: 'aarav.patel@techcorp.in', amount: 2999, paymentMethod: 'card', failureReason: 'card_expired', attemptCount: 1 },
  },
  {
    title: 'Bank outage',
    expect: 'Retries immediately',
    tone: 'signal',
    data: { customerName: 'Ananya Iyer', customerEmail: 'ananya.iyer@gmail.com', amount: 7999, paymentMethod: 'upi', failureReason: 'bank_outage', attemptCount: 1 },
  },
  {
    title: '₹75,000 decline',
    expect: 'Held for human approval',
    tone: 'hold',
    data: { customerName: 'Devika Nair', customerEmail: 'devika.nair@startup.io', amount: 75000, paymentMethod: 'card', failureReason: 'insufficient_funds', attemptCount: 1 },
  },
  {
    title: 'Fraud flag',
    expect: 'Blocked by the guardrail',
    tone: 'stop',
    data: { customerName: 'Suspicious User', customerEmail: 'flagged_user_99@tempmail.com', amount: 95000, paymentMethod: 'card', failureReason: 'high_risk_fraud', attemptCount: 1 },
  },
];

const STAGES = ['Event queued', 'Likelihood scored', 'Agents decided', 'Policy checked', 'Action executed'];

const field =
  'mt-2 w-full rounded-lg border border-line bg-ink px-3.5 py-2.5 text-sm text-paper focus-visible:border-signal focus-visible:outline-none';
const labelText = 'block text-xs font-medium text-paper/85';

function Progress() {
  return (
    <ol className="space-y-4" aria-live="polite">
      {STAGES.map((stage, i) => (
        <li key={stage} className="flex items-center gap-3 text-sm text-paper/85">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-signal motion-safe:animate-pulse"
            style={{ animationDelay: `${i * 180}ms` }}
          />
          {stage}
        </li>
      ))}
    </ol>
  );
}

function Result({ result }) {
  const { transaction, decision, score, playbook, guardrail, executionResult } = result;
  const tone = scoreTone(score);
  const recoveryUrl = executionResult?.output?.recoveryUrl;
  const toneText = { signal: 'text-signal', hold: 'text-hold', stop: 'text-stop', muted: 'text-muted' }[tone];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Result</p>
          <h3 className="mt-2 font-display text-3xl leading-tight tracking-tight text-paper">
            {formatMoney(transaction?.amount, transaction?.currency)} · {reasonLabel(transaction?.failureReason)}
          </h3>
        </div>
        <PolicyBadge decision={guardrail.decision} />
      </div>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
        <div className="bg-ink p-4">
          <dt className="text-xs text-muted">Recovery likelihood</dt>
          <dd className={`mt-2 font-display text-3xl leading-none ${toneText}`}>{score === null ? '—' : `${Math.round(score * 100)}%`}</dd>
        </div>
        <div className="bg-ink p-4">
          <dt className="text-xs text-muted">Agents chose</dt>
          <dd className="mt-2 text-sm text-paper">{actionLabel(decision.finalAction || decision.recommendedAction)}</dd>
        </div>
        <div className="col-span-2 bg-ink p-4 sm:col-span-1">
          <dt className="text-xs text-muted">Playbook</dt>
          <dd className="mt-2 truncate text-sm text-paper" title={playbook?.title}>
            {playbook ? `${playbook.playbookId || playbook.id} · ${Math.round((playbook.similarityScore ?? playbook.similarity ?? 0) * 100)}% match` : '—'}
          </dd>
        </div>
      </dl>

      {result.rationale && (
        <blockquote className="border-l-2 border-signal/60 pl-4 text-sm leading-relaxed text-paper/85">{result.rationale}</blockquote>
      )}

      <div className="rounded-xl border border-line p-4">
        <p className="text-xs text-muted">Policy engine{guardrail.rule ? ` · ${guardrail.rule}` : ''}</p>
        <p className="mt-1.5 text-sm text-paper/85">{guardrail.reason || 'No reason recorded.'}</p>
      </div>

      {executionResult ? (
        <div className="rounded-xl border border-line p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-paper">Ran {actionLabel(executionResult.toolName)}</p>
            <Badge tone={executionResult.success ? 'signal' : 'stop'}>{executionResult.success ? 'Succeeded' : 'Failed'}</Badge>
          </div>
          {executionResult.output?.outcome && (
            <p className="mt-1.5 text-xs text-muted">Outcome: {humanize(executionResult.output.outcome).toLowerCase()}</p>
          )}
          {recoveryUrl && (
            <Link
              href={recoveryUrl.replace(/^https?:\/\/[^/]+/, '')}
              target="_blank"
              className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-signal px-4 py-2 text-xs font-semibold text-ink hover:bg-paper"
            >
              Open the customer&apos;s recovery page ↗
            </Link>
          )}
        </div>
      ) : (
        <p className="rounded-xl border border-line p-4 text-sm text-paper/85">
          {decision.status === 'pending_review'
            ? 'Nothing ran yet. The case is waiting in the review queue.'
            : 'Nothing ran. The policy engine stopped this case.'}
        </p>
      )}

      <Link href={`/dashboard/cases/${result.caseId}`} className="inline-flex items-center gap-1.5 text-sm text-signal hover:text-paper">
        Open the full decision trail →
      </Link>
    </div>
  );
}

function SimulateContent() {
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
  const [error, setError] = useState(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchNote, setBatchNote] = useState(null);
  const [activePreset, setActivePreset] = useState(null);

  const handleSimulate = async (e) => {
    e?.preventDefault();
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await simulatePurchase(formData);
      if (!res.success || !res.data?.transactionId) {
        throw new Error(res.error || res.data?.message || 'The event was not queued');
      }

      const finished = await waitForCase(res.data.transactionId);
      if (!finished) {
        throw new Error('Event queued, but no decision arrived in time. Check the backend terminal.');
      }
      setResult(toSimulationResult(res.data.transaction, finished));
    } catch (err) {
      setError(err.message || 'Simulation failed');
    } finally {
      setLoading(false);
    }
  };

  const handleBatch = async () => {
    setBatchLoading(true);
    setBatchNote(null);
    try {
      const res = await simulateBatch();
      setBatchNote({ type: 'success', message: `Batch queued: ${res.processedCount ?? 'several'} scenarios. They appear on the overview as the agents finish.` });
    } catch (err) {
      setBatchNote({ type: 'error', message: `Batch failed: ${err.message}` });
    } finally {
      setBatchLoading(false);
    }
  };

  const update = (key, value) => {
    setActivePreset(null);
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-6 pb-12">
      <Header
        eyebrow="Simulator · admin only"
        showSimulate={false}
        title="Trigger a failed payment"
        subtitle="Send a synthetic decline through the real pipeline: Kafka, the ML model, both agents, the policy engine and the recovery tools."
      >
        <button
          type="button"
          onClick={handleBatch}
          disabled={batchLoading}
          className="rounded-full border border-line px-4 py-2 text-xs font-medium text-paper transition-colors hover:border-paper/60 disabled:opacity-50"
        >
          {batchLoading ? 'Queuing…' : 'Run batch'}
        </button>
      </Header>

      {batchNote && (
        <p role="status" className={`rounded-xl px-4 py-3 text-sm ${batchNote.type === 'success' ? 'bg-signal/10 text-signal' : 'bg-stop/10 text-stop'}`}>
          {batchNote.message}
        </p>
      )}

      <section aria-label="Presets">
        <p className="mb-3 text-xs text-muted">Start from a scenario</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {PRESETS.map((p) => {
            const active = activePreset === p.title;
            return (
              <button
                key={p.title}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setActivePreset(p.title);
                  setFormData((prev) => ({ ...prev, ...p.data }));
                }}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  active ? 'border-signal bg-signal/[0.06]' : 'border-line bg-ink-raised hover:border-muted/60'
                }`}
              >
                <span className="block text-sm font-medium text-paper">{p.title}</span>
                <span className="mt-1 block text-xs text-muted">{formatMoney(p.data.amount, 'INR')} · {methodLabel(p.data.paymentMethod)}</span>
                <span className="mt-3 block">
                  <Badge tone={p.tone}>{p.expect}</Badge>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <section className="rounded-2xl border border-line bg-ink-raised p-6">
          <h2 className="font-display text-2xl tracking-tight text-paper">Payment details</h2>
          <form onSubmit={handleSimulate} className="mt-5 space-y-4">
            <label className="block">
              <span className={labelText}>Customer name</span>
              <input type="text" value={formData.customerName} onChange={(e) => update('customerName', e.target.value)} className={field} required />
            </label>
            <label className="block">
              <span className={labelText}>Customer email</span>
              <input type="email" value={formData.customerEmail} onChange={(e) => update('customerEmail', e.target.value)} className={field} required />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={labelText}>Amount (₹)</span>
                <input type="number" min="1" value={formData.amount} onChange={(e) => update('amount', Number(e.target.value))} className={field} required />
              </label>
              <label className="block">
                <span className={labelText}>Attempt</span>
                <input type="number" min="1" max="10" value={formData.attemptCount} onChange={(e) => update('attemptCount', Number(e.target.value))} className={field} required />
              </label>
            </div>
            <label className="block">
              <span className={labelText}>Payment method</span>
              <select value={formData.paymentMethod} onChange={(e) => update('paymentMethod', e.target.value)} className={field}>
                <option value="card">Card</option>
                <option value="upi">UPI</option>
                <option value="netbanking">Net banking</option>
                <option value="subscription_mandate">Subscription mandate</option>
              </select>
            </label>
            <label className="block">
              <span className={labelText}>Decline reason</span>
              <select value={formData.failureReason} onChange={(e) => update('failureReason', e.target.value)} className={field}>
                <option value="card_expired">Card expired</option>
                <option value="insufficient_funds">Insufficient funds</option>
                <option value="bank_outage">Bank outage</option>
                <option value="network_timeout">Network timeout</option>
                <option value="authentication_failed">Authentication failed (3DS / OTP)</option>
                <option value="high_risk_fraud">Suspected fraud</option>
              </select>
            </label>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 w-full rounded-full bg-signal py-3 text-sm font-semibold text-ink transition-colors hover:bg-paper disabled:opacity-50"
            >
              {loading ? 'Agents are working…' : 'Send failed payment'}
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-line bg-ink-raised p-6 sm:p-8" aria-live="polite">
          {result ? (
            <Result result={result} />
          ) : loading ? (
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Running</p>
              <h3 className="mt-2 font-display text-3xl tracking-tight text-paper">Following the payment through the pipeline</h3>
              <div className="mt-8">
                <Progress />
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full min-h-[22rem] flex-col items-center justify-center text-center">
              <p className="text-sm font-medium text-stop">{error}</p>
              <button type="button" onClick={handleSimulate} className="mt-4 rounded-full border border-line px-4 py-2 text-xs text-paper hover:border-paper/60">
                Try again
              </button>
            </div>
          ) : (
            <div className="flex h-full min-h-[22rem] flex-col justify-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Waiting</p>
              <h3 className="mt-2 max-w-md font-display text-3xl leading-tight tracking-tight text-paper">
                Pick a scenario or fill in the form, then send it.
              </h3>
              <ol className="mt-8 grid gap-3 text-sm text-muted sm:grid-cols-2">
                {STAGES.map((stage, i) => (
                  <li key={stage} className="flex items-center gap-3">
                    <span className="font-mono text-[11px] text-paper/60">{String(i + 1).padStart(2, '0')}</span>
                    {stage}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function SimulatePage() {
  return (
    <AuthGuard roles={['admin']}>
      <SimulateContent />
    </AuthGuard>
  );
}
