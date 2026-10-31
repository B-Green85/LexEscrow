// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Audit report export (spec §14 V1 — "Audit report PDF export with embedded QR
 * linking to on-chain records").
 *
 * Renders a session's hash-chained audit trail to a *real* PDF (jsPDF +
 * jspdf-autotable) and saves it through the native save dialog under Tauri.
 * The earlier print-to-PDF route (`window.open` + `window.print()`) is gone
 * deliberately: WKWebView's print pipeline is unreliable in the packaged app
 * and could silently produce nothing, which is the one failure mode an audit
 * export must not have.
 *
 * The report is generated, not archived. That is the correct posture here: the
 * authoritative record is the hash-chained trail in SQLite, and this report is
 * an *extract* of it. Anyone can recompute the entry hashes from the recorded
 * values, which is exactly what the footer tells them to do.
 *
 * The HTML renderer below is retained for `exportAuditReportHtml`, the
 * headless/kiosk fallback artifact — it is a plain blob download and never
 * touches the print pipeline either.
 */

import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import * as backend from "../backend";
import { isRealTxHash, txUrl } from "../explorer";
import type { SessionState } from "../../store/session";

/** Minimal structural view of the session store — keeps this module testable. */
export interface SessionStoreLike {
  getState(): SessionState;
}

export interface AuditReportData {
  sessionId: string;
  assetClass: string;
  generatedAt: string;
  operator: string;
  parties: Record<string, string>;
  documentHash: string;
  anchorReceiptId?: string;
  anchorReceiptHash?: string;
  onChainTx?: string;
  executionPath: string;
  settlementTxHash?: string;
  auditTrail: Array<{
    logId: number;
    eventType: string;
    userIdentity: string;
    payloadJson: string;
    blockTimestamp: string;
    entryHash: string;
  }>;
  chainVerification: {
    valid: boolean;
    checkedEntries: number;
    firstBrokenAt?: number;
  };
}

// Resolved against the vault's configured chain — an exported audit report
// outlives the session that produced it, so a link to the wrong network's
// explorer would read as evidence the settlement never happened.
const explorerTx = (hash: string) => txUrl(hash);

// Only a real 32-byte tx hash gets an explorer link; stand-ins (`0xanchor-…`,
// `0xarb-…`, `0xstaged-…`) render as plain text — a link to "transaction not
// found" reads as evidence the transaction never happened.
const txHtml = (hash: string) =>
  isRealTxHash(hash)
    ? `<a class="mono" href="${escapeHtml(explorerTx(hash))}">${escapeHtml(hash)}</a>`
    : `<span class="mono">${escapeHtml(hash)}</span>`;
const txText = (hash: string) => (isRealTxHash(hash) ? `${hash}\n${explorerTx(hash)}` : hash);

// ── Data assembly ────────────────────────────────────────────────────────────

/**
 * Party roster for the report.
 *
 * `rawAnchors` is the per-class record exactly as the officer typed it on
 * Document Load, so it is the right source for every asset class. The
 * single-document legal flow populates the legal-shaped `TrustAnchors` instead,
 * so that is the fallback — otherwise the parties table would render empty on
 * the one workflow most likely to be exported.
 */
function partiesFrom(state: SessionState): Record<string, string> {
  const raw = Object.entries(state.rawAnchors).filter(([, v]) => v && v.trim().length > 0);
  if (raw.length > 0) return Object.fromEntries(raw);

  const { anchors } = state;
  return Object.fromEntries(
    Object.entries({
      clientFullLegalName: anchors.clientFullLegalName,
      clientEmail: anchors.clientEmail,
      clientPhone: anchors.clientPhone ?? "",
      attorneyBarNumber: anchors.attorneyBarNumber,
      state: anchors.state,
    }).filter(([, v]) => typeof v === "string" && v.trim().length > 0),
  );
}

/**
 * Assemble everything the report needs from the store and the backend.
 *
 * The chain verification is fetched rather than assumed: a report that asserts
 * "chain intact" without having checked would be the single most misleading
 * thing this module could produce.
 */
export async function buildAuditReportData(
  sessionId: string,
  store: SessionStoreLike,
): Promise<AuditReportData> {
  const state = store.getState();
  const [auditTrail, chain] = await Promise.all([
    backend.getAuditTrail(sessionId),
    backend.verifyAuditChain(),
  ]);

  return {
    sessionId,
    assetClass: state.assetClass,
    generatedAt: new Date().toISOString(),
    operator: state.operator,
    parties: partiesFrom(state),
    documentHash: state.artifact?.hash ?? "—",
    ...(state.anchorReceipt && {
      anchorReceiptId: state.anchorReceipt.receiptId,
      anchorReceiptHash: state.anchorReceipt.receiptHash,
    }),
    ...(state.anchorReceipt?.items[0]?.onChainTx && {
      onChainTx: state.anchorReceipt.items[0].onChainTx,
    }),
    executionPath: state.execution.path ?? state.payload?.recommendedPath ?? "—",
    ...(state.execution.txHash && { settlementTxHash: state.execution.txHash }),
    auditTrail: auditTrail.map((e) => ({
      logId: e.logId,
      eventType: e.eventType,
      userIdentity: e.userIdentity,
      payloadJson: e.payloadJson,
      blockTimestamp: e.blockTimestamp,
      entryHash: e.entryHash,
    })),
    chainVerification: {
      valid: chain.valid,
      checkedEntries: chain.entries,
      ...(chain.brokenAt !== null && { firstBrokenAt: chain.brokenAt }),
    },
  };
}

// ── HTML generation ──────────────────────────────────────────────────────────

/**
 * Escape for HTML text and attribute contexts.
 *
 * Every dynamic value in the report goes through this. `payload_json` is the
 * one that matters: it is operator- and document-derived text rendered inside
 * the page, so unescaped it would let a crafted document inject markup into an
 * audit report that is then circulated to counterparties.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Event severity class (spec Task 1 colour coding).
 *
 * Ordering is load-bearing: the human-decision events are matched before the
 * generic failure test, so a `HUMAN_OVERRIDE` recorded on a failed condition
 * still reads as an amber human decision rather than a red system error.
 */
export function eventClass(eventType: string): string {
  if (eventType === "HUMAN_CORRECTION" || eventType === "HUMAN_OVERRIDE") return "evt-amber";
  if (eventType === "LEXGUARD_CORRECTION") return "evt-blue";
  if (eventType === "cre_execution_completed" || eventType === "settlement_on_chain") {
    return "evt-green";
  }
  if (/fail|error|FAILED/i.test(eventType)) return "evt-red";
  return "evt-default";
}

/** Truncated hash for the trail column — the full value stays in the payload. */
function shortHash(hash: string): string {
  const bare = hash.replace(/^sha256:/, "");
  return bare.length <= 20 ? bare : `${bare.slice(0, 12)}…${bare.slice(-6)}`;
}

/** camelCase / snake_case key → human label for the parties table. */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Pretty-print the stored payload, falling back to the raw text if it is not JSON. */
function formatPayload(payloadJson: string): string {
  try {
    return JSON.stringify(JSON.parse(payloadJson), null, 2);
  } catch {
    return payloadJson;
  }
}

function summaryRow(label: string, valueHtml: string): string {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${valueHtml}</td></tr>`;
}

const REPORT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #0f172a; background: #ffffff;
  }
  .sheet { max-width: 900px; margin: 0 auto; }
  header { border-bottom: 2px solid #0f172a; padding-bottom: 16px; }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  .brand span { color: #6366f1; }
  .doctitle { font-size: 15px; font-weight: 600; color: #334155; margin-top: 2px; }
  .meta { margin-top: 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 24px; }
  .meta div { font-size: 12px; color: #475569; }
  .meta b { color: #0f172a; font-weight: 600; }
  .badge {
    display: inline-block; margin-top: 10px; padding: 3px 10px; border-radius: 999px;
    background: #eef2ff; color: #4338ca; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  h2 {
    font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: #475569; margin: 28px 0 10px;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th[scope="row"] { width: 30%; font-weight: 600; color: #475569; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }
  a { color: #4f46e5; }
  .banner { margin-top: 12px; padding: 12px 16px; border-radius: 8px; font-weight: 600; font-size: 13px; }
  .banner-ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
  .banner-bad { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
  .trail { border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  .trail-head, .trail summary {
    display: grid;
    grid-template-columns: 44px 176px minmax(0, 1fr) 168px 148px;
    gap: 12px; align-items: baseline; padding: 7px 12px;
  }
  .trail-head {
    background: #f8fafc; border-bottom: 1px solid #e2e8f0;
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; color: #64748b;
  }
  .trail details { border-bottom: 1px solid #f1f5f9; border-left: 3px solid transparent; }
  .trail details:last-child { border-bottom: 0; }
  .trail summary { cursor: pointer; font-size: 12px; }
  .trail summary::-webkit-details-marker { display: none; }
  .trail .event { font-weight: 600; }
  .trail .who, .trail .when { color: #64748b; }
  .trail pre {
    margin: 0; padding: 10px 12px 14px 56px; background: #f8fafc;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px; white-space: pre-wrap; word-break: break-word; color: #334155;
  }
  .evt-amber { border-left-color: #f59e0b; } .evt-amber .event { color: #b45309; }
  .evt-blue  { border-left-color: #3b82f6; } .evt-blue .event  { color: #1d4ed8; }
  .evt-green { border-left-color: #10b981; } .evt-green .event { color: #047857; }
  .evt-red   { border-left-color: #ef4444; } .evt-red .event   { color: #b91c1c; }
  .evt-default .event { color: #334155; }
  footer {
    margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0;
    font-size: 11px; color: #64748b;
  }
  .qr {
    display: inline-block; margin-top: 10px; padding: 10px 14px;
    border: 1px dashed #cbd5e1; border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px; color: #475569; word-break: break-all;
  }
  @media print {
    body { padding: 0; }
    .trail details { break-inside: avoid; }
    .trail details[open] pre { display: block; }
  }
`;

/**
 * Render the complete report as one self-contained HTML document.
 *
 * Self-contained is a requirement, not a convenience: the file gets emailed to
 * counterparties and opened from disk, where any external stylesheet or script
 * reference would simply fail to load.
 */
export function generateAuditReportHtml(data: AuditReportData): string {
  const title = `lexescrow-audit-${data.sessionId.slice(0, 8)}`;

  const summaryRows = [
    summaryRow("Document hash", `<span class="mono">${escapeHtml(data.documentHash)}</span>`),
    data.anchorReceiptId
      ? summaryRow("AnchorReceipt ID", `<span class="mono">${escapeHtml(data.anchorReceiptId)}</span>`)
      : "",
    data.anchorReceiptHash
      ? summaryRow("AnchorReceipt hash", `<span class="mono">${escapeHtml(data.anchorReceiptHash)}</span>`)
      : "",
    data.onChainTx
      ? summaryRow(
          "On-chain registration",
          txHtml(data.onChainTx),
        )
      : "",
    summaryRow("Execution path", escapeHtml(data.executionPath)),
    data.settlementTxHash
      ? summaryRow(
          "Settlement transaction",
          txHtml(data.settlementTxHash),
        )
      : "",
  ].join("");

  const partyEntries = Object.entries(data.parties);
  const partiesSection = partyEntries.length
    ? `<table><tbody>${partyEntries
        .map(([k, v]) => summaryRow(humanizeKey(k), escapeHtml(v)))
        .join("")}</tbody></table>`
    : `<p>No party anchors were recorded for this session.</p>`;

  const banner = data.chainVerification.valid
    ? `<div class="banner banner-ok">✅ Chain intact — ${data.chainVerification.checkedEntries} entries verified</div>`
    : `<div class="banner banner-bad">❌ Chain broken at entry ${data.chainVerification.firstBrokenAt ?? "unknown"}</div>`;

  const trailRows = data.auditTrail
    .map(
      (e) =>
        `<details class="${eventClass(e.eventType)}">` +
        `<summary>` +
        `<span class="mono">${escapeHtml(e.logId)}</span>` +
        `<span class="when">${escapeHtml(e.blockTimestamp)}</span>` +
        `<span class="event">${escapeHtml(e.eventType)}</span>` +
        `<span class="who">${escapeHtml(e.userIdentity)}</span>` +
        `<span class="mono">${escapeHtml(shortHash(e.entryHash))}</span>` +
        `</summary>` +
        `<pre>${escapeHtml(formatPayload(e.payloadJson))}</pre>` +
        `</details>`,
    )
    .join("");

  const trailSection = data.auditTrail.length
    ? `<div class="trail">` +
      `<div class="trail-head">` +
      `<span>#</span><span>Timestamp</span><span>Event</span><span>User</span><span>Hash</span>` +
      `</div>${trailRows}</div>`
    : `<p>No audit entries were recorded for this session.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="sheet">
<header>
<div class="brand">Lex<span>Escrow</span></div>
<div class="doctitle">Audit Report</div>
<div class="meta">
<div>Session ID: <b class="mono">${escapeHtml(data.sessionId)}</b></div>
<div>Generated at: <b>${escapeHtml(data.generatedAt)}</b></div>
<div>Operator: <b>${escapeHtml(data.operator)}</b></div>
<div>Entries: <b>${escapeHtml(data.auditTrail.length)}</b></div>
</div>
<div class="badge">${escapeHtml(data.assetClass)}</div>
</header>

<h2>Transaction summary</h2>
<table><tbody>${summaryRows}</tbody></table>

<h2>Parties</h2>
${partiesSection}

<h2>Chain verification</h2>
${banner}

<h2>Audit trail</h2>
${trailSection}

<footer>
<div>Generated by LexEscrow — Provenyx LLC</div>
<div>This report is a cryptographic audit trail extract. Verify the chain independently using the entry hashes above.</div>
<div class="qr">[QR: ${escapeHtml(data.onChainTx ?? "no on-chain registration")}]</div>
</footer>
</div>
</body>
</html>`;
}

// ── PDF generation ───────────────────────────────────────────────────────────

// Palette mirrored from REPORT_CSS so the PDF and the HTML extract read as the
// same document family.
const INK: [number, number, number] = [15, 23, 42]; // slate-900
const MUTED: [number, number, number] = [71, 85, 105]; // slate-600
const FAINT: [number, number, number] = [100, 116, 139]; // slate-500
const RULE: [number, number, number] = [226, 232, 240]; // slate-200

/** `eventClass` → RGB, matching the HTML report's severity colours. */
const EVENT_RGB: Record<string, [number, number, number]> = {
  "evt-amber": [180, 83, 9],
  "evt-blue": [29, 78, 216],
  "evt-green": [4, 120, 87],
  "evt-red": [185, 28, 28],
};

const PAGE_MARGIN = 48;

function sectionTitle(doc: jsPDF, title: string, y: number): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(title.toUpperCase(), PAGE_MARGIN, y);
  return y + 8;
}

/** finalY of the most recent autotable — v5 still records it on the doc. */
function lastTableY(doc: jsPDF): number {
  return (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
}

function labelValueTable(doc: jsPDF, rows: Array<[string, string]>, startY: number): number {
  autoTable(doc, {
    startY,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    theme: "plain",
    styles: {
      fontSize: 8.5,
      cellPadding: { top: 4, bottom: 4, left: 0, right: 8 },
      textColor: INK,
      lineColor: RULE,
      lineWidth: { bottom: 0.5 },
      overflow: "linebreak",
    },
    columnStyles: {
      0: { cellWidth: 150, fontStyle: "bold", textColor: MUTED },
      1: { font: "courier", fontSize: 8 },
    },
    body: rows,
  });
  return lastTableY(doc);
}

/**
 * Render the report as a real PDF.
 *
 * Same content contract as the HTML renderer — header identity, transaction
 * summary (AnchorReceipt hash + on-chain reference included), parties, chain
 * verdict, and the full trail (log id, timestamp, event, user identity and the
 * *untruncated* entry hash, so the printed page carries what recomputation
 * needs to be checked against).
 */
export function generateAuditReportPdf(data: AuditReportData): Uint8Array {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // ── Header ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(...INK);
  doc.text("LexEscrow", PAGE_MARGIN, 60);
  doc.setFontSize(12);
  doc.setTextColor(...MUTED);
  doc.text("Audit Report", PAGE_MARGIN, 78);
  doc.setFontSize(9);
  doc.setTextColor(99, 102, 241); // indigo badge, as in the HTML header
  doc.text(data.assetClass.toUpperCase(), pageWidth - PAGE_MARGIN, 60, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...MUTED);
  const meta = [
    `Session ID: ${data.sessionId}`,
    `Generated at: ${data.generatedAt}`,
    `Operator: ${data.operator}`,
    `Audit entries: ${data.auditTrail.length}`,
  ];
  meta.forEach((line, i) => doc.text(line, PAGE_MARGIN, 94 + i * 11));

  const headerRule = 94 + meta.length * 11;
  doc.setDrawColor(...INK);
  doc.setLineWidth(1.2);
  doc.line(PAGE_MARGIN, headerRule, pageWidth - PAGE_MARGIN, headerRule);

  // ── Transaction summary ──
  let y = sectionTitle(doc, "Transaction summary", headerRule + 22);
  const summary: Array<[string, string]> = [["Document hash", data.documentHash]];
  if (data.anchorReceiptId) summary.push(["AnchorReceipt ID", data.anchorReceiptId]);
  if (data.anchorReceiptHash) summary.push(["AnchorReceipt hash", data.anchorReceiptHash]);
  if (data.onChainTx) {
    summary.push(["On-chain registration", txText(data.onChainTx)]);
  }
  summary.push(["Execution path", data.executionPath]);
  if (data.settlementTxHash) {
    summary.push([
      "Settlement transaction",
      txText(data.settlementTxHash),
    ]);
  }
  y = labelValueTable(doc, summary, y);

  // ── Parties ──
  y = sectionTitle(doc, "Parties", y + 20);
  const parties = Object.entries(data.parties);
  if (parties.length) {
    y = labelValueTable(doc, parties.map(([k, v]) => [humanizeKey(k), v]), y);
  } else {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    y += 6;
    doc.text("No party anchors were recorded for this session.", PAGE_MARGIN, y);
  }

  // ── Chain verification ──
  y = sectionTitle(doc, "Chain verification", y + 20) + 6;
  const { valid, checkedEntries, firstBrokenAt } = data.chainVerification;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(...(valid ? EVENT_RGB["evt-green"] : EVENT_RGB["evt-red"]));
  doc.text(
    valid
      ? `Chain intact — ${checkedEntries} entries verified`
      : `Chain broken at entry ${firstBrokenAt ?? "unknown"}`,
    PAGE_MARGIN,
    y,
  );

  // ── Audit trail ──
  y = sectionTitle(doc, "Audit trail", y + 24);
  if (data.auditTrail.length) {
    autoTable(doc, {
      startY: y,
      margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, bottom: 56 },
      theme: "plain",
      styles: {
        fontSize: 7.5,
        cellPadding: { top: 4, bottom: 4, left: 0, right: 6 },
        textColor: INK,
        lineColor: RULE,
        lineWidth: { bottom: 0.5 },
        overflow: "linebreak",
        valign: "top",
      },
      headStyles: { fontStyle: "bold", textColor: FAINT, fontSize: 7 },
      columnStyles: {
        0: { cellWidth: 24 },
        1: { cellWidth: 104 },
        2: { cellWidth: 114, fontStyle: "bold" },
        3: { cellWidth: 104 },
        4: { font: "courier", fontSize: 6.5 },
      },
      head: [["#", "Timestamp", "Event", "User identity", "Entry hash"]],
      body: data.auditTrail.map((e) => [
        String(e.logId),
        e.blockTimestamp,
        e.eventType,
        e.userIdentity,
        e.entryHash,
      ]),
      didParseCell: (hook) => {
        if (hook.section !== "body" || hook.column.index !== 2) return;
        const rgb = EVENT_RGB[eventClass(String(hook.cell.raw))];
        if (rgb) hook.cell.styles.textColor = rgb;
      },
    });
  } else {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    y += 6;
    doc.text("No audit entries were recorded for this session.", PAGE_MARGIN, y);
  }

  // ── Footer, on every page ──
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.5);
    doc.line(PAGE_MARGIN, pageHeight - 44, pageWidth - PAGE_MARGIN, pageHeight - 44);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...FAINT);
    doc.text("Generated by LexEscrow — Provenyx LLC", PAGE_MARGIN, pageHeight - 33);
    doc.text(
      "This report is a cryptographic audit trail extract. The hash chain is verifiable by sequential recomputation of the entry hashes.",
      PAGE_MARGIN,
      pageHeight - 23,
      { maxWidth: pageWidth - 2 * PAGE_MARGIN - 70 },
    );
    doc.text(`Page ${page} of ${pages}`, pageWidth - PAGE_MARGIN, pageHeight - 33, {
      align: "right",
    });
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/** Suggested filename stem, shared by the PDF and the HTML fallback artifact. */
export function reportFilename(sessionId: string): string {
  return `lexescrow-audit-${sessionId.slice(0, 8)}`;
}

/**
 * Generate the PDF and save it.
 *
 * Under Tauri the bytes go through the native save dialog and a narrow Rust
 * command (`save_audit_report`) — never `window.print()`, which WKWebView may
 * silently drop in the packaged app. A cancelled dialog is a decision, not an
 * error, so it returns without writing. Outside Tauri (browser dev mode) the
 * same PDF arrives as a plain blob download.
 */
export async function downloadAuditReport(
  sessionId: string,
  store: SessionStoreLike,
): Promise<void> {
  const data = await buildAuditReportData(sessionId, store);
  const bytes = generateAuditReportPdf(data);
  const filename = `${reportFilename(sessionId)}.pdf`;

  if (backend.isTauri()) {
    const path = await save({
      title: "Save audit report",
      defaultPath: filename,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!path) return; // operator cancelled the dialog
    await invoke<void>("save_audit_report", { path, bytes: Array.from(bytes) });
    return;
  }

  await writeFile(bytes as BlobPart, filename, "application/pdf");
}

/**
 * Download the raw HTML instead of the PDF. The fallback artifact for headless
 * and kiosk environments — a plain blob download, no print pipeline involved.
 */
export async function exportAuditReportHtml(
  sessionId: string,
  store: SessionStoreLike,
): Promise<void> {
  const data = await buildAuditReportData(sessionId, store);
  await writeFile(generateAuditReportHtml(data), `${reportFilename(sessionId)}.html`, "text/html");
}

/** Blob + object-URL download, matching `downloadReceipt` in anchor-receipt.ts. */
async function writeFile(content: BlobPart, filename: string, type: string): Promise<void> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
