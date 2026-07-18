import { useRef, useState } from "react";
import { useSession } from "../store/session";
import { samplesForClass, sampleToFile } from "../lib/samples";
import {
  ASSET_CLASSES,
  US_STATES,
  anchorsComplete,
  anchorsToTrustAnchors,
  descriptorFor,
  emptyAnchorsFor,
  type AssetClass,
} from "../lib/assetClasses";

// Card order for the selector (spec §4 / §12 Document Load).
const CARD_ORDER: AssetClass[] = [
  "real_estate",
  "legal",
  "business",
  "ip",
  "art",
  "natural_resources",
  "cannabis_ind",
];

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Dark-theme <select>: the native control paints its value unreliably on dark
 *  backgrounds, so its own text is transparent and an overlay span renders it. */
function DarkSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: string[];
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <select
        className="input appearance-none pr-9 text-transparent"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {placeholder !== undefined && (
          <option value="" className="bg-[#1A2435] text-[#F8FAFC]">
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o} value={o} className="bg-[#1A2435] text-[#F8FAFC]">
            {o}
          </option>
        ))}
      </select>
      <span
        className={`pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm ${
          value ? "text-[#F8FAFC]" : "text-slate-500"
        }`}
      >
        {value || placeholder || ""}
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
  );
}

export function DocumentLoad() {
  const { anchors, setAnchor, setRawAnchors, file, setFile, goToProcessing, error, busy, assetClass, setAssetClass } =
    useSession();
  const inputRef = useRef<HTMLInputElement>(null);

  // Raw per-class anchor record. Legal seeds from the store so its values
  // survive a remount exactly as before; other classes start empty. On every
  // change the record is projected onto the pipeline's TrustAnchors in the
  // store — for Legal that projection is the identity, so nothing changes.
  const [raw, setRaw] = useState<Record<string, string>>(() => {
    const empty = emptyAnchorsFor(assetClass);
    if (assetClass === "legal") {
      return {
        ...empty,
        attorneyBarNumber: anchors.attorneyBarNumber ?? "",
        state: anchors.state || empty.state,
        clientFullLegalName: anchors.clientFullLegalName ?? "",
        clientEmail: anchors.clientEmail ?? "",
        clientPhone: anchors.clientPhone ?? "",
      };
    }
    return empty;
  });

  const descriptor = descriptorFor(assetClass);

  const selectClass = (cls: AssetClass) => {
    if (cls === assetClass) return;
    const empty = emptyAnchorsFor(cls);
    setAssetClass(cls);
    setRaw(empty);
    setAnchor(anchorsToTrustAnchors(cls, empty));
    setRawAnchors(empty);
  };

  const setValue = (key: string, v: string) => {
    const next = { ...raw, [key]: v };
    setRaw(next);
    setAnchor(anchorsToTrustAnchors(assetClass, next));
    // The raw record too — TrustAnchors drops the class-specific fields that
    // CannaVerify needs (Metrc facility ID, license type).
    setRawAnchors(next);
  };

  const canContinue = !!file && anchorsComplete(assetClass, raw) && !busy;
  const samples = samplesForClass(assetClass);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-xl font-bold tracking-tight text-slate-900">Load documents</h1>
      <p className="mt-1 text-sm text-slate-500">
        Choose the asset class, provide the document and its trust anchors. Nothing is processed until
        these are in place.
      </p>

      <div className="card mt-6 p-6">
        {/* Asset class selector */}
        <label className="label">Asset class</label>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {CARD_ORDER.map((cls) => {
            const d = ASSET_CLASSES[cls];
            const active = cls === assetClass;
            return (
              <button
                key={cls}
                type="button"
                onClick={() => selectClass(cls)}
                aria-pressed={active}
                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-3 text-center transition-colors ${
                  active
                    ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500/40"
                    : "border-[#2D3A4A] bg-[#1A2435] hover:bg-[#22304A]"
                }`}
              >
                <span className="text-2xl" aria-hidden>
                  {d.icon}
                </span>
                <span
                  className={`text-[11px] font-medium leading-tight ${
                    active ? "text-white" : "text-slate-300"
                  }`}
                >
                  {d.displayName}
                </span>
              </button>
            );
          })}
        </div>

        {/* Upload */}
        <label className="label mt-6">{descriptor.uploadLabel}</label>
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-400">Or load a sample:</span>
          {samples.map((s) => (
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

        {/* Trust anchors — rendered dynamically for the selected class */}
        <div className="mt-6 grid grid-cols-2 gap-4">
          {descriptor.anchorFields.map((f) => {
            const value = raw[f.key] ?? "";
            const span = f.full ? "col-span-2" : "";
            return (
              <div key={f.key} className={span}>
                <label className="label">
                  {f.label}
                  {!f.required && <span className="font-normal text-slate-400"> (optional)</span>}
                </label>
                {f.type === "select" ? (
                  <DarkSelect value={value} options={f.options ?? []} onChange={(v) => setValue(f.key, v)} />
                ) : f.type === "state" ? (
                  <DarkSelect
                    value={value}
                    options={US_STATES}
                    placeholder="Select state"
                    onChange={(v) => setValue(f.key, v)}
                  />
                ) : (
                  <input
                    className="input"
                    type={f.type === "email" ? "email" : "text"}
                    inputMode={f.type === "money" ? "decimal" : f.key === "attorneyBarNumber" ? "numeric" : undefined}
                    placeholder={f.placeholder ?? ""}
                    value={value}
                    onChange={(e) => setValue(f.key, e.target.value)}
                  />
                )}
              </div>
            );
          })}
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <p className="max-w-xs text-xs text-slate-400">
            {assetClass === "legal"
              ? "The bar number is verified against the California State Bar before any processing begins."
              : "Trust anchors are matched against the parsed document by LexGuard before any funds move."}
          </p>
          <button className="btn btn-primary btn-lg" disabled={!canContinue} onClick={() => goToProcessing()}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
