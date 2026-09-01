/**
 * Audit report export tests.
 *
 * Two things are load-bearing here. First, the report must never *misstate* the
 * chain — a report that renders "chain intact" over a broken chain is worse
 * than no report. Second, every dynamic value has to be escaped: payload JSON
 * is document-derived text rendered into a page that gets circulated to
 * counterparties, so an unescaped `<script>` in a parsed field would travel
 * with it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  buildAuditReportData,
  generateAuditReportHtml,
  downloadAuditReport,
  exportAuditReportHtml,
  escapeHtml,
  eventClass,
  reportFilename,
  type AuditReportData,
} from "./audit-pdf-export";
import * as backend from "../backend";
import type { SessionState } from "../../store/session";

// The delivery path talks to the native layer twice: the save dialog picks the
// destination and the narrow `save_audit_report` command writes the bytes.
// Both are mocked at the module seam — there is no Tauri runtime under vitest.
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const SESSION_ID = "wf-3f9c2a11-0000-4444-8888-abcdefabcdef";

function entry(over: Partial<AuditReportData["auditTrail"][number]> = {}) {
  return {
    logId: 1,
    eventType: "document_loaded",
    userIdentity: "paralegal@lawfirm.example.com",
    payloadJson: '{"filename":"retainer.txt"}',
    blockTimestamp: "2026-07-18T10:00:00.000Z",
    entryHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbb",
    ...over,
  };
}

function reportData(over: Partial<AuditReportData> = {}): AuditReportData {
  return {
    sessionId: SESSION_ID,
    assetClass: "legal",
    generatedAt: "2026-07-18T12:00:00.000Z",
    operator: "paralegal@lawfirm.example.com",
    parties: { clientFullLegalName: "Meridian Consulting Group LLC" },
    documentHash: "sha256:deadbeef",
    executionPath: "DirectSettlement",
    auditTrail: [entry()],
    chainVerification: { valid: true, checkedEntries: 1 },
    ...over,
  };
}

/**
 * A session-store stand-in. Structural rather than a real store: the export
 * module only ever calls `getState()`, and building a live Zustand store would
 * pull the whole workflow in to test a renderer.
 */
function fakeStore(over: Record<string, unknown> = {}) {
  const state = {
    assetClass: "legal",
    operator: "paralegal@lawfirm.example.com",
    rawAnchors: {},
    anchors: {
      attorneyBarNumber: "447823",
      state: "California",
      clientFullLegalName: "Meridian Consulting Group LLC",
      clientEmail: "client@example.com",
      clientPhone: "",
    },
    artifact: { hash: "sha256:deadbeef", filename: "retainer.txt", size: 1, normalizedText: "" },
    anchorReceipt: null,
    payload: null,
    execution: { phase: "done", path: "DirectSettlement", txHash: "0xsettle", clientCents: 0n, firmCents: 0n, notifications: [] },
    ...over,
  } as unknown as SessionState;
  return { getState: () => state };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("buildAuditReportData", () => {
  it("returns the documented structure, pulling trail and chain from the backend", async () => {
    vi.spyOn(backend, "getAuditTrail").mockResolvedValue([
      {
        logId: 7,
        sessionId: SESSION_ID,
        eventType: "HUMAN_CORRECTION",
        userIdentity: "officer@example.com",
        payloadJson: '{"field":"unearnedBalance"}',
        blockTimestamp: "2026-07-18T10:05:00.000Z",
        previousHash: null,
        entryHash: "sha256:feedface",
      },
    ]);
    vi.spyOn(backend, "verifyAuditChain").mockResolvedValue({
      valid: true,
      entries: 1,
      brokenAt: null,
    });

    const data = await buildAuditReportData(SESSION_ID, fakeStore());

    expect(data.sessionId).toBe(SESSION_ID);
    expect(data.assetClass).toBe("legal");
    expect(data.documentHash).toBe("sha256:deadbeef");
    expect(data.executionPath).toBe("DirectSettlement");
    expect(data.settlementTxHash).toBe("0xsettle");
    expect(data.auditTrail).toHaveLength(1);
    expect(data.auditTrail[0].eventType).toBe("HUMAN_CORRECTION");
    expect(data.chainVerification).toEqual({ valid: true, checkedEntries: 1 });
    expect(Date.parse(data.generatedAt)).not.toBeNaN();
  });

  it("maps a broken chain onto firstBrokenAt", async () => {
    vi.spyOn(backend, "getAuditTrail").mockResolvedValue([]);
    vi.spyOn(backend, "verifyAuditChain").mockResolvedValue({
      valid: false,
      entries: 9,
      brokenAt: 4,
    });

    const data = await buildAuditReportData(SESSION_ID, fakeStore());
    expect(data.chainVerification).toEqual({ valid: false, checkedEntries: 9, firstBrokenAt: 4 });
  });

  it("prefers rawAnchors for parties, falling back to trust anchors", async () => {
    vi.spyOn(backend, "getAuditTrail").mockResolvedValue([]);
    vi.spyOn(backend, "verifyAuditChain").mockResolvedValue({ valid: true, entries: 0, brokenAt: null });

    const fromRaw = await buildAuditReportData(
      SESSION_ID,
      fakeStore({ rawAnchors: { licenseeName: "GreenLeaf Dispensary LLC" } }),
    );
    expect(fromRaw.parties).toEqual({ licenseeName: "GreenLeaf Dispensary LLC" });

    // The single-document legal flow populates TrustAnchors instead, so the
    // parties table must not come back empty there.
    const fromAnchors = await buildAuditReportData(SESSION_ID, fakeStore());
    expect(fromAnchors.parties.clientFullLegalName).toBe("Meridian Consulting Group LLC");
    expect(fromAnchors.parties.clientPhone).toBeUndefined();
  });
});

describe("generateAuditReportHtml", () => {
  it("includes the session ID", () => {
    expect(generateAuditReportHtml(reportData())).toContain(SESSION_ID);
  });

  it("includes every audit event and its payload", () => {
    const html = generateAuditReportHtml(
      reportData({
        auditTrail: [
          entry({ logId: 1, eventType: "document_loaded" }),
          entry({ logId: 2, eventType: "bar_verification_result" }),
          entry({ logId: 3, eventType: "cre_execution_completed", payloadJson: '{"tx_hash":"0xabc"}' }),
        ],
      }),
    );

    expect(html).toContain("document_loaded");
    expect(html).toContain("bar_verification_result");
    expect(html).toContain("cre_execution_completed");
    expect(html).toContain("0xabc");
  });

  it("marks an intact chain green with the entry count", () => {
    const html = generateAuditReportHtml(
      reportData({ chainVerification: { valid: true, checkedEntries: 42 } }),
    );
    // Matched on the rendered class attribute, not the bare name — both
    // modifiers appear in the stylesheet regardless of which one is used.
    expect(html).toContain('class="banner banner-ok"');
    expect(html).toContain("Chain intact — 42 entries verified");
    expect(html).not.toContain('class="banner banner-bad"');
  });

  it("marks a broken chain red with the failing entry", () => {
    const html = generateAuditReportHtml(
      reportData({ chainVerification: { valid: false, checkedEntries: 9, firstBrokenAt: 4 } }),
    );
    expect(html).toContain('class="banner banner-bad"');
    expect(html).toContain("Chain broken at entry 4");
    expect(html).not.toContain('class="banner banner-ok"');
  });

  it("gives HUMAN_CORRECTION and HUMAN_OVERRIDE events amber styling", () => {
    for (const eventType of ["HUMAN_CORRECTION", "HUMAN_OVERRIDE"]) {
      const html = generateAuditReportHtml(reportData({ auditTrail: [entry({ eventType })] }));
      expect(html).toContain('<details class="evt-amber">');
    }
  });

  it("gives cre_execution_completed and settlement_on_chain events green styling", () => {
    for (const eventType of ["cre_execution_completed", "settlement_on_chain"]) {
      const html = generateAuditReportHtml(reportData({ auditTrail: [entry({ eventType })] }));
      expect(html).toContain('<details class="evt-green">');
    }
  });

  it("gives LEXGUARD_CORRECTION blue and failures red", () => {
    expect(
      generateAuditReportHtml(reportData({ auditTrail: [entry({ eventType: "LEXGUARD_CORRECTION" })] })),
    ).toContain('<details class="evt-blue">');
    expect(
      generateAuditReportHtml(reportData({ auditTrail: [entry({ eventType: "esign_completion_failed" })] })),
    ).toContain('<details class="evt-red">');
  });

  it("links the on-chain and settlement transactions to Etherscan", () => {
    const html = generateAuditReportHtml(
      reportData({ onChainTx: "0xanchor123", settlementTxHash: "0xsettle456" }),
    );
    expect(html).toContain("https://sepolia.etherscan.io/tx/0xanchor123");
    expect(html).toContain("https://sepolia.etherscan.io/tx/0xsettle456");
    expect(html).toContain("[QR: 0xanchor123]");
  });

  it("carries the required footer attribution", () => {
    const html = generateAuditReportHtml(reportData());
    expect(html).toContain("Generated by LexEscrow — Provenyx LLC");
    expect(html).toContain("cryptographic audit trail extract");
  });

  it("produces balanced tags for every non-void element", () => {
    const html = generateAuditReportHtml(
      reportData({
        auditTrail: [entry({ logId: 1 }), entry({ logId: 2, eventType: "HUMAN_CORRECTION" })],
        parties: { buyer: "Thomas Whitfield", seller: "Sunrise Properties LLC" },
        onChainTx: "0xabc",
      }),
    );

    // `meta` is the only void element in the document; everything else must
    // pair up. Counting per tag name catches a missing </details> or </table>
    // that a bare angle-bracket count would miss.
    for (const tag of ["html", "head", "body", "div", "table", "tbody", "tr", "th", "td", "details", "summary", "span", "pre", "a", "header", "footer", "h2", "style", "title"]) {
      const open = html.match(new RegExp(`<${tag}(?=[\\s>])`, "g"))?.length ?? 0;
      const close = html.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
      expect(`${tag}:${open}`).toBe(`${tag}:${close}`);
    }
  });

  it("escapes markup in payloads so a crafted document cannot inject into the report", () => {
    const html = generateAuditReportHtml(
      reportData({
        auditTrail: [
          entry({ payloadJson: '{"client":"<script>alert(1)</script>"}' }),
        ],
        parties: { clientFullLegalName: '<img src=x onerror="alert(2)">' },
      }),
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('<img src=x onerror="alert(2)">');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
  });

  it("renders an empty trail without claiming entries exist", () => {
    const html = generateAuditReportHtml(reportData({ auditTrail: [] }));
    expect(html).toContain("No audit entries were recorded");
  });
});

describe("escapeHtml / eventClass / reportFilename", () => {
  it("escapes all five significant characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("classifies human decisions before generic failures", () => {
    // A HUMAN_OVERRIDE recorded on a failed condition is still a human
    // decision, not a system error.
    expect(eventClass("HUMAN_OVERRIDE")).toBe("evt-amber");
    expect(eventClass("HUMAN_CORRECTION")).toBe("evt-amber");
    expect(eventClass("LEXGUARD_CORRECTION")).toBe("evt-blue");
    expect(eventClass("settlement_on_chain")).toBe("evt-green");
    expect(eventClass("anchor_receipt_failed")).toBe("evt-red");
    expect(eventClass("review_screen_opened")).toBe("evt-default");
  });

  it("builds the spec'd filename stem from the first eight characters", () => {
    expect(reportFilename(SESSION_ID)).toBe("lexescrow-audit-wf-3f9c2");
  });
});

describe("delivery", () => {
  function stubBackend() {
    // Clears the module-mocked dialog/invoke call history too — the mocks
    // outlive `vi.restoreAllMocks()`, which only touches spies.
    vi.clearAllMocks();
    vi.spyOn(backend, "getAuditTrail").mockResolvedValue([]);
    vi.spyOn(backend, "verifyAuditChain").mockResolvedValue({ valid: true, entries: 0, brokenAt: null });
  }

  it("saves a real PDF through the native dialog and Rust command under Tauri", async () => {
    stubBackend();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(save).mockResolvedValue("/exports/audit.pdf");

    await downloadAuditReport(SESSION_ID, fakeStore());

    expect(save).toHaveBeenCalledOnce();
    expect(vi.mocked(save).mock.calls[0][0]).toMatchObject({
      defaultPath: "lexescrow-audit-wf-3f9c2.pdf",
    });
    expect(invoke).toHaveBeenCalledOnce();
    const [command, args] = vi.mocked(invoke).mock.calls[0] as [string, { path: string; bytes: number[] }];
    expect(command).toBe("save_audit_report");
    expect(args.path).toBe("/exports/audit.pdf");
    // The payload is a real PDF, not HTML wearing a .pdf name.
    expect(args.bytes.slice(0, 5)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
  });

  it("cancelling the dialog writes nothing; outside Tauri the PDF downloads as a blob", async () => {
    stubBackend();
    // Cancelled dialog: a decision, not an error — no bytes leave the app.
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(save).mockResolvedValue(null);
    await downloadAuditReport(SESSION_ID, fakeStore());
    expect(invoke).not.toHaveBeenCalled();

    // Browser dev mode: same PDF, plain blob download.
    const click = vi.fn();
    const anchor = { href: "", download: "", click };
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });

    await downloadAuditReport(SESSION_ID, fakeStore());

    expect(save).toHaveBeenCalledOnce(); // only the cancelled Tauri attempt above
    expect(click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe("lexescrow-audit-wf-3f9c2.pdf");
  });

  it("exportAuditReportHtml writes the HTML directly", async () => {
    stubBackend();
    const click = vi.fn();
    const anchor = { href: "", download: "", click };
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });

    await exportAuditReportHtml(SESSION_ID, fakeStore());

    expect(click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe("lexescrow-audit-wf-3f9c2.html");
  });
});
