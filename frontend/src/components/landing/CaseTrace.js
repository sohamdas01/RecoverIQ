'use client';

import { useEffect, useState } from 'react';

const ROTATE_MS = 7000;
const ROW_STAGGER_MS = 130;

const VERDICT_STYLES = {
  ALLOW: 'text-signal-deep border-signal-deep',
  REQUIRE_APPROVAL: 'text-hold-deep border-hold-deep',
  BLOCK: 'text-stop-deep border-stop-deep',
};

const CASES = [
  {
    id: 'card_expired',
    tab: 'Expired card',
    amount: '₹2,999',
    method: 'Card',
    failure: 'card_expired',
    score: '28.1%',
    playbook: 'PB-04 · Direct retry suppression & self-service link',
    action: 'send_recovery_message',
    rule: 'RULE_POLICY_CLEAR',
    verdict: 'ALLOW',
    stamp: 'Allowed',
    result: 'Signed payment link sent. Waiting on the customer.',
  },
  {
    id: 'bank_outage',
    tab: 'Bank outage',
    amount: '₹4,999',
    method: 'UPI',
    failure: 'bank_outage',
    score: '66.2%',
    playbook: 'PB-06 · Immediate automated re-capture',
    action: 'attempt_recovery',
    rule: 'RULE_POLICY_CLEAR',
    verdict: 'ALLOW',
    stamp: 'Allowed',
    result: 'Retried automatically. Payment captured.',
  },
  {
    id: 'high_value',
    tab: 'High value',
    amount: '₹75,000',
    method: 'Card',
    failure: 'insufficient_funds',
    score: '46.6%',
    playbook: 'PB-03 · Multi-attempt exhaustion',
    action: 'schedule_retry',
    rule: 'RULE_MAX_AMOUNT_CEILING',
    verdict: 'REQUIRE_APPROVAL',
    stamp: 'Held',
    result: 'Above the ₹50,000 limit. Sent to a merchant to review.',
  },
  {
    id: 'fraud',
    tab: 'Fraud flag',
    amount: '₹95,000',
    method: 'Card',
    failure: 'high_risk_fraud',
    score: '4.1%',
    playbook: 'PB-10 · Security quarantine & human escalation',
    action: 'escalate_to_human',
    rule: 'RULE_FRAUD_BLOCK',
    verdict: 'BLOCK',
    stamp: 'Blocked',
    result: 'Stopped by policy. No recovery tool ran.',
  },
];

function TraceRow({ label, value, index }) {
  return (
    <div
      className="trace-row grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 border-b border-dashed border-paper-line py-2.5"
      style={{ animationDelay: `${index * ROW_STAGGER_MS}ms` }}
    >
      <dt className="text-[11px] uppercase tracking-[0.12em] text-paper-muted">{label}</dt>
      <dd className="min-w-0 wrap-break-word text-[13px] leading-snug text-ink">{value}</dd>
    </div>
  );
}

export default function CaseTrace() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (hovering || pinned) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const timer = setInterval(() => {
      setActiveIndex((index) => (index + 1) % CASES.length);
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, [hovering, pinned]);

  const active = CASES[activeIndex];
  const rows = [
    ['Failure', active.failure],
    ['ML score', `${active.score} recovery odds`],
    ['Playbook', active.playbook],
    ['Proposed', active.action],
    ['Policy', active.rule],
  ];

  return (
    <div onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Choose a sample case">
        {CASES.map((item, index) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={index === activeIndex}
            onClick={() => {
              setActiveIndex(index);
              setPinned(true);
            }}
            className={`rounded-full border px-3 py-1.5 font-mono text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal ${
              index === activeIndex
                ? 'border-paper bg-paper text-ink'
                : 'border-line text-muted hover:border-muted hover:text-paper'
            }`}
          >
            {item.tab}
          </button>
        ))}
      </div>

      <article className="case-file-edge relative bg-paper px-5 pb-8 pt-5 font-mono text-ink sm:px-7 sm:pt-6">
        <header className="flex items-start justify-between gap-4 border-b-2 border-ink pb-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-paper-muted">Recovery case file</p>
            <p className="mt-1 font-display text-5xl leading-none tracking-tight">{active.amount}</p>
          </div>
          <p className="pt-0.5 text-right text-[11px] uppercase tracking-[0.12em] text-paper-muted">
            {active.method}
            <br />
            Failed
          </p>
        </header>

        <dl key={active.id} className="min-h-62">
          {rows.map(([label, value], index) => (
            <TraceRow key={label} label={label} value={value} index={index} />
          ))}
        </dl>

        <footer
          key={`${active.id}-result`}
          className="trace-row mt-3 flex items-center justify-between gap-4"
          style={{ animationDelay: `${rows.length * ROW_STAGGER_MS}ms` }}
        >
          <p className="max-w-60 text-[13px] leading-snug">{active.result}</p>
          <span
            className={`trace-stamp shrink-0 rounded border-2 px-2.5 py-1 text-sm font-semibold uppercase tracking-[0.14em] ${VERDICT_STYLES[active.verdict]}`}
            style={{ animationDelay: `${(rows.length + 1) * ROW_STAGGER_MS}ms` }}
          >
            {active.stamp}
          </span>
        </footer>
      </article>

      <p className="mt-3 font-mono text-[11px] text-muted">Sample decisions from the RecoverIQ simulator.</p>
    </div>
  );
}
