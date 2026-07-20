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

/**
 * Short labels for the seven-across selector.
 *
 * Three canonical names ("Intellectual Property", "Art & Collectibles",
 * "Natural Resources") wrap to three lines in a 1/7-width card and drag the
 * whole row taller than the rest. These are presentation-only shortenings —
 * the canonical `displayName` in `lib/assetClasses` stays authoritative
 * everywhere the class is named in prose, so nothing downstream reads these.
 */
const SHORT_LABEL: Partial<Record<AssetClass, string>> = {
  ip: "IP",
  art: "Art",
  natural_resources: "Nat. Res.",
};

/** Cloud-with-arrow — the drop zone's affordance. */
function UploadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-8 w-8"
    >
      <path d="M12 16V7m0 0L8.5 10.5M12 7l3.5 3.5" />
      <path d="M20 16.7A4.5 4.5 0 0017.5 8.5h-1.1A7 7 0 104 15.3" />
    </svg>
  );
}

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
          <option value="" className="bg-app-input text-text-primary">
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o} value={o} className="bg-app-input text-text-primary">
            {o}
          </option>
        ))}
      </select>
      <span
        className={`pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm ${
          value ? "text-text-primary" : "text-text-muted"
        }`}
      >
        {value || placeholder || ""}
      </span>
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
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
    <div className="w-full">
      <h1 className="text-xl font-semibold text-text-primary">Load documents</h1>
      <p className="mt-1 text-sm text-text-muted">
        Choose the asset class, provide the document and its trust anchors. Nothing is processed until
        these are in place.
      </p>

      <div className="mt-6 w-full rounded-xl border border-app-border bg-app-card p-8 shadow-2xl shadow-black/40">
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
                title={d.displayName}
                className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-3 transition-all duration-150 ${
                  active
                    ? "border-brand bg-brand/10 text-text-primary shadow-[0_0_12px_rgba(30,96,145,0.3)]"
                    : "border-app-border bg-app-input text-text-muted hover:border-white/20 hover:text-text-primary"
                }`}
              >
                <span className="text-2xl leading-none" aria-hidden>
                  {d.icon}
                </span>
                <span className="text-center text-[11px] font-medium leading-tight">
                  {SHORT_LABEL[cls] ?? d.displayName}
                </span>
              </button>
            );
          })}
        </div>

        {/* Upload */}
        <label className="label mt-6">{descriptor.uploadLabel}</label>
        <div
          onClick={() => inputRef.current?.click()}
          className="group cursor-pointer rounded-xl border-2 border-dashed border-app-border bg-app-input p-8 transition-all hover:border-brand/50 hover:bg-brand/5"
        >
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.pdf,.docx,.md,text/plain"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex flex-col items-center justify-center text-center">
            <span className="text-text-muted transition-colors group-hover:text-brand-fg">
              <UploadIcon />
            </span>
            {file ? (
              <>
                <div className="mt-3 text-sm font-semibold text-text-primary">{file.name}</div>
                <div className="mt-0.5 text-xs text-text-muted">
                  {bytesLabel(file.size)} · click to replace
                </div>
              </>
            ) : (
              <>
                <div className="mt-3 text-sm text-text-muted">
                  Drag documents here or click to upload
                </div>
                <div className="mt-0.5 text-xs text-text-muted">.txt, .md, .pdf, .docx</div>
              </>
            )}
          </div>

          {/* Samples live inside the zone but must not trigger the file dialog
              the wrapper opens on click. */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="mt-4 flex flex-wrap items-center justify-center gap-2 border-t border-app-border pt-4"
          >
            <span className="text-xs text-text-muted">Or load a sample:</span>
            {samples.map((s) => (
              <button
                key={s.key}
                type="button"
                className="cursor-pointer rounded-full border border-app-border bg-app-bg px-3 py-1 text-xs text-text-muted transition-colors hover:border-brand/50 hover:text-brand-fg"
                onClick={() => setFile(sampleToFile(s))}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Trust anchors — rendered dynamically for the selected class */}
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {descriptor.anchorFields.map((f) => {
            const value = raw[f.key] ?? "";
            const span = f.full ? "md:col-span-2" : "";
            return (
              <div key={f.key} className={span}>
                <label className="label">
                  {f.label}
                  {!f.required && <span className="font-normal text-text-muted"> (optional)</span>}
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

        <div className="mt-6 flex items-center justify-between gap-6 border-t border-app-border pt-6">
          <p className="max-w-sm text-xs text-text-muted">
            {assetClass === "legal"
              ? "The bar number is verified against the California State Bar before any processing begins."
              : "Trust anchors are matched against the parsed document by LexGuard before any funds move."}
          </p>
          <button
            className="btn btn-primary shrink-0 px-8"
            disabled={!canContinue}
            onClick={() => goToProcessing()}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
