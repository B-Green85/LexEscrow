import { useRef } from "react";
import { useSession } from "../store/session";
import { SAMPLES, sampleToFile } from "../lib/samples";

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentLoad() {
  const { anchors, setAnchor, file, setFile, goToProcessing, error, busy } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);

  const emailValid = /^\S+@\S+\.\S+$/.test(anchors.clientEmail.trim());
  const canContinue =
    !!file &&
    anchors.attorneyBarNumber.trim().length > 0 &&
    anchors.clientFullLegalName.trim().length > 0 &&
    emailValid &&
    !busy;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-xl font-bold tracking-tight text-slate-900">Load retainer documents</h1>
      <p className="mt-1 text-sm text-slate-500">
        Provide the termination document and the trust anchors. Nothing is processed until these are
        in place.
      </p>

      <div className="card mt-6 p-6">
        {/* Upload */}
        <label className="label">Retainer termination document</label>
        <div
          onClick={() => inputRef.current?.click()}
          className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/40"
        >
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.pdf,.docx,.md,text/plain"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div>
              <div className="text-sm font-semibold text-slate-800">{file.name}</div>
              <div className="mt-0.5 text-xs text-slate-500">{bytesLabel(file.size)} · click to replace</div>
            </div>
          ) : (
            <div>
              <div className="text-sm font-medium text-slate-600">Click to select a document</div>
              <div className="mt-0.5 text-xs text-slate-400">.txt, .md, .pdf, .docx</div>
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-slate-400">Or load a sample:</span>
          {SAMPLES.map((s) => (
            <button
              key={s.key}
              type="button"
              className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
              onClick={() => setFile(sampleToFile(s))}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Trust anchors */}
        <div className="mt-6 grid grid-cols-2 gap-4">
          <div>
            <label className="label">Attorney bar number</label>
            <input
              className="input"
              inputMode="numeric"
              placeholder="123456"
              value={anchors.attorneyBarNumber}
              onChange={(e) => setAnchor({ attorneyBarNumber: e.target.value })}
            />
          </div>
          <div>
            <label className="label">State</label>
            {/* The native <select> paints its selected value unreliably on dark
                backgrounds, so its own text is transparent and the value is
                shown by the overlay span below (always renders). */}
            <div className="relative">
              <select
                className="input appearance-none pr-9 text-transparent"
                value={anchors.state}
                onChange={(e) => setAnchor({ state: e.target.value })}
              >
                <option value="California" className="bg-[#1A2435] text-[#F8FAFC]">
                  California
                </option>
              </select>
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#F8FAFC]">
                {anchors.state}
              </span>
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              >
                <path
                  fillRule="evenodd"
                  d="M5.3 7.3a1 1 0 011.4 0L10 10.6l3.3-3.3a1 1 0 111.4 1.4l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 010-1.4z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>
          <div className="col-span-2">
            <label className="label">Client full legal name</label>
            <input
              className="input"
              placeholder="Jane Anderson"
              value={anchors.clientFullLegalName}
              onChange={(e) => setAnchor({ clientFullLegalName: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Client email</label>
            <input
              className="input"
              type="email"
              placeholder="client@example.com"
              value={anchors.clientEmail}
              onChange={(e) => setAnchor({ clientEmail: e.target.value })}
            />
          </div>
          <div>
            <label className="label">
              Client phone <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              className="input"
              placeholder="+1 555 010 0000"
              value={anchors.clientPhone ?? ""}
              onChange={(e) => setAnchor({ clientPhone: e.target.value })}
            />
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <p className="max-w-xs text-xs text-slate-400">
            The bar number is verified against the California State Bar before any processing begins.
          </p>
          <button className="btn btn-primary btn-lg" disabled={!canContinue} onClick={() => goToProcessing()}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
