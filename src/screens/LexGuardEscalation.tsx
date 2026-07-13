import { useSession } from "../store/session";

export function LexGuardEscalation() {
  const { escalation, resolveEscalation, busy } = useSession();
  if (!escalation) return null;

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="card overflow-hidden border-amber-200">
        <div className="flex items-center gap-3 border-b border-amber-100 bg-amber-50 px-6 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 text-amber-600">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path
                fillRule="evenodd"
                d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.345 0-2.188-1.458-1.515-2.625L8.485 2.495zM10 6a1 1 0 00-1 1v3a1 1 0 102 0V7a1 1 0 00-1-1zm0 8a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div>
            <div className="text-sm font-bold text-amber-900">LexGuard escalation</div>
            <div className="text-xs text-amber-700">
              LexGuard observed a discrepancy that AI did not correct.
            </div>
          </div>
        </div>

        <div className="px-6 py-5">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Field</div>
            <div className="text-base font-semibold text-slate-900">{escalation.fieldLabel}</div>

            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-slate-400">AI extracted</div>
                <div className="mt-0.5 font-mono text-sm font-medium text-slate-800" data-selectable>
                  {escalation.aiValue}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-400">LexGuard observed</div>
                <div className="mt-0.5 font-mono text-sm font-medium text-slate-800" data-selectable>
                  {escalation.observedValue}
                </div>
              </div>
            </div>
          </div>

          <p className="mt-4 text-sm text-slate-600">
            <span className="font-semibold text-slate-700">Recommendation:</span>{" "}
            {escalation.recommendation}
          </p>

          <div className="mt-6 grid gap-2">
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => resolveEscalation("lexguard")}
            >
              Proceed with LexGuard value
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => resolveEscalation("ai")}
              >
                Proceed with AI value
              </button>
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => resolveEscalation("review")}
              >
                Review documents
              </button>
            </div>
          </div>

          <p className="mt-4 text-center text-xs text-slate-400">
            All choices are logged with timestamp and user identity.
          </p>
        </div>
      </div>
    </div>
  );
}
