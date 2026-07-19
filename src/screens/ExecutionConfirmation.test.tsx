/**
 * Render checks for the Execution Confirmation screen across all three release
 * paths (spec §6).
 *
 * Uses `react-dom/server` against the pure `ExecutionConfirmationView`, the
 * same shape as the Condition Definition screen tests. Rendering the store
 * container instead would not work: zustand v5 hands React `getInitialState`
 * as the server snapshot, so a server render always shows the store's initial
 * state regardless of what a test seeds.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import {
  ExecutionConfirmationView,
  type ExecutionConfirmationViewProps,
} from "./ExecutionConfirmation";
import { ExecutionPath } from "../lexguard/types";
import type { ExecutionState } from "../store/session";
import type { ArbitrationState, Milestone, StagedReleaseState } from "../lib/releasePaths";

function execution(over: Partial<ExecutionState> = {}): ExecutionState {
  return {
    phase: "idle",
    path: null,
    txHash: null,
    clientCents: 0n,
    firmCents: 0n,
    notifications: [],
    ...over,
  };
}

function props(over: Partial<ExecutionConfirmationViewProps> = {}): ExecutionConfirmationViewProps {
  return {
    execution: execution(),
    assetClass: "legal",
    arbitrationState: null,
    stagedReleaseState: null,
    escrowTotalCents: 600_000n,
    defaultRecipient: "0xclient",
    busy: false,
    error: null,
    fromBatch: false,
    cannaVerifyConditions: null,
    cannaVerifyRunning: false,
    anchorReceipt: null,
    onDownloadAnchorReceipt: () => {},
    onRunCannaVerify: () => {},
    onSignArbitration: () => {},
    onInitStagedRelease: () => {},
    onSubmitEvidence: () => {},
    onApproveMilestone: () => {},
    onReleaseMilestone: () => {},
    onDownload: () => {},
    onPrintReport: () => {},
    onReset: () => {},
    onReturnToBatch: () => {},
    ...over,
  };
}

function milestone(over: Partial<Milestone> & Pick<Milestone, "id" | "label">): Milestone {
  return {
    description: "desc",
    amountCents: 200_000n,
    conditionType: "manual",
    status: "pending",
    ...over,
  } as Milestone;
}

/**
 * Render, stripping React's SSR text separators.
 *
 * `renderToString` emits `<!-- -->` between adjacent text expressions, so
 * `{a} of {b}` serializes as `a<!-- --> of <!-- -->b`. Removing them lets the
 * assertions below read as the user-visible copy.
 */
const render = (p: Partial<ExecutionConfirmationViewProps> = {}) =>
  renderToString(createElement(ExecutionConfirmationView, props(p))).split("<!-- -->").join("");

/** Attributes of the `<button>` whose label is exactly `label`. */
function buttonAttrs(html: string, label: string): string {
  const match = html.match(new RegExp(`<button([^>]*)>${label}</button>`));
  if (!match) throw new Error(`no button labelled "${label}" was rendered`);
  return match[1];
}

describe("Path A — direct settlement", () => {
  it("renders the CRE phase list while settling", () => {
    const html = render({
      execution: execution({
        phase: "settling",
        path: ExecutionPath.DirectSettlement,
        clientCents: 500_000n,
        firmCents: 100_000n,
      }),
    });

    expect(html).toContain("Executing settlement");
    expect(html).toContain("Path A — Direct Settlement");
    expect(html).toContain("Executing settlement on-chain (CRE)");
    // Nothing has settled yet, so no summary.
    expect(html).not.toContain("Released to client");
  });

  it("renders the settlement summary when done", () => {
    const html = render({
      execution: execution({
        phase: "done",
        path: ExecutionPath.DirectSettlement,
        txHash: "0xabcdef1234567890",
        clientCents: 500_000n,
        firmCents: 100_000n,
        notifications: [{ channel: "email", target: "c@example.com", status: "delivered" }],
      }),
    });

    expect(html).toContain("Settlement complete");
    expect(html).toContain("Released to client");
    expect(html).toContain("$5,000.00");
    expect(html).toContain("$1,000.00");
    expect(html).toContain("Audit report (PDF)");
    expect(html).toContain("c@example.com");
  });
});

describe("Path B — arbitration escrow", () => {
  const locked: ArbitrationState = {
    locked: true,
    lockedAt: "2026-07-18T10:00:00Z",
    lockTxHash: "0xarb-lock-12345678",
    arbiterAddress: "0xarbiter",
    party1Signed: false,
    party2Signed: false,
    arbiterSigned: false,
    threshold: 2,
  };

  const arbExecution = execution({
    path: ExecutionPath.ArbitrationEscrow,
    txHash: "0xarb-lock-12345678",
    clientCents: 600_000n,
  });

  it("renders the locked state with no signatures yet", () => {
    const html = render({ arbitrationState: locked, execution: arbExecution });

    expect(html).toContain("Arbitration Escrow");
    expect(html).toContain("Funds Locked");
    expect(html).toContain("Path B — Arbitration Escrow");
    expect(html).toContain("0/2 required signatures");
    expect(html).toContain("Sign as Party 1");
    expect(html).toContain("Sign as Party 2");
    expect(html).toContain("Sign as Arbiter");
    expect(html).toContain("0xarbiter");
    expect(html).toContain("$6,000.00");
    expect(html).not.toContain("Arbitration Resolved");
  });

  it("reflects a partial signature tally and disables the party that signed", () => {
    const html = render({
      arbitrationState: { ...locked, party1Signed: true },
      execution: arbExecution,
    });

    expect(html).toContain("1/2 required signatures");
    // The signed party's button is disabled — nobody signs twice — while the
    // other two parties can still sign.
    expect(buttonAttrs(html, "Sign as Party 1")).toContain("disabled");
    expect(buttonAttrs(html, "Sign as Party 2")).not.toContain("disabled");
    expect(buttonAttrs(html, "Sign as Arbiter")).not.toContain("disabled");
  });

  it("disables every signature button once resolved", () => {
    const html = render({
      arbitrationState: {
        ...locked,
        party1Signed: true,
        party2Signed: true,
        resolvedAt: "2026-07-18T12:00:00Z",
        resolutionTxHash: "0xarb-resolve-12345678",
      },
      execution: arbExecution,
    });

    expect(buttonAttrs(html, "Sign as Party 1")).toContain("disabled");
    expect(buttonAttrs(html, "Sign as Party 2")).toContain("disabled");
    expect(buttonAttrs(html, "Sign as Arbiter")).toContain("disabled");
  });

  it("renders the resolution banner once the threshold is met", () => {
    const html = render({
      arbitrationState: {
        ...locked,
        party1Signed: true,
        party2Signed: true,
        resolvedAt: "2026-07-18T12:00:00Z",
        resolutionTxHash: "0xarb-resolve-12345678",
        resolutionNotes: "split agreed",
      },
      execution: execution({
        phase: "done",
        path: ExecutionPath.ArbitrationEscrow,
        txHash: "0xarb-resolve-12345678",
        clientCents: 600_000n,
        notifications: [{ channel: "email", target: "c@example.com", status: "delivered" }],
      }),
    });

    expect(html).toContain("Arbitration Resolved");
    expect(html).toContain("split agreed");
    expect(html).toContain("2/2 required signatures");
    expect(html).toContain("Audit report (PDF)");
  });

  it("shows a placeholder while the lock is still in flight", () => {
    const html = render({
      arbitrationState: null,
      execution: execution({ path: ExecutionPath.ArbitrationEscrow }),
    });
    expect(html).toContain("Locking escrow into arbitration");
  });
});

describe("Path C — staged release", () => {
  const stagedExecution = execution({ path: ExecutionPath.StagedRelease });

  it("renders the milestone definition form when no schedule exists", () => {
    const html = render({ stagedReleaseState: null, execution: stagedExecution });

    expect(html).toContain("Define Release Milestones");
    expect(html).toContain("Path C — Staged Release");
    expect(html).toContain("Add Milestone");
    expect(html).toContain("Initiate Staged Release");
    expect(html).toContain("Remove");
    // The escrow total the milestones must exhaust.
    expect(html).toContain("$6,000.00");
    // Nothing allocated yet, so the escrow is unallocated and submit is barred.
    expect(html).toContain("Milestone amounts must account for the entire escrow");
    expect(buttonAttrs(html, "Initiate Staged Release")).toContain("disabled");
  });

  it("renders milestone progress once the schedule exists", () => {
    const state: StagedReleaseState = {
      milestones: [
        milestone({
          id: "m1",
          label: "Due diligence",
          status: "released",
          txHash: "0xmilestone-1",
          releasedAt: "2026-07-18T10:00:00Z",
        }),
        milestone({ id: "m2", label: "Title transfer", status: "submitted", evidenceHash: "sha256:abc" }),
        milestone({ id: "m3", label: "Walkthrough" }),
      ],
      totalCents: 600_000n,
      releasedCents: 200_000n,
      remainingCents: 400_000n,
      currentMilestoneIndex: 1,
    };
    const html = render({ stagedReleaseState: state, execution: stagedExecution });

    expect(html).toContain("Staged release in progress");
    expect(html).toContain("$2,000.00 of $6,000.00");
    expect(html).toContain("1/3 milestones");
    expect(html).toContain("Due diligence");
    expect(html).toContain("Title transfer");
    // The current milestone is submitted, so approval is the offered action.
    expect(html).toContain("Approve Milestone");
    expect(html).toContain("sha256:abc");
  });

  it("offers evidence upload on a pending current milestone", () => {
    const state: StagedReleaseState = {
      milestones: [milestone({ id: "m1", label: "Due diligence" })],
      totalCents: 200_000n,
      releasedCents: 0n,
      remainingCents: 200_000n,
      currentMilestoneIndex: 0,
    };
    const html = render({ stagedReleaseState: state, execution: stagedExecution });

    expect(html).toContain("Submit Evidence");
    expect(html).toContain('type="file"');
  });

  it("offers release with a recipient input on an approved milestone", () => {
    const state: StagedReleaseState = {
      milestones: [milestone({ id: "m1", label: "Due diligence", status: "approved" })],
      totalCents: 200_000n,
      releasedCents: 0n,
      remainingCents: 200_000n,
      currentMilestoneIndex: 0,
    };
    const html = render({ stagedReleaseState: state, execution: stagedExecution });

    expect(html).toContain("Release Funds");
    expect(html).toContain("Recipient address");
    expect(html).toContain("0xclient");
  });

  it("keeps non-current milestones non-interactive", () => {
    const state: StagedReleaseState = {
      milestones: [
        milestone({ id: "m1", label: "First", status: "pending" }),
        milestone({ id: "m2", label: "Second", status: "pending" }),
      ],
      totalCents: 400_000n,
      releasedCents: 0n,
      remainingCents: 400_000n,
      currentMilestoneIndex: 0,
    };
    const html = render({ stagedReleaseState: state, execution: stagedExecution });

    // Exactly one upload control — the second milestone must wait its turn.
    expect(html.match(/type="file"/g)).toHaveLength(1);
    expect(html).toContain("opacity-60");
  });

  it("renders completion once every milestone has released", () => {
    const state: StagedReleaseState = {
      milestones: [
        milestone({ id: "m1", label: "A", status: "released", amountCents: 300_000n, txHash: "0xmilestone-a" }),
        milestone({ id: "m2", label: "B", status: "released", amountCents: 300_000n, txHash: "0xmilestone-b" }),
      ],
      totalCents: 600_000n,
      releasedCents: 600_000n,
      remainingCents: 0n,
      currentMilestoneIndex: 2,
      completedAt: "2026-07-18T12:00:00Z",
    };
    const html = render({
      stagedReleaseState: state,
      execution: execution({
        phase: "done",
        path: ExecutionPath.StagedRelease,
        notifications: [{ channel: "email", target: "c@example.com", status: "delivered" }],
      }),
    });

    expect(html).toContain("Staged release complete");
    expect(html).toContain("$6,000.00 of $6,000.00");
    expect(html).toContain("$0.00 remaining");
    expect(html).toContain("Audit report (PDF)");
  });
});
