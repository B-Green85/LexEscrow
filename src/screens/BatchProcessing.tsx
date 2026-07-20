import { useRef, useState } from "react";
import { useBatch, type BatchItem, type BatchStatus } from "../store/batch";
import { useSession } from "../store/session";
import { ManualEntryForm } from "../components/ManualEntryForm";
import { formatUsd } from "../lexguard/payload-diff";
import { ASSET_CLASSES, ASSET_CLASS_LIST } from "../lib/assetClasses";

// Full status badge set (spec §7).
const STATUS_META: Record<BatchStatus, { icon: string; label: string; cls: string }> = {
  queued: { icon: "⏳", label: "Queued", cls: "badge badge-slate" },
  parsing: { icon: "🔄", label: "Parsing", cls: "badge badge-brand" },
  ready: { icon: "✅", label: "Ready", cls: "badge badge-emerald" },
  flagged: { icon: "⚠️", label: "Flagged", cls: "badge badge-amber" },
  in_escrow: { icon: "🔒", label: "In Escrow", cls: "badge badge-brand" },
  verifying: { icon: "🔍", label: "Verifying", cls: "badge badge-brand" },
  settled: { icon: "✅", label: "Settled", cls: "badge badge-emerald" },
  failed: { icon: "❌", label: "Failed", cls: "badge badge-red" },
};

function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

/** Integer cents → whole-dollar `$1,234,567` (summary bar, spec §7). */
function usdWhole(cents: bigint): string {
  const dollars = cents / 100n;
  return `$${dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function EntryModeToggle({ item }: { item: BatchItem }) {
  const setItemEntryMode = useBatch((s) => s.setItemEntryMode);
  const locked = item.status === "ready" || item.status === "flagged" || item.status === "settled";
  if (locked) {
    return <span className="text-[11px] text-text-muted">{item.entryMode === "manual" ? "manual" : "AI"}</span>;
  }
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-app-border text-[11px]">
      {(["ai", "manual"] as const).map((m) => (
        <button
          key={m}
          onClick={() => setItemEntryMode(item.id, m)}
          className={`px-2 py-0.5 ${
            item.entryMode === m ? "bg-brand text-white" : "bg-app-input text-text-muted hover:bg-white/10"
          }`}
        >
          {m === "ai" ? "AI" : "Manual"}
        </button>
      ))}
    </div>
  );
}

/** Class column: asset-class badge (icon + abbrev). When queued, opens a
 *  dropdown to change the class. The AI/Manual toggle sits below as secondary. */
function ClassCell({ item }: { item: BatchItem }) {
  const setItemAssetClass = useBatch((s) => s.setItemAssetClass);
  const [open, setOpen] = useState(false);
  const d = ASSET_CLASSES[item.assetClass];
  const editable = item.status === "queued";

  return (
    <div className="relative w-max">
      <button
        type="button"
        disabled={!editable}
        onClick={() => editable && setOpen((o) => !o)}
        title={d.displayName}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium ${
          editable
            ? "border-app-border bg-app-input text-text-primary hover:bg-white/10"
            : "border-transparent text-text-muted"
        }`}
      >
        <span aria-hidden>{d.icon}</span>
        <span>{d.abbrev}</span>
        {editable && <span className="text-text-muted">▾</span>}
      </button>

      {open && editable && (
        <>
          <button
            aria-hidden
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute z-20 mt-1 w-48 rounded-lg border border-app-border bg-app-card p-1 shadow-lg shadow-black/40">
            {ASSET_CLASS_LIST.map((cls) => {
              const cd = ASSET_CLASSES[cls];
              return (
                <button
                  key={cls}
                  type="button"
                  onClick={() => {
                    setItemAssetClass(item.id, cls);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
                    cls === item.assetClass ? "bg-brand text-white" : "text-text-primary hover:bg-white/10"
                  }`}
                >
                  <span aria-hidden>{cd.icon}</span>
                  <span>{cd.displayName}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-1.5">
        <EntryModeToggle item={item} />
      </div>
    </div>
  );
}

/** Parties column: two primary parties from the parsed payload. Legal shows
 *  client / bar number; other classes show the extracted party, falling back to
 *  the file name when nothing has been parsed. */
function PartiesCell({ item }: { item: BatchItem }) {
  if (!item.payload) {
    return <div className="text-text-muted">{item.fileName}</div>;
  }
  if (item.assetClass === "legal") {
    return (
      <div>
        <div className="font-medium text-text-primary">{item.clientName}</div>
        <div className="text-xs text-text-muted">{item.barNumber !== "—" ? `Bar #${item.barNumber}` : "—"}</div>
      </div>
    );
  }
  const primary = item.clientName && item.clientName !== "—" ? item.clientName : item.fileName;
  const secondary = item.barNumber && item.barNumber !== "—" ? item.barNumber : "";
  return (
    <div>
      <div className="font-medium text-text-primary">{primary}</div>
      {secondary && <div className="text-xs text-text-muted">{secondary}</div>}
    </div>
  );
}

function RowAction({ item, onEnter }: { item: BatchItem; onEnter: (id: string) => void }) {
  const reviewItem = useBatch((s) => s.reviewItem);

  if (item.status === "queued" && item.entryMode === "manual") {
    return (
      <button className="btn btn-secondary btn-sm" onClick={() => onEnter(item.id)}>
        Enter
      </button>
    );
  }
  if (item.status === "queued" || item.status === "parsing") {
    return <span className="text-xs text-text-muted">…</span>;
  }
  if (item.status === "failed") {
    return (
      <span className="text-xs text-red-600" title={item.error ?? ""}>
        error
      </span>
    );
  }
  if (item.status === "settled") {
    return (
      <span className="font-mono text-xs text-emerald-700" title={item.txHash ?? ""} data-selectable>
        {item.txHash ? shortHash(item.txHash) : "settled"}
      </span>
    );
  }
  // ready or flagged → Review
  return (
    <button
      className={`btn-sm ${item.status === "flagged" ? "btn btn-primary" : "btn btn-secondary"}`}
      onClick={() => reviewItem(item.id)}
    >
      Review
    </button>
  );
}

export function BatchProcessing() {
  const { items, running, loadFiles, loadSamples, submitManualItem, exportCsv, reset } = useBatch();
  const openConfig = useSession((s) => s.openConfig);
  const folderRef = useRef<HTMLInputElement | null>(null);
  const [manualItemId, setManualItemId] = useState<string | null>(null);

  const ready = items.filter((i) => i.status === "ready").length;
  const flagged = items.filter((i) => i.status === "flagged").length;
  const pending = items.filter((i) => i.status === "queued" || i.status === "parsing").length;
  const settled = items.filter((i) => i.status === "settled").length;
  const totalEscrow = items.reduce((acc, i) => acc + (i.totalCents ?? 0n), 0n);

  const setFolderInput = (el: HTMLInputElement | null) => {
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
    folderRef.current = el;
  };

  const onFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).filter((f) => /\.(pdf|docx|txt|md)$/i.test(f.name));
    if (picked.length) loadFiles(picked);
    e.target.value = "";
  };

  const downloadCsv = () => {
    const blob = new Blob([exportCsv()], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lexescrow-batch.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const manualItem = items.find((i) => i.id === manualItemId) ?? null;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Batch processing — 360°</h1>
          <p className="mt-1 text-sm text-text-muted">
            Every active transaction across all seven asset classes. Up to 3 parse at once; LexGuard
            validates each.
          </p>
        </div>
        <div className="flex gap-2">
          <input ref={setFolderInput} type="file" multiple className="hidden" onChange={onFolder} />
          <button className="btn btn-primary" onClick={() => folderRef.current?.click()}>
            Load Folder
          </button>
          <button className="btn btn-secondary" onClick={() => loadSamples()}>
            Load samples
          </button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="card mt-5 flex items-center justify-between px-5 py-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-semibold text-text-primary">{usdWhole(totalEscrow)} in escrow</span>
          <span className="text-white/20">|</span>
          <span className="text-emerald-700">{ready} ready</span>
          <span className="text-white/20">|</span>
          <span className="text-amber-700">{flagged} flagged</span>
          <span className="text-white/20">|</span>
          <span className="text-text-muted">{pending} pending</span>
          {settled > 0 && (
            <>
              <span className="text-white/20">|</span>
              <span className="text-brand-fg">{settled} settled</span>
            </>
          )}
          {running && <span className="text-xs text-text-muted">processing…</span>}
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary btn-sm" disabled={!items.length} onClick={downloadCsv}>
            Export CSV
          </button>
          {items.length > 0 && (
            <button className="btn btn-secondary btn-sm" onClick={() => reset()}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card mt-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-app-border bg-app-input text-left text-xs uppercase tracking-wide text-text-muted">
              <th className="px-4 py-2.5 font-medium">Class</th>
              <th className="px-4 py-2.5 font-medium">Parties</th>
              <th className="px-4 py-2.5 font-medium">Documents</th>
              <th className="px-4 py-2.5 font-medium">Amount</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-text-muted">
                  No documents loaded. Use <span className="font-medium">Load Folder</span> or{" "}
                  <span className="font-medium">Load samples</span> to begin.
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const meta = STATUS_META[item.status];
                return (
                  <tr key={item.id} className="hover:bg-white/5">
                    <td className="px-4 py-2.5 align-top">
                      <ClassCell item={item} />
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <PartiesCell item={item} />
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <div className="flex items-center gap-1.5">
                        <span className="text-text-primary">{item.fileName}</span>
                        <span aria-hidden>{meta.icon}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 align-top font-mono text-text-primary">
                      {item.totalCents != null ? formatUsd(item.totalCents) : "—"}
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <span className={meta.cls}>
                        <span aria-hidden>{meta.icon}</span> {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 align-top text-right">
                      <RowAction item={item} onEnter={setManualItemId} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-text-muted">
        Batch uses the same credential vault for the AI provider across all documents (falling back to the
        local parser when none is configured). No AI provider?{" "}
        <button className="text-brand-fg underline" onClick={() => openConfig()}>
          Configure one
        </button>{" "}
        or switch a row to Manual.
      </p>

      {/* Manual entry drawer */}
      {manualItem && (
        <div className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/60 p-6">
          <div className="mt-8 w-full max-w-2xl">
            <div className="mb-2 flex items-center justify-between text-text-primary">
              <span className="text-sm font-medium">Manual entry — {manualItem.fileName}</span>
              <button className="text-sm underline" onClick={() => setManualItemId(null)}>
                Close
              </button>
            </div>
            <ManualEntryForm
              submitting={manualItem.status === "parsing"}
              onCancel={() => setManualItemId(null)}
              onSubmit={async (f) => {
                const id = manualItem.id;
                setManualItemId(null);
                await submitManualItem(id, f);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
