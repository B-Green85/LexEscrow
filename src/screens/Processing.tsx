import { useSession, type ProcessingStep } from "../store/session";
import { ManualEntryForm } from "../components/ManualEntryForm";

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin text-brand-600" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  );
}

function StepIcon({ status }: { status: ProcessingStep["status"] }) {
  if (status === "active") return <Spinner />;
  if (status === "done")
    return (
      <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
          <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
        </svg>
      </div>
    );
  if (status === "error")
    return (
      <div className="flex h-5 w-5 items-center justify-center rounded-full bg-red-100 text-red-600">
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.7 7.3a1 1 0 00-1.4 1.4L8.6 10l-1.3 1.3a1 1 0 101.4 1.4L10 11.4l1.3 1.3a1 1 0 001.4-1.4L11.4 10l1.3-1.3a1 1 0 00-1.4-1.4L10 8.6 8.7 7.3z" clipRule="evenodd" />
        </svg>
      </div>
    );
  return <div className="h-5 w-5 rounded-full border-2 border-slate-200" />;
}

function ModeOption({
  selected,
  onSelect,
  title,
  desc,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
        selected ? "border-brand-500 bg-brand-50/50 ring-1 ring-brand-500" : "border-slate-200 hover:bg-slate-50"
      }`}
    >
      <span
        className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 ${
          selected ? "border-brand-600" : "border-slate-300"
        }`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-brand-600" />}
      </span>
      <span>
        <span className="block text-sm font-semibold text-slate-800">{title}</span>
        <span className="block text-xs text-slate-500">{desc}</span>
      </span>
    </button>
  );
}

export function Processing() {
  const {
    procPhase,
    entryMode,
    setEntryMode,
    beginProcessing,
    submitManualEntry,
    steps,
    error,
    configHint,
    busy,
    reset,
    openConfig,
  } = useSession();

  // Phase 1 — choose entry mode before parsing begins.
  if (procPhase === "choose") {
    return (
      <div className="mx-auto w-full max-w-lg">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">How should this document be parsed?</h1>
        <p className="mt-1 text-sm text-slate-500">
          Either way, LexGuard validates the result against the document before you can proceed.
        </p>
        <div className="card mt-6 space-y-3 p-5">
          <ModeOption
            selected={entryMode === "ai"}
            onSelect={() => setEntryMode("ai")}
            title="AI Parse (recommended)"
            desc="Extract the retainer fields with the configured AI provider."
          />
          <ModeOption
            selected={entryMode === "manual"}
            onSelect={() => setEntryMode("manual")}
            title="Manual Entry"
            desc="Type the fields yourself. LexGuard validates them the same way."
          />
          <div className="flex justify-end pt-1">
            <button className="btn btn-primary btn-lg" disabled={busy} onClick={() => beginProcessing()}>
              Start
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Phase 3 — manual entry form (after hashing + attorney verification).
  if (procPhase === "manual") {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">Manual entry</h1>
        <p className="mt-1 text-sm text-slate-500">
          Document hashed and attorney verified. Enter the retainer fields below.
        </p>
        <div className="mt-6">
          <ManualEntryForm submitting={busy} onSubmit={(f) => submitManualEntry(f)} onCancel={() => reset()} />
        </div>
      </div>
    );
  }

  // Phase 2 — running progress.
  return (
    <div className="mx-auto w-full max-w-lg">
      <h1 className="text-xl font-bold tracking-tight text-slate-900">Processing</h1>
      <p className="mt-1 text-sm text-slate-500">
        LexEscrow is hashing the artifact, verifying the attorney, and validating the{" "}
        {entryMode === "manual" ? "entered" : "extracted"} payload.
      </p>

      <div className="card mt-6 divide-y divide-slate-100">
        {steps.map((step) => (
          <div key={step.key} className="flex items-center gap-3 px-5 py-4">
            <StepIcon status={step.status} />
            <span
              className={`text-sm font-medium ${
                step.status === "done"
                  ? "text-slate-700"
                  : step.status === "active"
                    ? "text-slate-900"
                    : step.status === "error"
                      ? "text-red-700"
                      : "text-slate-400"
              }`}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="text-sm font-semibold text-red-800">Processing halted</div>
          <div className="mt-1 text-sm text-red-700">{error}</div>
          <div className="mt-3 flex gap-2">
            {configHint && (
              <button className="btn btn-primary" onClick={() => openConfig()}>
                {configHint === "locked" ? "Unlock vault" : "Open Configuration"}
              </button>
            )}
            <button className="btn btn-secondary" onClick={() => reset()}>
              Back to document load
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
