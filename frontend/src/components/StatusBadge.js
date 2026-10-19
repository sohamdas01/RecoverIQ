import React from 'react';

export function PolicyBadge({ decision }) {
  const norm = (decision || '').toUpperCase();
  if (norm === 'ALLOW') {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
        ✓ ALLOW
      </span>
    );
  }
  if (norm === 'REQUIRE_APPROVAL') {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
        ⚠ REQUIRE APPROVAL
      </span>
    );
  }
  if (norm === 'BLOCK') {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
        ✕ BLOCK
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">
      {decision || 'UNKNOWN'}
    </span>
  );
}

export function StatusBadge({ status }) {
  const norm = (status || '').toLowerCase();
  let color = 'bg-slate-800 text-slate-400 border-slate-700';
  let label = status || 'Unknown';

  if (norm === 'executed' || norm === 'success') {
    color = 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30';
    label = 'Executed';
  } else if (norm === 'recovered') {
    color = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
    label = 'Recovered';
  } else if (norm === 'pending_review' || norm === 'require_approval') {
    color = 'bg-amber-500/10 text-amber-400 border-amber-500/30 animate-pulse';
    label = 'Pending Review';
  } else if (norm === 'blocked') {
    color = 'bg-rose-500/10 text-rose-400 border-rose-500/30';
    label = 'Blocked';
  } else if (norm === 'failed') {
    color = 'bg-red-500/10 text-red-400 border-red-500/30';
    label = 'Failed';
  }

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${color}`}>
      {label}
    </span>
  );
}

export function ActionBadge({ action }) {
  const norm = (action || '').toLowerCase();
  let label = action ? action.replace(/_/g, ' ') : 'N/A';
  let color = 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20';

  if (norm.includes('retry')) {
    color = 'bg-blue-500/10 text-blue-300 border-blue-500/30';
  } else if (norm.includes('recovery') || norm.includes('message') || norm.includes('link')) {
    color = 'bg-purple-500/10 text-purple-300 border-purple-500/30';
  } else if (norm.includes('escalate') || norm.includes('human')) {
    color = 'bg-orange-500/10 text-orange-300 border-orange-300/30';
  } else if (norm.includes('discount') || norm.includes('plan')) {
    color = 'bg-teal-500/10 text-teal-300 border-teal-500/30';
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono capitalize border ${color}`}>
      {label}
    </span>
  );
}
