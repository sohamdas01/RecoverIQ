'use client';

import { useState } from 'react';

const SHAP_VALUES = [
  ['hard_decline_expired_card', -0.9684],
  ['low_retry_count', 0.3735],
  ['poor_payment_history', -0.3497],
  ['prior_recovery_success', 0.1521],
  ['high_ticket_friction', -0.0745],
];
const MAX_SHAP = Math.max(...SHAP_VALUES.map(([, value]) => Math.abs(value)));

const ROLE_COLUMNS = ['Viewer', 'Reviewer', 'Admin', 'Platform'];
const PERMISSIONS = [
  ['View cases', [true, true, true, false]],
  ['Review cases', [false, true, true, false]],
  ['Run simulator', [false, false, true, false]],
  ['Replay DLQ', [false, false, false, true]],
];

const FAILURE_PATH = [
  ['payment-events', 'Event consumed by the recovery worker', 'text-ink'],
  ['retry 1 → 2 → 3', 'Transient errors back off and try again', 'text-hold-deep'],
  ['dead-letter-events', 'Exhausted events are parked, offset committed', 'text-stop-deep'],
  ['dry run → replay', 'Replayed with a new ID through the same guardrails', 'text-ink'],
  ['409 conflict', 'A second replay of the same event is refused', 'text-signal-deep'],
];

const LINK_STEPS = [
  ['Link sent', 'failed · awaiting_customer', 'bg-hold-deep'],
  ['Customer pays', 'recovered', 'bg-signal-deep'],
  ['Link reused', 'refused · already used', 'bg-stop-deep'],
];

const TRACE_SPANS = [
  ['recovery.pipeline', 0, 100],
  ['ml.inference', 3, 14],
  ['agent1.analysis', 18, 36],
  ['agent2.planning', 55, 22],
  ['policy.evaluation', 78, 4],
  ['tool.execution', 83, 14],
];

function Label({ children }) {
  return <p className="text-[11px] uppercase tracking-[0.12em] text-paper-muted">{children}</p>;
}

function ReviewQueueView() {
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label>Held for review</Label>
          <p className="mt-1 font-display text-5xl leading-none tracking-tight">₹75,000</p>
        </div>
        <span className="rounded border-2 border-hold-deep px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-hold-deep">
          Pending
        </span>
      </div>
      <dl className="mt-5 border-t-2 border-ink text-[13px]">
        {[
          ['Failure', 'insufficient_funds'],
          ['Proposed', 'schedule_retry'],
          ['Rule', 'RULE_MAX_AMOUNT_CEILING'],
        ].map(([label, value]) => (
          <div key={label} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 border-b border-dashed border-paper-line py-2.5">
            <dt className="text-[11px] uppercase tracking-[0.12em] text-paper-muted">{label}</dt>
            <dd className="wrap-break-word">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-[13px] leading-relaxed">Transaction amount exceeds the ₹50,000 autonomous threshold.</p>
      <div aria-hidden="true" className="mt-5 flex flex-wrap gap-2 text-xs font-semibold">
        <span className="rounded-full bg-signal-deep px-4 py-2 text-paper">Approve</span>
        <span className="rounded-full border border-ink px-4 py-2">Modify</span>
        <span className="rounded-full border border-stop-deep px-4 py-2 text-stop-deep">Reject</span>
      </div>
    </div>
  );
}

function RecoveryLinkView() {
  return (
    <div>
      <Label>Customer recovery link</Label>
      <p className="mt-2 truncate border-b-2 border-ink pb-3 text-[15px]">/recover/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…</p>
      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {['Signed', 'Single use', 'Expires in 24h'].map((tag) => (
          <span key={tag} className="rounded-full border border-ink px-3 py-1">{tag}</span>
        ))}
      </div>
      <ol className="mt-7">
        {LINK_STEPS.map(([title, status, dot], index) => (
          <li key={title} className="relative flex gap-4 pb-6 last:pb-0">
            {index < LINK_STEPS.length - 1 && <span aria-hidden="true" className="absolute left-[5px] top-3 h-full w-0.5 bg-paper-line" />}
            <span aria-hidden="true" className={`relative mt-1 size-3 shrink-0 rounded-full ${dot}`} />
            <div>
              <p className="text-[13px] font-semibold">{title}</p>
              <p className="mt-0.5 text-xs text-paper-muted">{status}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ExplainView() {
  return (
    <div>
      <div className="flex items-end justify-between gap-4 border-b-2 border-ink pb-3">
        <div>
          <Label>Recovery odds</Label>
          <p className="mt-1 font-display text-5xl leading-none tracking-tight">28.1%</p>
        </div>
        <p className="text-right text-[11px] uppercase tracking-[0.12em] text-paper-muted">SHAP<br />attributions</p>
      </div>
      <ul className="mt-4 space-y-3">
        {SHAP_VALUES.map(([code, value]) => {
          const width = `${(Math.abs(value) / MAX_SHAP) * 50}%`;
          const isNegative = value < 0;
          return (
            <li key={code}>
              <div className="flex justify-between gap-3 text-xs">
                <span className="min-w-0 truncate">{code}</span>
                <span className={isNegative ? 'text-stop-deep' : 'text-signal-deep'}>
                  {isNegative ? '' : '+'}{value.toFixed(2)}
                </span>
              </div>
              <div aria-hidden="true" className="relative mt-1 h-2 bg-paper-line/50">
                <span className="absolute inset-y-[-2px] left-1/2 w-px bg-ink" />
                <span
                  className={`absolute inset-y-0 ${isNegative ? 'bg-stop-deep' : 'bg-signal-deep'}`}
                  style={isNegative ? { right: '50%', width } : { left: '50%', width }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-5 text-xs text-paper-muted">Playbook PB-04 · RULE_POLICY_CLEAR</p>
    </div>
  );
}

function AskView() {
  return (
    <div className="flex min-h-72 flex-col justify-between gap-8">
      <div>
        <Label>Ask RecoverIQ</Label>
        <p className="mt-4 ml-auto w-fit max-w-[85%] rounded-lg rounded-br-none bg-ink px-4 py-2.5 text-[13px] text-paper">
          Why was this case held for review?
        </p>
        <p className="mt-5 font-display text-[1.65rem] leading-snug">
          The transaction amount (₹75,000) exceeds the ₹50,000 autonomous threshold, so it needs merchant approval.
        </p>
      </div>
      <div className="border-t border-dashed border-paper-line pt-3">
        <Label>Cited from this case</Label>
        <p className="mt-1.5 wrap-break-word text-[13px]">Policy decision · RULE_MAX_AMOUNT_CEILING</p>
      </div>
    </div>
  );
}

function FailureView() {
  return (
    <div>
      <Label>When an event fails</Label>
      <ol className="mt-5">
        {FAILURE_PATH.map(([name, detail, color], index) => (
          <li key={name} className="relative flex gap-4 pb-5 last:pb-0">
            {index < FAILURE_PATH.length - 1 && <span aria-hidden="true" className="absolute left-[3px] top-3 h-full w-0.5 bg-paper-line" />}
            <span aria-hidden="true" className="relative mt-1.5 size-2 shrink-0 rounded-full bg-ink" />
            <div className="min-w-0">
              <p className={`wrap-break-word text-sm font-semibold ${color}`}>{name}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-paper-muted">{detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RolesView() {
  return (
    <div>
      <Label>Role permissions</Label>
      <table className="mt-4 w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b-2 border-ink">
            <th scope="col" className="py-2 pr-2 font-normal"><span className="sr-only">Permission</span></th>
            {ROLE_COLUMNS.map((role) => (
              <th key={role} scope="col" className="px-0.5 py-2 text-center text-[10px] font-medium uppercase tracking-[0.04em] sm:text-[11px]">{role}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERMISSIONS.map(([permission, allowed]) => (
            <tr key={permission} className="border-b border-dashed border-paper-line">
              <th scope="row" className="py-3.5 pr-2 font-normal">{permission}</th>
              {allowed.map((isAllowed, index) => (
                <td key={ROLE_COLUMNS[index]} className="text-center">
                  <span aria-hidden="true" className={isAllowed ? 'text-base leading-none text-signal-deep' : 'text-paper-muted'}>
                    {isAllowed ? '●' : '–'}
                  </span>
                  <span className="sr-only">{isAllowed ? 'Allowed' : 'Not allowed'}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-5 text-[13px] leading-relaxed">Every query is scoped to the signed-in merchant.</p>
      <p className="mt-2 text-xs leading-relaxed text-paper-muted">
        Disable a user or suspend a merchant and access ends on their next request.
      </p>
    </div>
  );
}

function ObservabilityView() {
  return (
    <div>
      <Label>One case, end to end</Label>
      <ul className="mt-5 space-y-3">
        {TRACE_SPANS.map(([name, offset, width]) => (
          <li key={name}>
            <p className="text-xs">{name}</p>
            <div aria-hidden="true" className="relative mt-1 h-2.5 bg-paper-line/50">
              <span className="absolute inset-y-0 bg-ink" style={{ left: `${offset}%`, width: `${width}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-5 border-t border-dashed border-paper-line pt-3 text-xs leading-relaxed text-paper-muted">
        W3C trace context crosses HTTP and Kafka. Span order is real, bar widths are illustrative.
      </p>
    </div>
  );
}

const CAPABILITIES = [
  {
    title: 'Human review queue',
    body: 'Held cases arrive with the full evidence trail. Reviewers approve, modify or reject, and policy re-checks the result.',
    panel: 'Review queue',
    View: ReviewQueueView,
  },
  {
    title: 'Customer recovery links',
    body: 'A case only counts as recovered once the customer has actually paid.',
    panel: 'Recovery link',
    View: RecoveryLinkView,
  },
  {
    title: 'Explainable decisions',
    body: 'Each case keeps its reason codes, matched playbooks, agent rationale and the exact policy rule applied.',
    panel: 'Decision record',
    View: ExplainView,
  },
  {
    title: 'Ask RecoverIQ',
    body: 'Ask why a case went the way it did. Answers are grounded in that case’s stored evidence.',
    panel: 'Grounded answer',
    View: AskView,
  },
  {
    title: 'Built for failure',
    body: 'Bounded retries, a dead-letter queue and idempotent replay contain a bad event.',
    panel: 'Failure path',
    View: FailureView,
  },
  {
    title: 'Merchant isolation',
    body: 'Four roles and tenant-scoped data, checked against the database on every request.',
    panel: 'Access control',
    View: RolesView,
  },
  {
    title: 'Full observability',
    body: 'Structured logs, Prometheus metrics and OpenTelemetry traces follow one case across every service.',
    panel: 'Distributed trace',
    View: ObservabilityView,
  },
];

function CapabilityPanel({ capability }) {
  const { panel, View } = capability;

  return (
    <div key={panel} className="trace-row case-file-edge bg-paper px-5 pb-9 pt-5 font-mono text-ink sm:px-7 sm:pt-6">
      <div className="mb-5 flex items-center justify-between gap-4 border-b border-paper-line pb-2.5 text-[11px] uppercase tracking-[0.12em] text-paper-muted">
        <span>{panel}</span>
        <span>Sample</span>
      </div>
      <View />
    </div>
  );
}

export default function PlatformExplorer() {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeCapability = CAPABILITIES[activeIndex];

  return (
    <div className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
      <ul className="border-t border-line">
        {CAPABILITIES.map((capability, index) => {
          const isActive = index === activeIndex;
          return (
            <li key={capability.title} className="border-b border-line">
              <button
                type="button"
                aria-pressed={isActive}
                onClick={() => setActiveIndex(index)}
                className={`group relative grid w-full grid-cols-[2.25rem_minmax(0,1fr)] py-5 pl-4 pr-2 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal ${
                  isActive ? 'bg-ink-raised' : 'hover:bg-ink-raised/60'
                }`}
              >
                <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-0.5 ${isActive ? 'bg-signal' : 'bg-transparent'}`} />
                <span className={`pt-1.5 font-mono text-xs ${isActive ? 'text-signal' : 'text-muted'}`}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span>
                  <span className={`block font-display text-2xl leading-tight tracking-tight transition-colors ${isActive ? 'text-paper' : 'text-paper/75 group-hover:text-paper'}`}>
                    {capability.title}
                  </span>
                  <span className="mt-1.5 block text-sm leading-relaxed text-muted">{capability.body}</span>
                </span>
              </button>
              {isActive && (
                <div className="py-5 lg:hidden">
                  <CapabilityPanel capability={capability} />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="hidden lg:block">
        <div className="sticky top-24">
          <CapabilityPanel capability={activeCapability} />
        </div>
      </div>
    </div>
  );
}
