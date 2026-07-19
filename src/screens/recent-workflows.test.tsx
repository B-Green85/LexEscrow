/**
 * Render checks for Recent Workflows — Screen 9 (spec §12).
 *
 * Renders the pure `RecentWorkflowsView` through `react-dom/server`, the same
 * shape as the AnchorReceipt Console and Execution Confirmation screen tests.
 *
 * `filterSessions` is exercised directly as well as through the view: the
 * search box is the only way an officer narrows a 20-row history, so a filter
 * that silently drops a field is a real loss of visibility, not a cosmetic bug.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import {
  RecentWorkflowsView,
  filterSessions,
  type RecentWorkflowsViewProps,
} from "./RecentWorkflows";
import type { AuditEntry, RecentSessionRow } from "../lib/backend";

function session(over: Partial<RecentSessionRow> = {}): RecentSessionRow {
  return {
    sessionId: "wf-1111",
    clientId: "Jane Anderson",
    assetClass: "legal",
    executionPath: "DirectSettlement",
    currentState: "EXECUTED",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:30:00.000Z",
    totalHeldCents: 1_250_000,
    ...over,
  };
}

const SESSIONS: RecentSessionRow[] = [
  session(),
  session({
    sessionId: "wf-2222",
    clientId: "Green Valley Farms",
    assetClass: "cannabis_ind",
    currentState: "ESCALATED",
    executionPath: null,
    totalHeldCents: null,
  }),
  session({
    sessionId: "wf-3333",
    clientId: "Otis Holdings",
    assetClass: "real_estate",
    currentState: "FAILED",
    executionPath: "ArbitrationEscrow",
  }),
];

function props(over: Partial<RecentWorkflowsViewProps> = {}): RecentWorkflowsViewProps {
  return {
    sessions: SESSIONS,
    loading: false,
    error: null,
    search: "",
    onSearchChange: () => {},
    auditSessionId: null,
    auditEntries: [],
    auditLoading: false,
    auditError: null,
    onViewAudit: () => {},
    onCloseAudit: () => {},
    onNewTransaction: () => {},
    onClose: () => {},
    ...over,
  };
}

const render = (over: Partial<RecentWorkflowsViewProps> = {}) =>
  renderToString(createElement(RecentWorkflowsView, props(over)));

describe("filterSessions", () => {
  it("returns everything for an empty or whitespace term", () => {
    expect(filterSessions(SESSIONS, "")).toHaveLength(3);
    expect(filterSessions(SESSIONS, "   ")).toHaveLength(3);
  });

  it("matches each searchable field", () => {
    expect(filterSessions(SESSIONS, "Otis").map((s) => s.sessionId)).toEqual(["wf-3333"]);
    expect(filterSessions(SESSIONS, "cannabis").map((s) => s.sessionId)).toEqual(["wf-2222"]);
    expect(filterSessions(SESSIONS, "wf-1111").map((s) => s.sessionId)).toEqual(["wf-1111"]);
    expect(filterSessions(SESSIONS, "FAILED").map((s) => s.sessionId)).toEqual(["wf-3333"]);
    expect(filterSessions(SESSIONS, "Arbitration").map((s) => s.sessionId)).toEqual(["wf-3333"]);
  });

  it("is case-insensitive", () => {
    expect(filterSessions(SESSIONS, "jane anderson")).toHaveLength(1);
    expect(filterSessions(SESSIONS, "ESCALATED")).toHaveLength(1);
    expect(filterSessions(SESSIONS, "escalated")).toHaveLength(1);
  });

  it("does not crash on a null execution path", () => {
    expect(filterSessions(SESSIONS, "settlement").map((s) => s.sessionId)).toEqual(["wf-1111"]);
  });

  it("returns nothing when the term matches no field", () => {
    expect(filterSessions(SESSIONS, "zzzz")).toHaveLength(0);
  });
});

describe("RecentWorkflowsView", () => {
  it("lists every session with its client, state and execution path", () => {
    const html = render();
    expect(html).toContain("Jane Anderson");
    expect(html).toContain("Green Valley Farms");
    expect(html).toContain("Otis Holdings");
    expect(html).toContain("EXECUTED");
    expect(html).toContain("Direct Settlement");
    expect(html).toContain("View Audit Trail");
  });

  it("shows a result count only while a search term is active", () => {
    expect(render()).not.toContain("result-count");
    expect(render({ search: "Otis" })).toContain("1 result");
    expect(render({ search: "wf-" })).toContain("3 results");
  });

  it("offers a clear button only when the term is non-empty", () => {
    expect(render()).not.toContain("Clear search");
    expect(render({ search: "Otis" })).toContain("Clear search");
  });

  it("renders the empty state with a New Transaction button when nothing is recorded", () => {
    const html = render({ sessions: [] });
    expect(html).toContain("No workflows yet");
    expect(html).toContain("New Transaction");
  });

  it("distinguishes an excluding search from an empty history", () => {
    const html = render({ search: "zzzz" });
    expect(html).toContain("No matching workflows");
    expect(html).not.toContain("No workflows yet");
  });

  it("shows an em dash rather than a zero for a session with no payload yet", () => {
    const html = render({ sessions: [SESSIONS[1]] });
    expect(html).not.toContain("$0.00");
    expect(html).toContain("—");
  });

  it("renders the audit trail modal with the hash chain when a session is selected", () => {
    const entries: AuditEntry[] = [
      {
        logId: 1,
        sessionId: "wf-1111",
        eventType: "document_loaded",
        userIdentity: "paralegal@lawfirm.com",
        payloadJson: '{"filename":"retainer.pdf"}',
        blockTimestamp: "2026-07-01T10:00:00.000Z",
        previousHash: null,
        entryHash: `sha256:${"a".repeat(64)}`,
      },
      {
        logId: 2,
        sessionId: "wf-1111",
        eventType: "acknowledgment_checked",
        userIdentity: "paralegal@lawfirm.com",
        payloadJson: '{"user":"paralegal@lawfirm.com"}',
        blockTimestamp: "2026-07-01T10:05:00.000Z",
        previousHash: `sha256:${"a".repeat(64)}`,
        entryHash: `sha256:${"b".repeat(64)}`,
      },
    ];
    const html = render({ auditSessionId: "wf-1111", auditEntries: entries });

    expect(html).toContain("audit-trail-modal");
    expect(html).toContain("document_loaded");
    expect(html).toContain("acknowledgment_checked");
    // The origin entry is labelled, not left as an empty cell.
    expect(html).toContain("chain origin");
    // The second entry commits to the first — the linkage is on screen.
    expect(html).toContain(`sha256:${"a".repeat(64)}`);
    expect(html).toContain(`sha256:${"b".repeat(64)}`);
  });

  it("keeps the modal closed when no session is selected", () => {
    expect(render()).not.toContain("audit-trail-modal");
  });
});
