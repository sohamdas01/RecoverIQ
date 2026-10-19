'use client';

import React, { useState, useRef } from 'react';
import Link from 'next/link';
import { askRecoverIQ } from '@/lib/api';

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
  const [error, setError] = useState(null);
  const [messages, setMessages] = useState([]);
  const nextMessageId = useRef(0);

  // Handle asking a question
  const handleAsk = async (queryText = inputQuestion) => {
    const q = (queryText || '').trim();
    if (!q) return;

    setError(null);
    setLoading(true);

    const userMessage = {
      id: nextMessageId.current++,
      sender: 'user',
      text: q,
      caseId: selectedCaseId || null,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputQuestion('');

    try {
      const response = await askRecoverIQ({
        question: q,
        caseId: selectedCaseId || undefined,
      });

      const data = response.data || response;
      const botMessage = {
        id: nextMessageId.current++,
        sender: 'bot',
        answer: data.answer || 'No answer generated.',
        evidence: data.evidence || [],
        isGrounded: data.isGrounded !== false,
        caseId: selectedCaseId || null,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, botMessage]);
    } catch (err) {
      console.error('Error querying Ask RecoverIQ:', err);
      setError(err.message || 'Failed to communicate with Ask RecoverIQ.');
      const errorMessage = {
        id: nextMessageId.current++,
        sender: 'bot',
        isError: true,
        answer: `Query error: ${err.message || 'Unable to retrieve answer.'}`,
        evidence: [],
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
      {/* Header */}
      <div className="p-4 sm:p-5 border-b border-slate-800 bg-slate-900/90 backdrop-blur flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400 font-bold shadow-inner">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white tracking-tight">Ask RecoverIQ</h2>
              <span className="px-2 py-0.5 text-[10px] font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-800/60 rounded-full">
                Grounded Explainer
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Query decision lineage, policy guardrails, and recovery telemetry
            </p>
          </div>
        </div>

        {/* Case Selector Filter */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 whitespace-nowrap">Scope:</label>
          <select
            value={selectedCaseId}
            onChange={(e) => setSelectedCaseId(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-xs text-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500 max-w-[220px] truncate"
          >
            <option value="">All Recovery Telemetry</option>
            {cases.map((c) => {
              const id = c.decision?.id || c.id;
              const reason = c.transaction?.failureReason || c.failureReason || 'Case';
              const amt = c.transaction?.amount ? `$${c.transaction.amount}` : '';
              return (
                <option key={id} value={id}>
                  {id ? id.slice(0, 8) : 'Case'}... — {reason} {amt}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {/* Suggested Quick Question Pills */}
      <div className="px-4 sm:px-5 py-3 bg-slate-950/60 border-b border-slate-800/80 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-slate-400">Suggestions:</span>
        {QUICK_QUESTIONS.map((q, idx) => (
          <button
            key={idx}
            onClick={() => handleAsk(q.text)}
            disabled={loading}
            className="text-xs px-2.5 py-1 rounded-full bg-slate-800/80 hover:bg-indigo-950 hover:text-indigo-300 hover:border-indigo-700 border border-slate-700/60 text-slate-300 transition-colors disabled:opacity-50"
          >
            {q.text}
          </button>
        ))}
      </div>

      {/* Messages / Answers History */}
      <div className="p-4 sm:p-5 space-y-4 max-h-[480px] overflow-y-auto">
        {messages.length === 0 ? (
          <div className="text-center py-8 text-slate-400">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-slate-800/60 border border-slate-700 flex items-center justify-center text-slate-400">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </div>
            <p className="text-sm font-medium text-slate-300">Ask any question about RecoverIQ decisions</p>
            <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
              Answers are strictly grounded in PostgreSQL decision lineage, ML reason codes, Agent 1 playbooks, and policy evaluations.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
            >
              {msg.sender === 'user' ? (
                <div className="max-w-[85%] bg-indigo-600 text-white px-4 py-2.5 rounded-2xl rounded-tr-sm text-xs sm:text-sm font-medium shadow-md">
                  {msg.text}
                  {msg.caseId && (
                    <div className="text-[10px] text-indigo-200 mt-1 font-mono">
                      Scope: {msg.caseId}
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className={`max-w-[95%] sm:max-w-[90%] rounded-2xl rounded-tl-sm p-4 text-xs sm:text-sm border shadow-lg ${
                    msg.isError
                      ? 'bg-rose-950/40 border-rose-800/80 text-rose-200'
                      : 'bg-slate-950/80 border-slate-800 text-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2 pb-2 border-b border-slate-800/80">
                    <span className="font-semibold text-indigo-400 text-xs flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
                      RecoverIQ Assistant
                    </span>
                    {msg.isGrounded && (
                      <span className="text-[10px] font-mono bg-emerald-950/80 text-emerald-300 px-2 py-0.5 rounded border border-emerald-800/60 ml-auto">
                        Grounded in Audit Trail
                      </span>
                    )}
                  </div>

                  {/* Markdown / Formatted Answer */}
                  <div className="prose prose-invert prose-xs max-w-none space-y-2 leading-relaxed text-slate-200">
                    {msg.answer.split('\n\n').map((paragraph, pIdx) => (
                      <p key={pIdx} className="whitespace-pre-line">
                        {paragraph}
                      </p>
                    ))}
                  </div>

                  {/* Evidence & Citations */}
                  {msg.evidence && msg.evidence.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-slate-800/80">
                      <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Evidence & Citations ({msg.evidence.length})
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {msg.evidence.map((ev, evIdx) => (
                          <div
                            key={evIdx}
                            className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 text-xs hover:border-slate-700 transition"
                          >
                            <div className="flex items-center justify-between gap-1 mb-1">
                              <span className="font-semibold text-slate-300 text-[11px] truncate">
                                {ev.stage || 'Audit Step'}
                              </span>
                              {ev.ruleId && (
                                <span className="font-mono text-[9px] bg-slate-800 text-amber-300 px-1.5 py-0.5 rounded border border-amber-900/40">
                                  {ev.ruleId}
                                </span>
                              )}
                              {ev.playbookId && (
                                <span className="font-mono text-[9px] bg-indigo-950 text-indigo-300 px-1.5 py-0.5 rounded border border-indigo-800/50">
                                  {ev.playbookId}
                                </span>
                              )}
                            </div>
                            <p className="text-slate-400 text-[11px] line-clamp-2 leading-tight">
                              {ev.detail || 'Verified recorded lineage event.'}
                            </p>
                            {ev.caseId && (
                              <div className="mt-1.5 pt-1 border-t border-slate-800/60 flex items-center justify-between text-[10px]">
                                <span className="text-slate-400 font-mono truncate max-w-[120px]">
                                  {ev.caseId}
                                </span>
                                <Link
                                  href={`/dashboard/cases/${ev.caseId}`}
                                  className="text-indigo-400 hover:text-indigo-300 font-medium"
                                >
                                  View Case &rarr;
                                </Link>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}

        {/* Loading Spinner */}
        {loading && (
          <div className="flex items-center gap-3 p-4 bg-slate-950/60 border border-slate-800/80 rounded-2xl rounded-tl-sm max-w-[70%] text-xs text-slate-400">
            <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
            <span>Consulting decision lineage & synthesizing grounded answer...</span>
          </div>
        )}
      </div>

      {/* Input Form */}
      <div className="p-3 sm:p-4 bg-slate-950 border-t border-slate-800">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAsk();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={inputQuestion}
            onChange={(e) => setInputQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            placeholder={
              selectedCaseId
                ? `Ask about case ${selectedCaseId.slice(0, 8)}... (e.g., Why was this blocked?)`
                : 'Ask about any recovery decision, policy rule, or metrics...'
            }
            className="flex-1 bg-slate-900 border border-slate-700/80 text-xs sm:text-sm text-slate-100 placeholder-slate-400 rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !inputQuestion.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-400 text-white text-xs sm:text-sm font-semibold px-4 py-2.5 rounded-xl transition flex items-center gap-1.5 shadow-md"
          >
            <span>Ask</span>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
