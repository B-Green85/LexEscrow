/**
 * Batch processing store (Zustand).
 *
 * Loads a folder of retainer documents and runs them through the same
 * ArtifactGuard → parse → LexGuard pipeline as the single-document flow, but
 * concurrently (max 3 simultaneous AI parses) so a clerk can triage: clean
 * results are marked Parsed, discrepancies Flagged. Each item is its own SQLite
 * session; every audit entry carries the shared batch_id. LexGuard runs on every
 * payload regardless of entry mode.
 */

import { create } from "zustand";
import * as backend from "../lib/backend";
import { resolveProviderForBatch } from "../lib/ai/providers";
import { schemaFor } from "../lib/ai/assetSchemas";
import { type AssetClass } from "../lib/assetClasses";
import { runLexGuardPipeline, type LexGuardCorrection, type Escalation } from "../lexguard/pipeline";
import { type ParsedRetainerPayload, type TrustAnchors } from "../lexguard/types";
import { primeVDB, type VDBStore } from "../lexguard/vdb";
import { formatUsd, toCents, toPayloadCents } from "../lexguard/payload-diff";
import { useSession, DEMO_MODE, type EntryMode, type ManualEntryFields } from "./session";
import { oneSamplePerClass, sampleToFile } from "../lib/samples";
import { issueReceipt, type AnchorReceipt } from "../lib/anchor-receipt";

export type BatchStatus =
  | "queued"
  | "parsing"
  | "ready"
  | "flagged"
  | "in_escrow"
  | "verifying"
  | "settled"
  | "failed";

export interface BatchItem {
  id: string;
  fileName: string;
  file: File;
  assetClass: AssetClass;
  entryMode: EntryMode;
  status: BatchStatus;
  sessionId: string | null;
  artifact: backend.LoadedArtifact | null;
  /** This item's own portable receipt (spec §8), issued when it was hashed. */
  anchorReceipt: AnchorReceipt | null;
  vdb: VDBStore | null;
  payload: ParsedRetainerPayload | null;
  corrections: LexGuardCorrection[];
  escalation: Escalation | null;
  clientName: string;
  barNumber: string;
  totalCents: bigint | null;
  providerLabel: string;
  txHash: string | null;
  error: string | null;
}

// A demo batch is a live audience watching seven documents parse at once, so
// the concurrency cap is raised: the point of the batch screen is that the rows
// move together. Outside demo mode it stays at 3, which is what the AI
// providers tolerate without rate-limiting.
const MAX_CONCURRENCY = DEMO_MODE ? 7 : 3;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function newId(prefix: string): string {
  const rand = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${performance.now()}`;
  return `${prefix}-${rand}`;
}

// Folder-name → asset class detection for Load Folder (spec §7). Matches the
// sub-folder a file was loaded from (case-insensitive); defaults to 'legal'.
const FOLDER_CLASS: Array<[RegExp, AssetClass]> = [
  [/^cannabis$/, "cannabis_ind"],
  [/^real[_ ]?estate$/, "real_estate"],
  [/^(business|biz)$/, "business"],
  [/^(ip|intellectual[_ ]?property)$/, "ip"],
  [/^(art|collectibles)$/, "art"],
  [/^(natural[_ ]?resources|resources|water|mineral)$/, "natural_resources"],
  [/^(legal|retainer)$/, "legal"],
];

/** Detect an item's asset class from the sub-folder it was loaded from
 *  (any directory segment of its webkitRelativePath). Defaults to 'legal'. */
function folderClassOf(file: File): AssetClass {
  const rel = (file as { webkitRelativePath?: string }).webkitRelativePath;
  const segs = (rel && rel.length ? rel : file.name).split("/");
  for (const seg of segs.slice(0, -1)) {
    const dir = seg.trim().toLowerCase();
    for (const [re, cls] of FOLDER_CLASS) if (re.test(dir)) return cls;
  }
  return "legal";
}

/** Run `worker` over `items` with at most `limit` running concurrently. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runner = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
}

function newItem(file: File, assetClass: AssetClass = "legal"): BatchItem {
  return {
    id: newId("bi"),
    fileName: file.name,
    file,
    assetClass,
    entryMode: "ai",
    status: "queued",
    sessionId: null,
    artifact: null,
    anchorReceipt: null,
    vdb: null,
    payload: null,
    corrections: [],
    escalation: null,
    clientName: "—",
    barNumber: "—",
    totalCents: null,
    providerLabel: "",
    txHash: null,
    error: null,
  };
}

/** Self-anchors for a batch item — no human enters trust anchors per document,
 *  so the extracted values are used, making anchor matching consistent while
 *  arithmetic / anomaly / scope / VDB cross-reference still validate meaningfully. */
function anchorsFor(item: BatchItem): TrustAnchors {
  return {
    attorneyBarNumber: item.barNumber === "—" ? "" : item.barNumber,
    state: "California",
    clientFullLegalName: item.clientName === "—" ? "" : item.clientName,
    clientEmail: "",
  };
}

interface BatchState {
  batchId: string | null;
  items: BatchItem[];
  running: boolean;

  loadFiles: (files: File[]) => void;
  loadSamples: () => void;
  setItemEntryMode: (id: string, mode: EntryMode) => void;
  setItemAssetClass: (id: string, cls: AssetClass) => void;
  startProcessing: () => Promise<void>;
  submitManualItem: (id: string, fields: ManualEntryFields) => Promise<void>;
  reviewItem: (id: string) => void;
  markSettled: (id: string, txHash: string) => void;
  exportCsv: () => string;
  reset: () => void;
}

export const useBatch = create<BatchState>((set, get) => {
  const operator = () => useSession.getState().operator;

  const update = (id: string, patch: Partial<BatchItem>) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));

  const log = async (sessionId: string, event: string, payload: Record<string, unknown>) => {
    const item = get().items.find((i) => i.sessionId === sessionId);
    const asset_class = item?.assetClass ?? "legal";
    try {
      await backend.logEvent(
        sessionId,
        event,
        operator(),
        JSON.stringify({ batch_id: get().batchId, asset_class, ...payload }),
      );
    } catch (e) {
      console.error("batch audit log failed", event, e);
    }
  };

  // Hash + register the artifact and prime the VDB for one item (idempotent).
  const ensureHashed = async (id: string): Promise<BatchItem | null> => {
    const item = get().items.find((i) => i.id === id);
    if (!item) return null;
    if (item.artifact && item.vdb && item.sessionId) return item;

    const bytes = new Uint8Array(await item.file.arrayBuffer());
    const artifact = await backend.loadArtifact(item.fileName, bytes);
    const sessionId = newId("wf");
    await backend.createSession({
      sessionId,
      clientId: "pending",
      attorneyBarNumber: "",
      documentHash: artifact.hash,
      assetClass: item.assetClass,
      batchId: get().batchId ?? undefined,
    });
    // Attach sessionId before logging so audit entries resolve the asset_class.
    update(id, { sessionId });
    await log(sessionId, "batch_item_loaded", { file: artifact.filename, hash: artifact.hash, size: artifact.size });

    // AnchorReceipt per item (spec §8) — every document the batch touches gets
    // its own provenance claim, not one shared receipt for the folder. The
    // items settle independently and are handed to different counterparties,
    // so a receipt covering the whole batch would over-attest for each of them.
    //
    // As in the single-document flow, a failed registration does not fail the
    // item: the parse pipeline's guarantees are independent of the receipt.
    let anchorReceipt: AnchorReceipt | null = null;
    try {
      anchorReceipt = await issueReceipt({
        sessionId,
        assetClass: item.assetClass,
        items: [{ label: artifact.filename, hash: artifact.hash, size: artifact.size }],
      });
      await log(sessionId, "anchor_receipt_issued", {
        receipt_id: anchorReceipt.receiptId,
        on_chain_tx: anchorReceipt.items[0]?.onChainTx ?? null,
        hmac: anchorReceipt.items[0]?.hmac ?? null,
        receipt_hash: anchorReceipt.receiptHash,
        overall_status: anchorReceipt.summary.overallStatus,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await log(sessionId, "anchor_receipt_failed", { error: message });
    }

    const vdb = await primeVDB(artifact.normalizedText, artifact.hash, sessionId);
    update(id, { artifact, vdb, anchorReceipt });
    return { ...item, artifact, vdb, sessionId, anchorReceipt };
  };

  // Persist + finalize an item's status from a LexGuard result.
  const finalize = async (
    id: string,
    sessionId: string,
    result: { payload: ParsedRetainerPayload; corrections: LexGuardCorrection[]; escalation: Escalation | null },
    providerLabel: string,
  ) => {
    const current = get().items.find((i) => i.id === id);
    const assetClass = current?.assetClass ?? "legal";
    const entryMode = current?.entryMode ?? "ai";
    const cents = toPayloadCents(result.payload);
    await backend.savePayload({
      payloadId: newId("pl"),
      sessionId,
      totalHeldCents: Number(cents.totalHeldCents),
      earnedFeesCents: Number(cents.earnedFeesCents),
      unearnedBalanceCents: Number(cents.unearnedBalanceCents),
      disputedHours: cents.disputedHours,
      disputedAmountCents: Number(cents.disputedAmountCents),
      assetClass,
      entryMode,
    });
    for (const c of result.corrections) {
      await log(sessionId, "LEXGUARD_CORRECTION", {
        module: c.module,
        field: c.field,
        aiValue: c.aiValue,
        observedValue: c.observedValue,
        nudgeCount: c.nudgeCount,
        resolved: c.resolved,
      });
    }
    await backend.updateSessionState(sessionId, result.escalation ? "ESCALATED" : "PARSING");
    update(id, {
      payload: result.payload,
      corrections: result.corrections,
      escalation: result.escalation,
      clientName: result.payload.clientName || "—",
      barNumber: result.payload.extractedBarNumber || "—",
      totalCents: toCents(result.payload.totalHeld),
      providerLabel,
      status: result.escalation ? "flagged" : "ready",
    });
  };

  // Full AI pipeline for one item: hash → parse → LexGuard.
  const processItem = async (id: string) => {
    update(id, { status: "parsing" });
    try {
      const item = await ensureHashed(id);
      if (!item || !item.artifact || !item.vdb || !item.sessionId) throw new Error("hashing failed");

      const provider = await resolveProviderForBatch();
      const parsed = await provider.parse(item.artifact.normalizedText, schemaFor(item.assetClass));
      const payload: ParsedRetainerPayload = {
        ...parsed,
        barNumber: parsed.extractedBarNumber ?? "",
        clientName: parsed.clientName,
      };
      // Reflect extracted identity for anchors before running LexGuard.
      update(id, {
        clientName: parsed.clientName || "—",
        barNumber: parsed.extractedBarNumber || "—",
        totalCents: toCents(parsed.totalHeld),
      });
      await log(item.sessionId, "parse", { entry_mode: "ai", provider: provider.label });
      const anchors = anchorsFor(get().items.find((i) => i.id === id)!);
      const result = await runLexGuardPipeline({
        payload,
        vdb: item.vdb,
        anchors,
        chainlinkVerifiedBar: anchors.attorneyBarNumber,
        provider,
      });
      await finalize(id, item.sessionId, result, provider.label);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      update(id, { status: "failed", error: message });
    }
  };

  return {
    batchId: null,
    items: [],
    running: false,

    loadFiles: (files) => {
      // Auto-assign each item's asset class from the sub-folder it came from.
      const additions = files.map((f) => newItem(f, folderClassOf(f)));
      set((s) => ({ batchId: s.batchId ?? newId("batch"), items: [...s.items, ...additions] }));
      void get().startProcessing();
    },

    loadSamples: () => {
      // One representative sample per asset class (7 total), each tagged.
      const additions = oneSamplePerClass().map((s) => newItem(sampleToFile(s), s.assetClass));
      set((s) => ({ batchId: s.batchId ?? newId("batch"), items: [...s.items, ...additions] }));
      void get().startProcessing();
    },

    setItemEntryMode: (id, mode) => {
      const item = get().items.find((i) => i.id === id);
      // Only meaningful before the item has been parsed/settled.
      if (!item || item.status === "settled") return;
      update(id, { entryMode: mode, status: "queued", error: null });
      if (mode === "ai") void get().startProcessing();
    },

    setItemAssetClass: (id, cls) => {
      const item = get().items.find((i) => i.id === id);
      // Asset class is only editable while the item is still queued.
      if (!item || item.status !== "queued") return;
      update(id, { assetClass: cls });
    },

    startProcessing: async () => {
      if (get().running) return;
      set({ running: true });
      try {
        const queued = get()
          .items.filter((i) => i.status === "queued" && i.entryMode === "ai")
          .map((i) => i.id);
        await runPool(queued, MAX_CONCURRENCY, processItem);
      } finally {
        set({ running: false });
      }
    },

    submitManualItem: async (id, f) => {
      update(id, { status: "parsing", error: null });
      try {
        const item = await ensureHashed(id);
        if (!item || !item.vdb || !item.sessionId) throw new Error("hashing failed");
        const payload: ParsedRetainerPayload = {
          clientId: f.clientId || "C-UNKNOWN",
          lawFirmWallet: f.lawFirmWallet || ZERO_ADDR,
          clientWallet: f.clientWallet || ZERO_ADDR,
          totalHeld: f.totalHeld,
          earnedFees: f.earnedFees,
          unearnedBalance: f.unearnedBalance,
          disputedHours: f.disputedHours,
          disputedAmount: f.disputedAmount,
          signaturesVerified: f.signaturesVerified,
          recommendedPath: f.recommendedPath,
          anomaliesFlagged: f.anomaliesFlagged,
          anomaliesSuppressed: false,
          barNumber: "",
          clientName: f.clientId,
          extractedBarNumber: null,
        };
        update(id, { clientName: f.clientId || "—", totalCents: toCents(f.totalHeld) });
        await log(item.sessionId, "parse", { entry_mode: "manual", provider: "manual" });
        const manualProvider = { label: "Manual entry", parse: async () => payload, correct: async () => null };
        const anchors = anchorsFor(get().items.find((i) => i.id === id)!);
        const result = await runLexGuardPipeline({
          payload,
          vdb: item.vdb,
          anchors,
          chainlinkVerifiedBar: anchors.attorneyBarNumber,
          provider: manualProvider,
        });
        await finalize(id, item.sessionId, result, "Manual entry");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        update(id, { status: "failed", error: message });
      }
    },

    reviewItem: (id) => {
      const item = get().items.find((i) => i.id === id);
      if (!item || !item.artifact || !item.vdb || !item.payload || !item.sessionId) return;
      useSession.getState().loadBatchItem({
        itemId: item.id,
        sessionId: item.sessionId,
        file: item.file,
        artifact: item.artifact,
        vdb: item.vdb,
        payload: item.payload,
        corrections: item.corrections,
        escalation: item.escalation,
        anchors: anchorsFor(item),
        providerLabel: item.providerLabel || "Batch",
        anchorReceipt: item.anchorReceipt,
      });
    },

    markSettled: (id, txHash) => update(id, { status: "settled", txHash }),

    exportCsv: () => {
      const header = ["Client", "Attorney Bar", "Total USD", "Status", "Session", "Tx Hash"];
      const rows = get().items.map((i) => [
        i.clientName,
        i.barNumber,
        i.totalCents != null ? formatUsd(i.totalCents) : "-",
        i.status,
        i.sessionId ?? "-",
        i.txHash ?? "-",
      ]);
      const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      return [header, ...rows].map((r) => r.map((c) => escape(String(c))).join(",")).join("\n");
    },

    reset: () => set({ batchId: null, items: [], running: false }),
  };
});
