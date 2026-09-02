import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 font-sans">
      <div className="max-w-3xl w-full text-center space-y-8 bg-slate-900 border border-slate-800 rounded-3xl p-8 md:p-12 shadow-2xl">
        
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-indigo-600/20 border border-indigo-500/40 text-indigo-300 rounded-full text-xs font-semibold uppercase tracking-wider">
          <span>●</span> Autonomous Payment & Subscription Recovery Platform
        </div>

        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-indigo-300 to-teal-300">
          RecoverIQ
        </h1>

        <p className="text-slate-400 text-base max-w-xl mx-auto leading-relaxed">
          Detects transaction failures, diagnoses cause per case, decides bounded interventions, gates them through safety guardrails, and executes self-service customer recovery.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg mx-auto pt-4">
          <Link
            href="/simulate"
            className="p-4 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white rounded-xl font-bold shadow-lg shadow-indigo-500/20 transition flex flex-col items-center justify-center gap-1"
          >
            <span className="text-base">⚡ Simulate Purchase</span>
            <span className="text-xs text-indigo-100 font-normal">Trigger failure events & view loop</span>
          </Link>

          <Link
            href="/dashboard"
            className="p-4 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl font-bold transition flex flex-col items-center justify-center gap-1"
          >
            <span className="text-base">📊 Merchant Dashboard</span>
            <span className="text-xs text-slate-400 font-normal">Live feed & Human Review Queue</span>
          </Link>
        </div>

        <div className="pt-6 border-t border-slate-800/80 grid grid-cols-3 gap-2 text-xs text-slate-500 font-mono">
          <div>Phase 1 Core Loop</div>
          <div>Guardrail Gating</div>
          <div>Closed Customer Loop</div>
        </div>

      </div>
    </div>
  );
}
