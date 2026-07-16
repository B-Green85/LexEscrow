import { useRef, useState } from "react";
import { useBatch, type BatchItem, type BatchStatus } from "../store/batch";
import { useSession } from "../store/session";
import { ManualEntryForm } from "../components/ManualEntryForm";
import { formatUsd } from "../lexguard/payload-diff";

const STATUS_META: Record<BatchStatus, { icon: string; label: string; cls: string }> = {
  queued: { icon: "⏳", label: "Queued", cls: "badge badge-slate" },
  parsing: { icon: "🔄", label: "Parsing", cls: "badge badge-brand" },
  parsed: { icon: "✅", label: "Parsed", cls: "badge badge-emerald" },
  flagged: { icon: "⚠️", label: "Flagged", cls: "badge badge-amber" },
  settled: { icon: "✅", label: "Settled", cls: "badge badge-emerald" },
  failed: { icon: "❌", label: "Failed", cls: "badge badge-red" },
};

function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

function EntryModeToggle({ item }: { item: BatchItem }) {
  const setItemEntryMode = useBatch((s) => s.setItemEntryMode);
  const locked = item.status === "parsed" || item.status === "flagged" || item.status === "settled";
  if (locked) {
    return <span className="text-xs text-slate-400">{item.entryMode === "manual" ? "manual" : "AI"}</span>;
  }
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-slate-200 text-xs">
      {(["ai", "manual"] as const).map((m) => (
        <button
          key={m}
          onClick={() => setItemEntryMode(item.id, m)}
          className={`px-2 py-0.5 ${
            item.entryMode === m ? "bg-brand-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
          }`}
        >
          {m === "ai" ? "AI" : "Manual"}
        </button>
      ))}
    </div>
  );
}

function RowAction({ item, onEnter }: { item: BatchItem; onEnter: (id: string) => void }) {
  const reviewItem = useBatch((s) => s.reviewItem);

  if (item.status === "queued" && item.entryMode === "manual") {
    return (
      <button className="btn btn-secondary px-3 py-1 text-xs" onClick={() => onEnter(item.id)}>
        Enter
      </button>
    );
  }
  if (item.status === "queued" || item.status === "parsing") {
    return <span className="text-xs text-slate-400">…</span>;
  }
  if (item.status === "failed") {
    return <span className="text-xs text-red-600" title={item.error ?? ""}>error</span>;
  }
  if (item.status === "settled") {
    return (
      <span className="font-mono text-xs text-emerald-700" title={item.txHash ?? ""} data-selectable>
        {item.txHash ? shortHash(item.txHash) : "settled"}
      </span>
    );
  }
  // parsed or flagged → Review
  return (
    <button
      className={`px-3 py-1 text-xs ${item.status === "flagged" ? "btn btn-primary" : "btn btn-secondary"}`}
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

  const ready = items.filter((i) => i.status === "parsed").length;
  const flagged = items.filter((i) => i.status === "flagged").length;
  const pending = items.filter((i) => i.status === "queued" || i.status === "parsing").length;
  const settled = items.filter((i) => i.status === "settled").length;

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
    <div className="mx-auto w-full max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">Batch processing</h1>
          <p className="mt-1 text-sm text-slate-500">
            Load a folder of retainer documents. Up to 3 parse at once; LexGuard validates each.
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
        <div className="flex items-center gap-4 text-sm">
          <span className="text-emerald-700">{ready} ready</span>
          <span className="text-slate-300">|</span>
          <span className="text-amber-700">{flagged} flagged</span>
          <span className="text-slate-300">|</span>
          <span className="text-slate-500">{pending} pending</span>
          {settled > 0 && (
            <>
              <span className="text-slate-300">|</span>
              <span className="text-brand-700">{settled} settled</span>
            </>
          )}
          {running && <span className="text-xs text-slate-400">processing…</span>}
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary px-3 py-1 text-xs" disabled={!items.length} onClick={downloadCsv}>
            Export CSV
          </button>
          {items.length > 0 && (
            <button className="btn btn-secondary px-3 py-1 text-xs" onClick={() => reset()}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card mt-4 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5 font-medium">Client</th>
              <th className="px-4 py-2.5 font-medium">Attorney</th>
              <th className="px-4 py-2.5 font-medium">Total</th>
              <th className="px-4 py-2.5 font-medium">Mode</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">
                  No documents loaded. Use <span className="font-medium">Load Folder</span> or{" "}
                  <span className="font-medium">Load samples</span> to begin.
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const meta = STATUS_META[item.status];
                return (
                  <tr key={item.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-800">{item.clientName}</div>
                      <div className="text-xs text-slate-400">{item.fileName}</div>
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {item.barNumber !== "—" ? `Bar #${item.barNumber}` : "—"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-700">
                      {item.totalCents != null ? formatUsd(item.totalCents) : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <EntryModeToggle item={item} />
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={meta.cls}>
                        <span aria-hidden>{meta.icon}</span> {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <RowAction item={item} onEnter={setManualItemId} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-slate-400">
        Batch uses the same credential vault for the AI provider across all documents (falling back to the
        local parser when none is configured). No AI provider?{" "}
        <button className="underline" onClick={() => openConfig()}>
          Configure one
        </button>{" "}
        or switch a row to Manual.
      </p>

      {/* Manual entry drawer */}
      {manualItem && (
        <div className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6">
          <div className="mt-8 w-full max-w-2xl">
            <div className="mb-2 flex items-center justify-between text-white">
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
