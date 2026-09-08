import { useEffect, useRef, useState } from "react";
import { useSession } from "../store/session";
import { ClioIntakePanel } from "../components/ClioIntakePanel";
import { supportsClioIntake } from "../lib/clio";
import * as backend from "../lib/backend";
import { samplesForClass, sampleToFile } from "../lib/samples";
import {
  mergeSuggestions,
  suggestAnchors,
  suggestionsToFields,
  type AnchorSuggestions,
} from "../lib/suggest-anchors";
import {
  ASSET_CLASSES,
  ASSET_CLASS_LIST,
  EMAIL_RE,
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

/** Empty per-class map, one entry for each asset class. */
function byClass<T>(make: (cls: AssetClass) => T): Record<AssetClass, T> {
  return Object.fromEntries(ASSET_CLASS_LIST.map((c) => [c, make(c)])) as Record<AssetClass, T>;
}

export function DocumentLoad() {
  const {
    anchors,
    setAnchor,
    setRawAnchors,
    setFile,
    goToProcessing,
    error,
    busy,
    assetClass,
    setAssetClass,
    intakeSource,
    setIntakeSource,
    clioMatter,
  } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);

  // The screen holds every asset class's work in parallel, keyed by class:
  // its uploaded file, its anchor-field values, the raw suggestion extraction,
  // and the amber-dot / officer-touched bookkeeping. Switching class swaps which
  // slot is shown and pushes it to the store; it never clears the others, so
  // returning to a class restores exactly what was there with no re-extraction.
  //
  // Legal's field values seed from the store so a remount preserves them as
  // before, and the active class seeds its file slot from the store for the
  // same reason. The store always mirrors the *active* class — it is what the
  // pipeline reads on Continue.
  const seedRaw = (cls: AssetClass): Record<string, string> => {
    const empty = emptyAnchorsFor(cls);
    if (cls === "legal") {
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
  };

  const [filesByClass, setFilesByClass] = useState<Record<AssetClass, File | null>>(() =>
    byClass((c) => (c === assetClass ? useSession.getState().file : null)),
  );
  const [rawByClass, setRawByClass] = useState<Record<AssetClass, Record<string, string>>>(() =>
    byClass(seedRaw),
  );
  const [suggestionsByClass, setSuggestionsByClass] = useState<
    Record<AssetClass, AnchorSuggestions | null>
  >(() => byClass(() => null));
  // Which fields carry an amber dot (suggested, not yet confirmed) per class.
  const [suggestedByClass, setSuggestedByClass] = useState<Record<AssetClass, Set<string>>>(() =>
    byClass(() => new Set<string>()),
  );

  // Refs mirror the maps the async loader mutates, so an extraction that resolves
  // after a class switch still reads and writes the right slots without stale
  // closures. `touchedRef` is ref-only — it never needs to trigger a render.
  const filesRef = useRef(filesByClass);
  const rawRef = useRef(rawByClass);
  const touchedRef = useRef<Record<AssetClass, Set<string>>>(byClass(() => new Set<string>()));

  const descriptor = descriptorFor(assetClass);
  const raw = rawByClass[assetClass];
  const file = filesByClass[assetClass];
  const suggested = suggestedByClass[assetClass];
  // The raw extraction for this class, projected back to field keys, so an
  // amber dot can name the value it proposed rather than just flag one exists.
  const activeSuggestions = suggestionsByClass[assetClass];
  const suggestedValues = activeSuggestions ? suggestionsToFields(assetClass, activeSuggestions) : {};

  /** Point the store — what the pipeline reads on Continue — at a class's slot. */
  const syncStore = (cls: AssetClass, rawForCls: Record<string, string>, fileForCls: File | null) => {
    setAnchor(anchorsToTrustAnchors(cls, rawForCls));
    // The raw record too — TrustAnchors drops the class-specific fields that
    // CannaVerify needs (Metrc facility ID, license type).
    setRawAnchors(rawForCls);
    setFile(fileForCls);
  };

  const writeFile = (cls: AssetClass, f: File | null) => {
    filesRef.current = { ...filesRef.current, [cls]: f };
    setFilesByClass(filesRef.current);
  };
  const writeRaw = (cls: AssetClass, next: Record<string, string>) => {
    rawRef.current = { ...rawRef.current, [cls]: next };
    setRawByClass(rawRef.current);
  };

  /**
   * Pre-fill the client trust anchors from a fetched Clio matter.
   *
   * This is the whole hand-off into DocuSign and the notification flow, and it
   * deliberately changes neither. The Legal class's signer descriptor already
   * routes its envelope to `clientEmail`, and `sendClientNotification` already
   * reads `clientEmail` / `clientPhone` — so filling those three anchors is
   * enough for a Clio-sourced client to reach both, with no branch anywhere
   * downstream.
   *
   * Marked *suggested* rather than confirmed. The amber dot already means
   * "proposed by a machine, verify before relying on it", which is exactly the
   * status of a contact record pulled out of a firm's practice-management
   * system — and trust anchors are authoritative precisely because a human
   * confirmed them. A field the officer has already typed into is left alone.
   */
  useEffect(() => {
    if (!clioMatter || assetClass !== "legal") return;
    const proposed: Record<string, string> = {
      clientFullLegalName: clioMatter.clientName,
      ...(clioMatter.clientEmail && { clientEmail: clioMatter.clientEmail }),
      ...(clioMatter.clientPhone && { clientPhone: clioMatter.clientPhone }),
    };
    const filled = Object.entries(proposed).filter(
      ([key, value]) => value && !touchedRef.current.legal.has(key),
    );
    if (filled.length === 0) return;

    const next = { ...rawRef.current.legal, ...Object.fromEntries(filled) };
    writeRaw("legal", next);
    setSuggestedByClass((prev) => {
      const marked = new Set(prev.legal);
      for (const [key] of filled) marked.add(key);
      return { ...prev, legal: marked };
    });
    if (useSession.getState().assetClass === "legal") {
      syncStore("legal", next, filesRef.current.legal);
    }
    // Keyed on the matter, not the payload object: re-running on every render
    // would fight the officer's own edits back into the Clio values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clioMatter?.matterId, clioMatter?.fetchedAt]);

  const selectClass = (cls: AssetClass) => {
    if (cls === assetClass) return;
    setAssetClass(cls);
    // Reveal that class's existing slot; every other class is left untouched.
    syncStore(cls, rawRef.current[cls], filesRef.current[cls]);
  };

  const setValue = (key: string, v: string) => {
    const cls = assetClass;
    touchedRef.current[cls].add(key);
    // Typed over — it is the officer's value now, so drop the suggestion mark.
    setSuggestedByClass((prev) => {
      if (!prev[cls].has(key)) return prev;
      const n = new Set(prev[cls]);
      n.delete(key);
      return { ...prev, [cls]: n };
    });
    const next = { ...rawRef.current[cls], [key]: v };
    writeRaw(cls, next);
    syncStore(cls, next, filesRef.current[cls]);
  };

  /**
   * Take a file for `cls` and pre-fill whatever trust anchors its text
   * confidently yields — for that class's slot only, never any other.
   *
   * Text comes from the Rust extractor rather than `File.text()`, which only
   * ever produced usable output for `.txt`/`.md` — on a PDF or DOCX it returns
   * the raw binary, from which nothing matches. The bytes are sent rather than a
   * path because a browser `File` exposes no filesystem path, the same reason
   * `loadArtifact` is byte-oriented.
   *
   * Suggestions are advisory — LexGuard still matches the confirmed anchors
   * against the parsed document — so extraction failing for any reason leaves
   * the form exactly as it was and never surfaces an error. The store is only
   * touched while `cls` is still the class on screen, so a slow extraction the
   * officer has already navigated away from cannot overwrite the active class.
   */
  const loadFile = async (f: File | null, cls: AssetClass) => {
    writeFile(cls, f);
    if (useSession.getState().assetClass === cls) setFile(f);
    if (!f) return;

    let text: string;
    try {
      text = await backend.extractDocumentText(f.name, new Uint8Array(await f.arrayBuffer()));
    } catch {
      return;
    }
    if (!text.trim()) return;

    const suggestions = suggestAnchors(text, cls);
    setSuggestionsByClass((prev) => ({ ...prev, [cls]: suggestions }));

    const { next, filled } = mergeSuggestions(
      cls,
      rawRef.current[cls],
      emptyAnchorsFor(cls),
      suggestions,
      touchedRef.current[cls],
    );
    if (filled.length === 0) return;
    writeRaw(cls, next);
    setSuggestedByClass((prev) => ({ ...prev, [cls]: new Set(filled) }));
    if (useSession.getState().assetClass === cls) syncStore(cls, next, f);
  };

  // Clio intake is only offered on the Legal class — Clio is practice-management
  // software for law firms, so a matter is a legal engagement by construction.
  // Selecting another class falls back to the Artifact Loader rather than
  // leaving a toggle on screen that cannot be honoured.
  const clioAvailable = supportsClioIntake(assetClass);
  const fromClio = clioAvailable && intakeSource === "clio";
  const haveInput = fromClio ? !!clioMatter : !!file;
  const canContinue = haveInput && anchorsComplete(assetClass, raw) && !busy;
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
                className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-xl p-3 transition-all duration-200 ${
                  active
                    ? "border-2 border-[#3B82F6] bg-[#16233B] text-white shadow-[0_0_15px_rgba(59,130,246,0.45),inset_0_0_8px_rgba(59,130,246,0.15)]"
                    : "border border-white/[0.3] bg-white/[0.27] text-gray-400 hover:border-white/[0.4] hover:bg-white/[0.32] hover:text-white"
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

        {/* Intake source. Only rendered where both paths exist — a single-option
            toggle is a control that cannot be operated. */}
        {clioAvailable && (
          <>
            <label className="label mt-6" id="intake-source-label">
              Intake source
            </label>
            <div
              role="radiogroup"
              aria-labelledby="intake-source-label"
              className="inline-flex rounded-lg border border-app-border bg-app-bg p-0.5"
            >
              {(
                [
                  ["artifact", "Upload Documents"],
                  ["clio", "Pull from Clio"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={intakeSource === value}
                  onClick={() => setIntakeSource(value)}
                  className={`cursor-pointer rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
                    intakeSource === value
                      ? "bg-app-card text-text-primary"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {fromClio ? (
          <div className="mt-6">
            <ClioIntakePanel />
          </div>
        ) : (
          <>
        {/* Upload */}
        <label className="label mt-6">{descriptor.uploadLabel}</label>
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void loadFile(e.dataTransfer.files?.[0] ?? null, assetClass);
          }}
          className="group flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/[0.15] bg-white/[0.16] p-8 backdrop-blur-md transition-all hover:border-[#3B82F6]/50"
        >
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.pdf,.docx,.md,text/plain"
            className="hidden"
            onChange={(e) => void loadFile(e.target.files?.[0] ?? null, assetClass)}
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
                onClick={() => void loadFile(sampleToFile(s), assetClass)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
          </>
        )}

        {/* Trust anchors — rendered dynamically for the selected class */}
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {descriptor.anchorFields.map((f) => {
            const value = raw[f.key] ?? "";
            const span = f.full ? "md:col-span-2" : "";
            return (
              <div key={f.key} className={span}>
                <label className="label flex items-center gap-1.5">
                  {f.label}
                  {!f.required && <span className="font-normal text-text-muted"> (optional)</span>}
                  {suggested.has(f.key) &&
                    (() => {
                      const hint = suggestedValues[f.key]
                        ? `Suggested from document: “${suggestedValues[f.key]}” — please verify`
                        : "Suggested from document — please verify";
                      return (
                        <span
                          title={hint}
                          aria-label={hint}
                          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                        />
                      );
                    })()}
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

        {/* Required signers — manual email per party, or an explicit in-app choice.
            Email delivery addresses are never inferred from the document. */}
        <div className="mt-6">
          <label className="label">Required signers</label>
          <p className="mt-0.5 text-xs text-text-muted">
            For each party, enter an email to send a DocuSign request — or mark them to sign
            in-app. A choice is required for every signer before you can continue.
          </p>
          <div className="mt-3 space-y-3">
            {descriptor.signers.map((s) => {
              const name = (raw[s.nameKey] ?? "").trim();
              const emailValue = raw[s.emailKey] ?? "";
              const inApp = (raw[s.modeKey] ?? "") === "in_app";
              const emailValid = EMAIL_RE.test(emailValue.trim());
              const statusText = inApp
                ? "Signs in-app"
                : emailValid
                  ? "Emails via DocuSign"
                  : "Choice required";
              const statusCls = inApp || emailValid ? "text-emerald-400" : "text-amber-400";
              return (
                <div
                  key={s.emailKey}
                  className="rounded-lg border border-app-border bg-app-input p-4"
                  data-testid={`signer-${s.emailKey}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 truncate">
                      <span className="text-sm font-semibold text-text-primary">{s.role}</span>
                      <span className="ml-2 text-xs text-text-muted">{name || "— enter name above —"}</span>
                    </div>
                    <span className={`shrink-0 text-xs font-medium ${statusCls}`} data-testid={`signer-status-${s.emailKey}`}>
                      {statusText}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <input
                      className="input min-w-0 flex-1"
                      type="email"
                      aria-label={`${s.role} email`}
                      placeholder={`${s.role} email address`}
                      value={emailValue}
                      disabled={inApp}
                      onChange={(e) => setValue(s.emailKey, e.target.value)}
                    />
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-text-muted">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-app-border accent-brand focus:ring-2 focus:ring-brand/40"
                        checked={inApp}
                        onChange={(e) => setValue(s.modeKey, e.target.checked ? "in_app" : "")}
                      />
                      Sign in-app (no email)
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
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
