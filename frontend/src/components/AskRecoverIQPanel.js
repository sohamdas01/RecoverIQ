'use client';

import React, { useState, useRef } from 'react';
import Link from 'next/link';
import { askRecoverIQ } from '@/lib/api';
import { formatMoney, reasonLabel, shortId } from '@/lib/format';

const QUICK_QUESTIONS = [
  { text: 'Why was this case blocked?', requiresCase: true },
  { text: 'Why did this case require approval?', requiresCase: true },
  { text: 'What did Agent 1 recommend?', requiresCase: true },
  { text: 'Which playbook was retrieved?', requiresCase: true },
  { text: 'What action did Agent 2 propose?', requiresCase: true },
  { text: 'How much revenue was recovered?', requiresCase: false },
  { text: "Why wasn't the payment retried?", requiresCase: true },
];

export default function AskRecoverIQPanel({ cases = [], activeCaseId = null }) {
  const [selectedCaseId, setSelectedCaseId] = useState(activeCaseId || '');
  const [inputQuestion, setInputQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([]);
  const nextMessageId = useRef(0);

  const suggestions = QUICK_QUESTIONS.filter((q) => selectedCaseId || !q.requiresCase);

  const handleAsk = async (queryText = inputQuestion) => {
    const q = (queryText || '').trim();
    if (!q) return;

    setLoading(true);
    setMessages((prev) => [
      ...prev,
      { id: nextMessageId.current++, sender: 'user', text: q, caseId: selectedCaseId || null },
    ]);
    setInputQuestion('');

    try {
      const response = await askRecoverIQ({ question: q, caseId: selectedCaseId || undefined });
      const data = response.data || response;
      setMessages((prev) => [
        ...prev,
        {
          id: nextMessageId.current++,
          sender: 'bot',
          answer: data.answer || 'No answer generated.',
          evidence: data.evidence || [],
          isGrounded: data.isGrounded !== false,
        },
      ]);
    } catch (err) {
      console.error('Error querying Ask RecoverIQ:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: nextMessageId.current++,
          sender: 'bot',
          isError: true,
          answer: `Query error: ${err.message || 'Unable to retrieve answer.'}`,
          evidence: [],
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-ink-raised">
      <div className="grid lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        {/* Intro and scope */}
        <div className="border-b border-line p-6 lg:border-b-0 lg:border-r">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-signal">Ask RecoverIQ</p>
          <h2 className="mt-3 font-display text-3xl leading-tight tracking-tight text-paper">Ask why, get the receipts.</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Answers come only from the recorded decision trail: model reason codes, retrieved playbooks and policy rules. Every answer cites its evidence.
          </p>

          <label className="mt-6 block">
            <span className="text-xs text-muted">Scope</span>
            <select
              value={selectedCaseId}
              onChange={(e) => setSelectedCaseId(e.target.value)}
              className="mt-2 w-full truncate rounded-lg border border-line bg-ink px-3 py-2 text-sm text-paper focus-visible:border-signal focus-visible:outline-none"
            >
              <option value="">All recovery activity</option>
              {cases.map((c) => {
                const id = c.decision?.id || c.id;
                const txn = c.transaction || {};
                return (
                  <option key={id} value={id}>
                    {shortId(id)} · {reasonLabel(txn.failureReason || c.failureReason)}
                    {txn.amount ? ` · ${formatMoney(txn.amount, txn.currency)}` : ''}
                  </option>
                );
              })}
            </select>
          </label>
        </div>

        {/* Conversation */}
        <div className="flex min-h-[22rem] flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto p-6 lg:max-h-[30rem]">
            {messages.length === 0 ? (
              <div>
                <p className="text-sm text-paper">Try one of these</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {suggestions.map((q) => (
                    <button
                      key={q.text}
                      type="button"
                      onClick={() => handleAsk(q.text)}
                      disabled={loading}
                      className="rounded-full border border-line px-3 py-1.5 text-xs text-paper/85 transition-colors hover:border-signal hover:text-paper disabled:opacity-50"
                    >
                      {q.text}
                    </button>
                  ))}
                </div>
                {!selectedCaseId && (
                  <p className="mt-4 text-xs text-muted">Pick a case under Scope to ask about a specific decision.</p>
                )}
              </div>
            ) : (
              messages.map((msg) =>
                msg.sender === 'user' ? (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-paper/[0.08] px-4 py-2.5 text-sm text-paper">
                      {msg.text}
                      {msg.caseId && <span className="mt-1 block font-mono text-[11px] text-muted">case {shortId(msg.caseId)}</span>}
                    </div>
                  </div>
                ) : (
                  <div key={msg.id} className="max-w-[95%]">
                    <p className={`flex items-center gap-2 text-xs ${msg.isError ? 'text-stop' : 'text-signal'}`}>
                      <span aria-hidden="true" className={`size-1.5 rounded-full ${msg.isError ? 'bg-stop' : 'bg-signal'}`} />
                      RecoverIQ
                      {msg.isGrounded && !msg.isError && <span className="text-muted">· grounded in the audit trail</span>}
                    </p>
                    <div className="mt-2 space-y-2 text-sm leading-relaxed text-paper">
                      {msg.answer.split('\n\n').map((paragraph, pIdx) => (
                        <p key={pIdx} className="whitespace-pre-line">
                          {paragraph}
                        </p>
                      ))}
                    </div>

                    {msg.evidence?.length > 0 && (
                      <div className="mt-4">
                        <p className="text-[11px] uppercase tracking-[0.12em] text-muted">Evidence · {msg.evidence.length}</p>
                        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                          {msg.evidence.map((ev, evIdx) => (
                            <li key={evIdx} className="rounded-lg border border-line bg-ink px-3 py-2.5 text-xs">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate font-medium text-paper">{ev.stage || 'Audit step'}</span>
                                {(ev.ruleId || ev.playbookId) && (
                                  <span className="shrink-0 font-mono text-[10px] text-hold">{ev.ruleId || ev.playbookId}</span>
                                )}
                              </div>
                              <p className="mt-1 line-clamp-2 text-muted">{ev.detail || 'Recorded lineage event.'}</p>
                              {ev.caseId && (
                                <Link href={`/dashboard/cases/${ev.caseId}`} className="mt-1.5 inline-block font-mono text-[11px] text-signal hover:text-paper">
                                  case {shortId(ev.caseId)} →
                                </Link>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )
              )
            )}

            {loading && (
              <p className="flex items-center gap-2.5 text-xs text-muted" role="status">
                <span className="size-3.5 animate-spin rounded-full border-2 border-line border-t-signal" aria-hidden="true" />
                Reading the decision trail…
              </p>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAsk();
            }}
            className="flex items-center gap-2 border-t border-line p-3 sm:p-4"
          >
            <label className="sr-only" htmlFor="ask-recoveriq-input">Your question</label>
            <input
              id="ask-recoveriq-input"
              type="text"
              value={inputQuestion}
              onChange={(e) => setInputQuestion(e.target.value)}
              disabled={loading}
              placeholder={selectedCaseId ? `Ask about case ${shortId(selectedCaseId)}…` : 'Ask about any decision, rule or metric…'}
              className="min-w-0 flex-1 rounded-full border border-line bg-ink px-4 py-2.5 text-sm text-paper placeholder:text-muted/70 focus-visible:border-signal focus-visible:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={loading || !inputQuestion.trim()}
              className="rounded-full bg-signal px-5 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-paper disabled:bg-line disabled:text-muted"
            >
              Ask
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
