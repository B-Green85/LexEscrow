/**
 * Audit report export (spec §14 V1 — "Audit report PDF export with embedded QR
 * linking to on-chain records").
 *
 * Produces a self-contained HTML report of a session's hash-chained audit trail
 * and hands it to the browser's own print-to-PDF. No PDF library: a bundled
 * renderer would add a large dependency to produce a *worse* artifact than the
 * one the platform already ships — the print pipeline handles pagination,
 * embedded fonts and vector text for free, and the operator keeps control of
 * page size and margins.
 *
 * The trade is that the report is generated, not archived. That is the correct
 * posture here: the authoritative record is the hash-chained trail in SQLite,
 * and this report is an *extract* of it. Anyone can recompute the entry hashes
 * from the values printed on the page, which is exactly what the footer tells
 * them to do.
 */

import * as backend from "../backend";
import { txUrl } from "../explorer";
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
          `<a class="mono" href="${escapeHtml(explorerTx(data.onChainTx))}">${escapeHtml(data.onChainTx)}</a>`,
        )
      : "",
    summaryRow("Execution path", escapeHtml(data.executionPath)),
    data.settlementTxHash
      ? summaryRow(
          "Settlement transaction",
          `<a class="mono" href="${escapeHtml(explorerTx(data.settlementTxHash))}">${escapeHtml(data.settlementTxHash)}</a>`,
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

// ── Delivery ─────────────────────────────────────────────────────────────────

/** Suggested filename stem — the browser uses the document title for print-to-PDF. */
export function reportFilename(sessionId: string): string {
  return `lexescrow-audit-${sessionId.slice(0, 8)}`;
}

/**
 * Open the report in a new window and raise the print dialog, from which the
 * operator saves as PDF.
 *
 * A blocked popup returns `null` from `window.open`, which is common enough to
 * handle rather than fail on — the HTML download is the same artifact by a
 * different route, so falling back to it is strictly better than showing the
 * officer nothing.
 */
export async function downloadAuditReport(
  sessionId: string,
  store: SessionStoreLike,
): Promise<void> {
  const data = await buildAuditReportData(sessionId, store);
  const html = generateAuditReportHtml(data);

  const win = typeof window !== "undefined" ? window.open("", "_blank") : null;
  if (!win) {
    await writeHtmlFile(html, reportFilename(sessionId));
    return;
  }

  win.document.open();
  win.document.write(html);
  win.document.close();
  // No external resources are referenced, so parsing is complete once `close()`
  // returns and there is nothing left to wait on before printing.
  win.focus?.();
  win.print?.();
}

/**
 * Download the raw HTML instead of printing. The fallback path for headless and
 * kiosk environments where no print dialog is reachable.
 */
export async function exportAuditReportHtml(
  sessionId: string,
  store: SessionStoreLike,
): Promise<void> {
  const data = await buildAuditReportData(sessionId, store);
  await writeHtmlFile(generateAuditReportHtml(data), reportFilename(sessionId));
}

/** Blob + object-URL download, matching `downloadReceipt` in anchor-receipt.ts. */
async function writeHtmlFile(html: string, stem: string): Promise<void> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${stem}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
