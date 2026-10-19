import React from 'react';

export default function SummaryCards({
  totalCases = 0,
  recoveredRevenue = 0,
  recoveredCount = 0,
  pendingReview = 0,
  blockedOrFailed = 0,
  currency = 'USD',
}) {
  const formattedRevenue = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    maximumFractionDigits: 0,
  }).format(recoveredRevenue);

  const cards = [
    {
      title: 'Total Recovery Cases',
      value: totalCases.toLocaleString(),
      subtitle: `${recoveredCount} automated recoveries`,
      accent: 'border-indigo-500/30 text-indigo-400',
      badge: 'All Time',
      badgeColor: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2H5a2 2 0 00-2 2v2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      ),
    },
    {
      title: 'Recovered Revenue',
      value: formattedRevenue,
      subtitle: 'Successfully captured payments',
      accent: 'border-emerald-500/30 text-emerald-400',
      badge: 'Revenue Preserved',
      badgeColor: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
    {
      title: 'Pending Human Review',
      value: pendingReview.toLocaleString(),
      subtitle: pendingReview > 0 ? 'Requires merchant approval' : 'Queue clear',
      accent: pendingReview > 0 ? 'border-amber-500/50 text-amber-400' : 'border-slate-700 text-slate-400',
      badge: pendingReview > 0 ? 'Action Needed' : 'Normal',
      badgeColor: pendingReview > 0 ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 animate-pulse' : 'bg-slate-800 text-slate-400 border-slate-700',
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ),
    },
    {
      title: 'Blocked / Failed Cases',
      value: blockedOrFailed.toLocaleString(),
      subtitle: 'Guardrail gated & terminal declines',
      accent: 'border-rose-500/30 text-rose-400',
      badge: 'Protected',
      badgeColor: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
      {cards.map((card, idx) => (
        <div
          key={idx}
          className={`bg-slate-900 border rounded-2xl p-5 shadow-lg relative overflow-hidden flex flex-col justify-between ${card.accent}`}
        >
          <div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                {card.title}
              </span>
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${card.badgeColor}`}>
                {card.badge}
              </span>
            </div>
            <div className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              {card.value}
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
            <span>{card.subtitle}</span>
            <div className="text-slate-500">{card.icon}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
