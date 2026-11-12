import Link from 'next/link';
import AuthCta from '@/components/landing/AuthCta';
import CaseTrace from '@/components/landing/CaseTrace';
import PlatformExplorer from '@/components/landing/PlatformExplorer';

const FACTS = [
  ['6', 'stages on every case'],
  ['16', 'recovery playbooks'],
  ['5', 'bounded tools'],
  ['3', 'policy verdicts'],
];

const STAGES = [
  {
    name: 'Ingest',
    output: 'payment.failed',
    points: [
      'The failed payment is saved to PostgreSQL first',
      'Kafka carries IDs and payment data, never customer details',
      'Duplicate events are dropped by idempotency key',
    ],
  },
  {
    name: 'Score',
    output: '28.1% recovery odds',
    points: [
      'An XGBoost model estimates the odds of recovery',
      'SHAP reason codes explain what moved the score',
    ],
  },
  {
    name: 'Retrieve',
    output: 'PB-04 · 68% match',
    points: [
      'Vector search runs across 16 playbooks in Qdrant',
      'The closest strategies are handed to the agents as evidence',
    ],
  },
  {
    name: 'Reason',
    output: 'send_recovery_message',
    points: [
      'The Analyst agent diagnoses why this payment failed',
      'The Executor agent turns that into one concrete action',
    ],
  },
  {
    name: 'Gate',
    output: 'ALLOW · RULE_POLICY_CLEAR',
    isGate: true,
    points: [
      'Deterministic rules can overrule both agents',
      'Every action leaves as ALLOW, REQUIRE_APPROVAL or BLOCK',
    ],
  },
  {
    name: 'Act',
    output: 'Link sent · awaiting customer',
    points: [
      'One of five bounded tools runs, and nothing else can',
      'The outcome is written back to the case atomically',
      'Failed events go to a dead-letter queue for safe replay',
    ],
  },
];

const PIPE_ROW = 'grid grid-cols-[44px_minmax(0,1fr)] lg:grid-cols-[18rem_72px_minmax(0,1fr)]';

const VERDICTS = [
  {
    name: 'ALLOW',
    color: 'text-signal',
    bar: 'bg-signal',
    title: 'Runs on its own',
    body: 'The action is inside policy, so the tool executes and the case records what happened.',
    rules: ['RULE_POLICY_CLEAR'],
  },
  {
    name: 'REQUIRE_APPROVAL',
    color: 'text-hold',
    bar: 'bg-hold',
    title: 'Waits for a person',
    body: 'Large or uncertain cases go to the review queue, where a merchant can approve, modify or reject.',
    rules: ['RULE_MAX_AMOUNT_CEILING', 'RULE_MAX_RETRIES_EXCEEDED', 'RULE_HIGH_VALUE_LOW_CONFIDENCE'],
  },
  {
    name: 'BLOCK',
    color: 'text-stop',
    bar: 'bg-stop',
    title: 'Never executes',
    body: 'Fraud flags and closed cases stop here. No agent output can reach a tool past this point.',
    rules: ['RULE_FRAUD_BLOCK', 'RULE_TERMINAL_STATE_RECOVERED', 'RULE_UNSUPPORTED_ACTION'],
  },
];

const STACK = 'Next.js · Node.js · FastAPI · Kafka · PostgreSQL · Redis · XGBoost · Qdrant';

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal';
const navLink = `rounded text-sm text-muted transition-colors hover:text-paper ${focusRing}`;
const primaryButton = `inline-flex items-center justify-center rounded-full bg-signal px-6 py-3 text-sm font-semibold text-ink transition-colors hover:bg-paper ${focusRing}`;

function SectionLabel({ children }) {
  return <p className="font-mono text-xs uppercase tracking-[0.16em] text-signal">{children}</p>;
}

export default function HomePage() {
  return (
    <div className="min-h-screen bg-ink font-sans text-paper selection:bg-signal selection:text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-ink/90 backdrop-blur">
        <nav aria-label="Primary" className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-8">
          <Link href="/" className={`rounded font-display text-2xl tracking-tight ${focusRing}`}>
            RecoverIQ
          </Link>
          <div className="flex items-center gap-7">
            <a href="#pipeline" className={`hidden md:block ${navLink}`}>Pipeline</a>
            <a href="#guardrails" className={`hidden md:block ${navLink}`}>Guardrails</a>
            <a href="#platform" className={`hidden md:block ${navLink}`}>Platform</a>
            <AuthCta
              signedInLabel="Dashboard"
              className={`rounded-full border border-line px-4 py-2 text-sm font-medium transition-colors hover:border-paper ${focusRing}`}
            />
          </div>
        </nav>
      </header>

      <main>
        <section className="relative overflow-hidden">
          <div aria-hidden="true" className="ledger-rules absolute inset-0" />
          <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-4 pb-16 pt-14 sm:px-8 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-16 lg:pb-24 lg:pt-20">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted">Autonomous payment recovery</p>
              <h1 className="mt-6 font-display text-[clamp(3.25rem,7.4vw,6.75rem)] leading-[0.94] tracking-[-0.02em]">
                A declined card is not a lost <em className="text-signal">customer.</em>
              </h1>
              <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted">
                RecoverIQ reads each failed payment, works out why it failed, and takes the one recovery step your policy allows.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <AuthCta className={primaryButton} />
                <a
                  href="#pipeline"
                  className={`inline-flex items-center justify-center rounded-full border border-line px-6 py-3 text-sm font-medium transition-colors hover:border-paper ${focusRing}`}
                >
                  See the pipeline
                </a>
              </div>
            </div>
            <CaseTrace />
          </div>
        </section>

        <section aria-label="System at a glance" className="border-y border-line">
          <dl className="mx-auto grid max-w-7xl grid-cols-2 px-4 sm:px-8 lg:grid-cols-4">
            {FACTS.map(([value, label]) => (
              <div key={label} className="flex items-baseline gap-3 py-6">
                <dd className="font-display text-4xl leading-none">{value}</dd>
                <dt className="text-sm text-muted">{label}</dt>
              </div>
            ))}
          </dl>
        </section>

        <section id="pipeline" className="mx-auto max-w-7xl scroll-mt-16 px-4 py-20 sm:px-8 lg:py-28">
          <SectionLabel>The pipeline</SectionLabel>
          <h2 className="mt-4 max-w-3xl font-display text-[clamp(2.5rem,5vw,4.25rem)] leading-[1.02] tracking-[-0.015em]">
            Every failure gets its own case file.
          </h2>
          <div className="pipeline relative mt-12">
            <div aria-hidden="true" className="pipeline-tube absolute inset-y-0 w-3.5 -translate-x-1/2 overflow-hidden border-x border-line bg-ink-raised">
              <div className="pipe-flow absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2" />
              <div className="pipe-packet absolute left-1/2 size-2 -translate-x-1/2 rounded-full bg-signal" />
            </div>

            <div className={`${PIPE_ROW} relative pb-4`}>
              <p className="hidden pr-8 text-right font-mono text-xs uppercase tracking-[0.12em] text-muted lg:block">
                Sample: expired card
              </p>
              <div aria-hidden="true" className="flex justify-center">
                <span className="h-1.5 w-9 rounded-sm bg-muted" />
              </div>
              <p className="pl-4 font-mono text-xs uppercase tracking-[0.12em] text-signal lg:pl-6">In: a failed payment</p>
            </div>

            <ol className="relative">
              {STAGES.map((stage, index) => (
                <li key={stage.name} className={`${PIPE_ROW} py-7`}>
                  <div className="col-start-2 row-start-2 mt-4 pl-4 lg:col-start-1 lg:row-start-1 lg:mt-0 lg:flex lg:h-11 lg:items-center lg:justify-end lg:pl-0">
                    <p className={`font-mono text-xs ${stage.isGate ? 'text-signal' : 'text-paper'}`}>
                      <span className="text-muted lg:hidden">Output: </span>
                      {stage.output}
                    </p>
                    <span aria-hidden="true" className="ml-3 hidden h-px w-6 bg-muted lg:block" />
                  </div>

                  <div aria-hidden="true" className="relative z-10 col-start-1 row-start-1 flex h-11 items-center justify-center lg:col-start-2">
                    {stage.isGate ? (
                      <span className="flex size-9 rotate-45 items-center justify-center rounded-md border-2 border-hold bg-ink">
                        <span className="-rotate-45 font-mono text-xs text-hold">{index + 1}</span>
                      </span>
                    ) : (
                      <span className="flex size-11 items-center justify-center rounded-full border-2 border-muted bg-ink font-mono text-xs text-paper">
                        {index + 1}
                      </span>
                    )}
                  </div>

                  <div className="col-start-2 row-start-1 pl-4 lg:col-start-3 lg:pl-6">
                    <h3 className="flex font-display text-3xl tracking-tight lg:h-11 lg:items-center">{stage.name}</h3>
                    <ul className="mt-2 max-w-xl space-y-1.5 text-[15px] leading-relaxed text-muted">
                      {stage.points.map((point) => (
                        <li key={point} className="flex gap-2.5">
                          <span aria-hidden="true" className="mt-[0.7em] h-px w-3 shrink-0 bg-signal" />
                          {point}
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
            </ol>

            <div className={`${PIPE_ROW} relative pt-4`}>
              <span aria-hidden="true" className="hidden lg:block" />
              <div aria-hidden="true" className="flex items-end justify-center">
                <span className="h-1.5 w-9 rounded-sm bg-muted" />
              </div>
              <p className="flex items-end pl-4 font-mono text-xs uppercase tracking-[0.12em] text-signal lg:pl-6">
                Out: a decided, auditable case
              </p>
            </div>
          </div>
        </section>

        <section id="guardrails" className="scroll-mt-16 bg-ink-raised">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-8 lg:py-28">
            <SectionLabel>Guardrails</SectionLabel>
            <h2 className="mt-4 font-display text-[clamp(2.5rem,5vw,4.25rem)] leading-[1.02] tracking-[-0.015em]">
              The model proposes. <em>Policy decides.</em>
            </h2>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">
              Agents suggest what to do. Plain, testable rules decide whether it happens, so nothing reaches a customer on model confidence alone.
            </p>
            <div className="mt-12 grid gap-10 lg:grid-cols-3 lg:gap-8">
              {VERDICTS.map((verdict) => (
                <article key={verdict.name}>
                  <div aria-hidden="true" className={`h-1 ${verdict.bar}`} />
                  <p className={`mt-5 font-mono text-sm font-medium ${verdict.color}`}>{verdict.name}</p>
                  <h3 className="mt-3 font-display text-3xl tracking-tight">{verdict.title}</h3>
                  <p className="mt-3 text-[15px] leading-relaxed text-muted">{verdict.body}</p>
                  <ul className="mt-5 space-y-1.5 wrap-break-word font-mono text-xs text-muted">
                    {verdict.rules.map((rule) => <li key={rule}>{rule}</li>)}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="platform" className="mx-auto max-w-7xl scroll-mt-16 px-4 py-20 sm:px-8 lg:py-28">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-12">
            <div>
              <SectionLabel>The platform</SectionLabel>
              <h2 className="mt-4 font-display text-[clamp(2.5rem,5vw,4.25rem)] leading-[1.02] tracking-[-0.015em]">
                Autonomy you can audit.
              </h2>
            </div>
            <p className="max-w-sm text-[15px] leading-relaxed text-muted lg:pb-2">
              Pick a capability to see what it leaves behind.
            </p>
          </div>
          <PlatformExplorer />
        </section>

        <section className="border-t border-line">
          <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 px-4 py-20 sm:px-8 lg:flex-row lg:items-end lg:py-24">
            <h2 className="max-w-3xl font-display text-[clamp(2.75rem,6vw,5.5rem)] leading-[0.98] tracking-[-0.02em]">
              Give every failed payment a <em className="text-signal">second decision.</em>
            </h2>
            <AuthCta className={`${primaryButton} shrink-0`} />
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-7 font-mono text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>RecoverIQ</p>
          <p>{STACK}</p>
        </div>
      </footer>
    </div>
  );
}
