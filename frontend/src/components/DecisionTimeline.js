'use client';

import React from 'react';
import { PolicyBadge, StatusBadge, ActionBadge } from './StatusBadge';

export default function DecisionTimeline({ caseData, loading = false }) {
  if (loading) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="h-4 w-48 bg-slate-800 rounded animate-pulse" />
        <div className="space-y-6 pt-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex gap-4 items-start">
              <div className="w-4 h-4 rounded-full bg-slate-800 animate-pulse shrink-0 mt-1" />
              <div className="space-y-2 flex-1">
                <div className="h-3 w-32 bg-slate-800 rounded animate-pulse" />
                <div className="h-3 w-full bg-slate-800/60 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!caseData) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-500">
        No decision timeline available for this case.
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
    createdAt,
  } = caseData;

  const amount = Number(transaction.amount || 0).toFixed(2);
  const currency = transaction.currency || 'USD';
  const mlScore = typeof ml.score === 'number' ? ml.score : typeof ml.probability === 'number' ? ml.probability : 0.75;
  const scorePercent = Math.round(mlScore * 100);
  const playbookSources = agent1.playbookSources || [];
  const latestOverride = overrides.length > 0 ? overrides[0] : null;

  const isPendingReview = status === 'pending_review' || policy.decision === 'REQUIRE_APPROVAL';
  const isBlocked = status === 'blocked' || policy.decision === 'BLOCK';
  const isRecovered = status === 'recovered';
  const isExecuted = status === 'executed';

  // Construct the 9 explicit chronological steps
  const steps = [
    // Step 1: Payment Failure Ingestion
    {
      id: 'step_1_ingestion',
      stepNum: 1,
      title: 'Payment Failure Ingested',
      subtitle: 'Kafka Consumer Ingestion',
      timestamp: transaction.createdAt || createdAt,
      badge: <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-rose-950/60 text-rose-300 border border-rose-800/40">FAILED</span>,
      iconColor: 'bg-rose-500',
      content: (
        <div className="space-y-1 text-xs text-slate-300">
          <p>
            Payment attempt of <strong className="text-white">{currency} {amount}</strong> failed via <span className="capitalize text-slate-200">{transaction.paymentGateway || transaction.gateway || 'payment gateway'}</span>.
          </p>
          <p className="text-[11px] text-slate-400 font-mono">
            Reason: <span className="text-rose-300">{transaction.failureReason || 'INSUFFICIENT_FUNDS'}</span> (Code: {transaction.errorCode || 'card_declined'}) • Attempt #{transaction.attemptCount || 1}
          </p>
        </div>
      ),
    },

    // Step 2: ML Recovery Likelihood Scoring
    {
      id: 'step_2_ml',
      stepNum: 2,
      title: 'ML Recovery Likelihood Scored',
      subtitle: `Model ${ml.modelVersion || 'v1.0.0'}`,
      timestamp: createdAt,
      badge: (
        <span className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded border ${
          scorePercent >= 70 ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40' : scorePercent >= 40 ? 'bg-amber-950/60 text-amber-400 border-amber-800/40' : 'bg-rose-950/60 text-rose-400 border-rose-800/40'
        }`}>
          {scorePercent}% Probability
        </span>
      ),
      iconColor: 'bg-cyan-500',
      content: (
        <div className="space-y-2 text-xs text-slate-300">
          <p>
            Machine Learning model predicted a <strong className={scorePercent >= 70 ? 'text-emerald-400' : 'text-amber-400'}>{scorePercent}% probability</strong> of successful payment recovery.
          </p>
          {ml.reasonCodes && ml.reasonCodes.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {ml.reasonCodes.map((rc, i) => (
                <span key={i} className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-400">
                  {rc}
                </span>
              ))}
            </div>
          )}
        </div>
      ),
    },

    // Step 3: Agent 1 (Recovery Analyst) Diagnosis
    {
      id: 'step_3_agent1',
      stepNum: 3,
      title: 'Agent 1: Recovery Analyst Diagnosis',
      subtitle: `Confidence: ${Math.round((agent1.confidence || 0.85) * 100)}%`,
      timestamp: createdAt,
      badge: <ActionBadge action={agent1.recommendation || finalAction} />,
      iconColor: 'bg-blue-500',
      content: (
        <div className="space-y-1.5 text-xs text-slate-300">
          <p className="leading-relaxed">
            {agent1.rationale || 'Analyzed failure context, customer risk tier, and historical transaction telemetry.'}
          </p>
          <div className="text-[11px] text-slate-400">
            Recommended Action: <strong className="text-slate-200 font-mono">{agent1.recommendation || finalAction || 'attempt_recovery'}</strong>
          </div>
        </div>
      ),
    },

    // Step 4: Qdrant Vector RAG Playbooks Retrieved
    {
      id: 'step_4_rag',
      stepNum: 4,
      title: 'Qdrant Vector RAG Retrieval',
      subtitle: `${playbookSources.length} Matched Playbooks`,
      timestamp: createdAt,
      badge: (
        <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-cyan-950/60 text-cyan-400 border border-cyan-800/40">
          Vector Index
        </span>
      ),
      iconColor: 'bg-teal-500',
      content: (
        <div className="space-y-2 text-xs">
          {playbookSources.length > 0 ? (
            <div className="space-y-1.5">
              {playbookSources.map((pb, idx) => (
                <div key={idx} className="p-2 bg-slate-950/70 border border-slate-800 rounded-lg flex items-center justify-between text-[11px]">
                  <div>
                    <span className="font-semibold text-slate-200">{pb.title || `Playbook #${idx + 1}`}</span>
                    <span className="text-slate-400 ml-2">Action: <strong className="text-slate-300">{pb.strategy || pb.action}</strong></span>
                  </div>
                  {pb.similarity && (
                    <span className="font-mono text-cyan-400 bg-cyan-950 px-1.5 py-0.5 rounded border border-cyan-800/30">
                      {(pb.similarity * 100).toFixed(1)}% match
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-400 italic text-[11px]">
              Standard default recovery playbook applied for {transaction.failureReason || 'declined payment'}.
            </p>
          )}
        </div>
      ),
    },

    // Step 5: Agent 2 (Recovery Executor) Formulation
    {
      id: 'step_5_agent2',
      stepNum: 5,
      title: 'Agent 2: Recovery Executor Plan',
      subtitle: 'Bounded Parameter Formulation',
      timestamp: createdAt,
      badge: <ActionBadge action={agent2.proposedAction || finalAction} />,
      iconColor: 'bg-indigo-500',
      content: (
        <div className="space-y-2 text-xs text-slate-300">
          <p>
            Formulated concrete execution parameters for <strong className="text-slate-200 font-mono">{agent2.proposedAction || finalAction}</strong>.
          </p>
          {agent2.parameters && Object.keys(agent2.parameters).length > 0 && (
            <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 font-mono text-[11px] text-emerald-400 overflow-x-auto">
              {JSON.stringify(agent2.parameters, null, 2)}
            </div>
          )}
        </div>
      ),
    },

    // Step 6: Policy Engine Safety Evaluation
    {
      id: 'step_6_policy',
      stepNum: 6,
      title: 'Policy Engine Guardrail Gating',
      subtitle: policy.primaryRuleId ? `Rule: ${policy.primaryRuleId}` : 'Deterministic Gate',
      timestamp: policy.evaluatedAt || createdAt,
      badge: <PolicyBadge decision={policy.decision} />,
      iconColor: policy.decision === 'ALLOW' ? 'bg-emerald-500' : policy.decision === 'REQUIRE_APPROVAL' ? 'bg-amber-500' : 'bg-rose-500',
      content: (
        <div className="space-y-1.5 text-xs text-slate-300">
          <p>
            Evaluated proposed action against strict safety guardrails. Verdict: <strong className={policy.decision === 'ALLOW' ? 'text-emerald-400' : policy.decision === 'REQUIRE_APPROVAL' ? 'text-amber-400' : 'text-rose-400'}>{policy.decision}</strong>.
          </p>
          {policy.reasons && policy.reasons.length > 0 && (
            <ul className="list-disc list-inside text-[11px] text-slate-400 space-y-0.5">
              {policy.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      ),
    },

    // Step 7: Human-in-the-Loop Review (If Applicable)
    ...(policy.decision === 'REQUIRE_APPROVAL' || overrides.length > 0 || isPendingReview
      ? [
          {
            id: 'step_7_hitl',
            stepNum: 7,
            title: 'Human-in-the-Loop Review',
            subtitle: latestOverride ? 'Merchant Action Completed' : 'Awaiting Reviewer',
            timestamp: latestOverride?.createdAt || (isPendingReview ? 'Pending' : createdAt),
            badge: latestOverride ? (
              <span className="px-2 py-0.5 text-[10px] font-mono font-bold rounded bg-cyan-950 text-cyan-300 border border-cyan-800">
                {latestOverride.merchantAction || 'REVIEWED'}
              </span>
            ) : (
              <span className="px-2 py-0.5 text-[10px] font-mono font-bold rounded bg-amber-950 text-amber-300 border border-amber-800 animate-pulse">
                PENDING
              </span>
            ),
            iconColor: latestOverride ? 'bg-cyan-500' : 'bg-amber-500',
            content: (
              <div className="space-y-1 text-xs text-slate-300">
                {latestOverride ? (
                  <>
                    <p>
                      Merchant reviewer decision: <strong className="text-white">{latestOverride.merchantAction || 'Approved'}</strong>.
                    </p>
                    <p className="text-[11px] text-slate-400 italic">
                      Reasoning: &quot;{latestOverride.merchantReasoning}&quot;
                    </p>
                  </>
                ) : (
                  <p className="text-amber-300/90">
                    Case is currently in the merchant Human-in-the-Loop queue awaiting review authorization.
                  </p>
                )}
              </div>
            ),
          },
        ]
      : []),

    // Step 8: Tool Execution (If Tool Dispatched)
    ...(execution || isExecuted || isRecovered
      ? [
          {
            id: 'step_8_execution',
            stepNum: 8,
            title: 'Recovery Tool Execution',
            subtitle: execution?.toolName || 'Automated Tool Gate',
            timestamp: execution?.executedAt || createdAt,
            badge: (
              <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                {execution?.status || 'DISPATCHED'}
              </span>
            ),
            iconColor: 'bg-emerald-500',
            content: (
              <div className="space-y-1 text-xs text-slate-300">
                <p>
                  Tool <code className="font-mono text-emerald-400">{execution?.toolName || finalAction || 'attempt_recovery'}</code> was dispatched to capture the payment.
                </p>
                {execution?.recoveryUrl && (
                  <p className="text-[11px]">
                    <a
                      href={execution.recoveryUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-400 hover:text-emerald-300 underline font-medium"
                    >
                      Customer Recovery Link Generated ↗
                    </a>
                  </p>
                )}
              </div>
            ),
          },
        ]
      : []),

    // Step 9: Final Recovery Outcome
    {
      id: 'step_9_outcome',
      stepNum: 9,
      title: 'Final Recovery Outcome',
      subtitle: isRecovered ? 'Revenue Preserved' : isBlocked ? 'Protected by Guardrail' : 'Status Resolution',
      timestamp: createdAt,
      badge: <StatusBadge status={status} />,
      iconColor: isRecovered || isExecuted ? 'bg-emerald-500' : isBlocked ? 'bg-rose-500' : isPendingReview ? 'bg-amber-500' : 'bg-slate-500',
      content: (
        <div className="space-y-1 text-xs text-slate-300">
          {isRecovered ? (
            <p className="text-emerald-300 font-medium">
              Payment of <strong className="text-white">{currency} {amount}</strong> successfully recovered and captured.
            </p>
          ) : isExecuted ? (
            <p className="text-slate-300">
              Recovery workflow executed. Awaiting customer confirmation or gateway settlement.
            </p>
          ) : isBlocked ? (
            <p className="text-rose-300">
              Transaction halted by Policy Engine. No unauthorized actions taken.
            </p>
          ) : (
            <p className="text-slate-400">
              Current state: <strong className="text-slate-200 capitalize">{status}</strong>.
            </p>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-6 shadow-sm space-y-6">
      <div className="flex items-center justify-between pb-4 border-b border-slate-800">
        <div>
          <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
            <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Decision Explanation & Audit Timeline
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Step-by-step evidence explaining why RecoverIQ reached this decision
          </p>
        </div>
        <span className="text-xs font-mono font-medium text-slate-500 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800">
          {steps.length} Stages
        </span>
      </div>

      <div className="relative border-l border-slate-800 ml-3 space-y-8 pl-6">
        {steps.map((step) => {
          const formattedTime = step.timestamp && step.timestamp !== 'Pending'
            ? new Date(step.timestamp).toLocaleTimeString()
            : step.timestamp || '';

          return (
            <div key={step.id} className="relative group">
              {/* Dot Icon on Timeline Axis */}
              <div
                className={`absolute -left-[31px] top-1 w-3.5 h-3.5 rounded-full ${step.iconColor} ring-4 ring-slate-900 shadow-sm`}
              />

              <div className="space-y-2">
                {/* Step Header */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-200 group-hover:text-cyan-300 transition-colors">
                      {step.title}
                    </span>
                    {step.badge}
                  </div>
                  {formattedTime && (
                    <span className="text-[11px] font-mono text-slate-500">
                      {formattedTime}
                    </span>
                  )}
                </div>

                {/* Step Body Content */}
                <div className="p-3.5 bg-slate-950/60 rounded-xl border border-slate-800/80">
                  {step.content}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
