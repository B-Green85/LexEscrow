// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Session store — release-path routing (spec §6).
 *
 * The unit tests in `lib/releasePaths` cover the flow modules and the screen
 * tests cover rendering; this covers the seam between them — `proceedToExecution`
 * branching on the recommended path, and the store actions that drive Path B
 * and Path C forward. Path A is asserted here too, because "unchanged" is a
 * claim worth a test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "./session";
import { ExecutionPath, type ParsedRetainerPayload } from "../lexguard/types";
import * as backend from "../lib/backend";
import type { MilestoneInput } from "../lib/releasePaths";

vi.mock("../lib/backend", () => ({
  finalVerifyBeforeExecution: vi.fn(),
  setExecutionPath: vi.fn(),
  updateSessionState: vi.fn(),
  logEvent: vi.fn(),
  loadArtifact: vi.fn(),
  createMilestone: vi.fn(),
  updateMilestoneStatus: vi.fn(),
  getMilestones: vi.fn(),
  createArbitration: vi.fn(),
  updateArbitration: vi.fn(),
  getArbitration: vi.fn(),
  sendClientNotification: vi.fn(),
  executeDirectSettle: vi.fn(),
  triggerCreWorkflow: vi.fn(),
}));

const mocked = vi.mocked(backend);

const SESSION = "wf-store-test-87654321";

let milestoneRows: backend.MilestoneRow[] = [];
let arbitrationRow: backend.ArbitrationRow | null = null;

const coalesce = <T,>(next: T | null | undefined, current: T | null): T | null =>
  next === undefined || next === null ? current : next;

function installFakes() {
  mocked.finalVerifyBeforeExecution.mockResolvedValue(undefined);
  mocked.setExecutionPath.mockResolvedValue(undefined);
  mocked.updateSessionState.mockResolvedValue(undefined);
  mocked.logEvent.mockResolvedValue({} as backend.AuditEntry);
  mocked.loadArtifact.mockResolvedValue({
    filename: "memo.pdf",
    hash: "sha256:evidence",
    size: 8,
    normalizedText: "",
  });
  mocked.sendClientNotification.mockResolvedValue({
    channel: "email",
    target: "c@example.com",
    status: "delivered",
  });
  // Path A now settles through the real backend command; the store must carry
  // the hash the receipt reports, and must not proceed without one.
  mocked.executeDirectSettle.mockResolvedValue({
    txHash: `0x${"ab".repeat(32)}`,
    blockNumber: 11281180,
    gasUsed: 77_381,
  });
  mocked.triggerCreWorkflow.mockResolvedValue({
    executionId: "exec-abc123",
    status: "ACCEPTED",
    workflowId: `0x${"00ef7d0a".repeat(8)}`,
  });

  mocked.createMilestone.mockImplementation(async (args) => {
    milestoneRows.push({
      milestoneId: args.milestoneId,
      sessionId: args.sessionId,
      label: args.label,
      description: args.description,
      amountCents: args.amountCents,
      conditionType: args.conditionType,
      releaseDate: args.releaseDate ?? null,
      evidenceRequired: args.evidenceRequired ?? null,
      status: "pending",
      sortOrder: args.sortOrder,
      submittedAt: null,
      approvedAt: null,
      releasedAt: null,
      txHash: null,
      evidenceHash: null,
      createdAt: new Date().toISOString(),
    });
  });
  mocked.updateMilestoneStatus.mockImplementation(async (args) => {
    milestoneRows = milestoneRows.map((row) =>
      row.milestoneId === args.milestoneId
        ? {
            ...row,
            status: args.status,
            submittedAt: coalesce(args.submittedAt, row.submittedAt),
            approvedAt: coalesce(args.approvedAt, row.approvedAt),
            releasedAt: coalesce(args.releasedAt, row.releasedAt),
            txHash: coalesce(args.txHash, row.txHash),
            evidenceHash: coalesce(args.evidenceHash, row.evidenceHash),
          }
        : row,
    );
  });
  mocked.getMilestones.mockImplementation(async (sessionId) =>
    milestoneRows.filter((m) => m.sessionId === sessionId).sort((a, b) => a.sortOrder - b.sortOrder),
  );

  mocked.createArbitration.mockImplementation(async (args) => {
    arbitrationRow = {
      sessionId: args.sessionId,
      lockedAt: new Date().toISOString(),
      arbiterAddress: args.arbiterAddress ?? null,
      party1Signed: 0,
      party2Signed: 0,
      arbiterSigned: 0,
      threshold: args.threshold,
      resolvedAt: null,
      resolutionTxHash: null,
      resolutionNotes: null,
    };
  });
  mocked.updateArbitration.mockImplementation(async (args) => {
    if (!arbitrationRow) return;
    const flag = (next: boolean | null | undefined, current: number) =>
      next === undefined || next === null ? current : next ? 1 : 0;
    arbitrationRow = {
      ...arbitrationRow,
      party1Signed: flag(args.party1Signed, arbitrationRow.party1Signed),
      party2Signed: flag(args.party2Signed, arbitrationRow.party2Signed),
      arbiterSigned: flag(args.arbiterSigned, arbitrationRow.arbiterSigned),
      resolvedAt: coalesce(args.resolvedAt, arbitrationRow.resolvedAt),
      resolutionTxHash: coalesce(args.resolutionTxHash, arbitrationRow.resolutionTxHash),
      resolutionNotes: coalesce(args.resolutionNotes, arbitrationRow.resolutionNotes),
    };
  });
  mocked.getArbitration.mockImplementation(async (sessionId) =>
    arbitrationRow && arbitrationRow.sessionId === sessionId ? arbitrationRow : null,
  );
}

function payloadFor(path: ExecutionPath): ParsedRetainerPayload {
  return {
    clientId: "C-001",
    lawFirmWallet: "0xfirm",
    clientWallet: "0xclient",
    totalHeld: 6000,
    earnedFees: 1000,
    unearnedBalance: 5000,
    disputedHours: 0,
    disputedAmount: 0,
    signaturesVerified: true,
    recommendedPath: path,
    anomaliesFlagged: [],
    anomaliesSuppressed: false,
    barNumber: "123456",
  };
}

/** Seed the store as if the officer just acknowledged the review screen. */
function seedApprovedSession(path: ExecutionPath) {
  useSession.setState({
    sessionId: SESSION,
    file: new File(["retainer"], "retainer.pdf"),
    artifact: {
      filename: "retainer.pdf",
      hash: "sha256:abcdef0123456789",
      size: 8,
      normalizedText: "",
    },
    payload: payloadFor(path),
    anchors: {
      attorneyBarNumber: "123456",
      state: "California",
      clientFullLegalName: "Jane Client",
      clientEmail: "c@example.com",
    },
    reviewOpenedAt: Date.now(),
    arbitrationState: null,
    stagedReleaseState: null,
    releasePathChosen: false,
    busy: false,
    error: null,
    creExecutionId: null,
    execution: {
      phase: "idle",
      path: null,
      txHash: null,
      clientCents: 0n,
      firmCents: 0n,
      notifications: [],
    },
  });
}

const threeMilestones: MilestoneInput[] = [
  { label: "Diligence", description: "d", amountCents: 200_000n, conditionType: "document" },
  { label: "Transfer", description: "d", amountCents: 300_000n, conditionType: "event" },
  { label: "Walkthrough", description: "d", amountCents: 100_000n, conditionType: "manual" },
];

beforeEach(() => {
  vi.clearAllMocks();
  milestoneRows = [];
  arbitrationRow = null;
  installFakes();
});

describe("proceedToExecution — path routing", () => {
  it("Path A settles directly through the real directSettle command", async () => {
    seedApprovedSession(ExecutionPath.DirectSettlement);
    await useSession.getState().proceedToExecution();

    const { execution, screen } = useSession.getState();
    expect(screen).toBe("execution");
    expect(execution.path).toBe(ExecutionPath.DirectSettlement);
    expect(execution.phase).toBe("done");
    // Unearned balance to the client, earned fees to the firm.
    expect(execution.clientCents).toBe(500_000n);
    expect(execution.firmCents).toBe(100_000n);
    // The settlement went through the backend command, converting USD cents
    // to USDC base units (1¢ = 10,000 units), and the hash on the execution
    // record is the one the receipt reported — never derived locally.
    expect(mocked.executeDirectSettle).toHaveBeenCalledWith({
      clientWallet: "0xclient",
      firmWallet: "0xfirm",
      clientAmountUsdc: "5000000000",
      firmAmountUsdc: "1000000000",
      documentHash: "sha256:abcdef0123456789",
    });
    expect(execution.txHash).toBe(`0x${"ab".repeat(32)}`);
    expect(mocked.updateSessionState).toHaveBeenCalledWith(SESSION, "EXECUTED");
    expect(execution.notifications).toHaveLength(1);
  });

  it("Path A triggers the CRE workflow before settling and records the execution ID", async () => {
    seedApprovedSession(ExecutionPath.DirectSettlement);
    await useSession.getState().proceedToExecution();

    // The enclave run is asked for with the escrow's shape — the total held,
    // not the client/firm split, because the workflow validates the escrow
    // rather than the disbursement. All six fields of `escrowPayloadSchema`
    // are required by the enclave; a four-field payload is rejected outright.
    expect(mocked.triggerCreWorkflow).toHaveBeenCalledWith({
      session_id: SESSION,
      asset_class: "legal",
      total_held_cents: 600_000,
      release_path: ExecutionPath.DirectSettlement,
      document_text: "",
      trust_anchors: { parties: ["Jane Client"], identifiers: ["123456"] },
    });
    // Integer cents, never a float — the enclave's schema is `z.number().int()`
    // and a rounding artefact here is a rejected payload, not a small error.
    const sent = mocked.triggerCreWorkflow.mock.calls[0][0] as { total_held_cents: number };
    expect(Number.isInteger(sent.total_held_cents)).toBe(true);
    expect(useSession.getState().creExecutionId).toBe("exec-abc123");

    // And it happened before the money moved: the CRE trigger is an
    // observation of the escrow as it stood going in.
    const triggerOrder = mocked.triggerCreWorkflow.mock.invocationCallOrder[0];
    const settleOrder = mocked.executeDirectSettle.mock.invocationCallOrder[0];
    expect(triggerOrder).toBeLessThan(settleOrder);

    // The execution ID reaches the audit trail, which is what the CRE event
    // log renders and what LexTrace matches on.
    const logged = mocked.logEvent.mock.calls.find((c) => c[1] === "cre_workflow_triggered");
    expect(logged).toBeDefined();
    expect(JSON.parse(String(logged?.[3]))).toMatchObject({
      execution_id: "exec-abc123",
      status: "ACCEPTED",
    });
  });

  it("Path A still settles when the CRE trigger fails — it observes, it does not gate", async () => {
    // An unreachable gateway must not acquire veto power over money movement
    // it plays no part in. This is the whole contract of the seam.
    mocked.triggerCreWorkflow.mockRejectedValue(new Error("Could not reach the CRE gateway"));
    seedApprovedSession(ExecutionPath.DirectSettlement);
    await useSession.getState().proceedToExecution();

    const { execution, creExecutionId, error } = useSession.getState();
    expect(execution.phase).toBe("done");
    expect(execution.txHash).toBe(`0x${"ab".repeat(32)}`);
    expect(mocked.executeDirectSettle).toHaveBeenCalled();
    expect(mocked.updateSessionState).toHaveBeenCalledWith(SESSION, "EXECUTED");
    // No execution ID, and no error surfaced to the officer — settlement
    // succeeded, and that is what the screen must say.
    expect(creExecutionId).toBeNull();
    expect(error).toBeNull();
    // The failure is not silent, though: it is on the record.
    expect(
      mocked.logEvent.mock.calls.some((c) => c[1] === "cre_workflow_trigger_failed"),
    ).toBe(true);
  });

  it("Path B locks the escrow and waits, without executing", async () => {
    seedApprovedSession(ExecutionPath.ArbitrationEscrow);
    await useSession.getState().proceedToExecution();

    const { execution, screen, arbitrationState, releasePathChosen } = useSession.getState();
    expect(screen).toBe("execution");
    expect(releasePathChosen).toBe(true);
    expect(execution.path).toBe(ExecutionPath.ArbitrationEscrow);
    expect(arbitrationState?.locked).toBe(true);
    expect(arbitrationState?.threshold).toBe(2);
    expect(arbitrationState?.lockTxHash).toBe("0xarb-lock-87654321");
    // Nothing settles on entry — the whole point of Path B.
    expect(mocked.updateSessionState).toHaveBeenCalledWith(SESSION, "FUNDED");
    expect(mocked.updateSessionState).not.toHaveBeenCalledWith(SESSION, "EXECUTED");
    expect(execution.phase).not.toBe("done");
  });

  it("Path C routes to milestone definition with no schedule yet", async () => {
    seedApprovedSession(ExecutionPath.StagedRelease);
    await useSession.getState().proceedToExecution();

    const { execution, screen, stagedReleaseState, releasePathChosen } = useSession.getState();
    expect(screen).toBe("execution");
    expect(releasePathChosen).toBe(true);
    expect(execution.path).toBe(ExecutionPath.StagedRelease);
    // The officer defines milestones before anything is deposited.
    expect(stagedReleaseState).toBeNull();
    expect(mocked.createMilestone).not.toHaveBeenCalled();
    expect(mocked.updateSessionState).not.toHaveBeenCalledWith(SESSION, "EXECUTED");
  });
});

describe("Path B — store actions", () => {
  beforeEach(async () => {
    seedApprovedSession(ExecutionPath.ArbitrationEscrow);
    await useSession.getState().proceedToExecution();
  });

  it("a single signature does not resolve", async () => {
    await useSession.getState().signArbitration("party1");

    const { arbitrationState, execution } = useSession.getState();
    expect(arbitrationState?.party1Signed).toBe(true);
    expect(arbitrationState?.resolvedAt).toBeUndefined();
    expect(execution.phase).not.toBe("done");
    expect(mocked.sendClientNotification).not.toHaveBeenCalled();
  });

  it("two signatures resolve and fire the client notification", async () => {
    await useSession.getState().signArbitration("party1");
    await useSession.getState().signArbitration("party2");

    const { arbitrationState, execution } = useSession.getState();
    expect(arbitrationState?.resolvedAt).toBeTruthy();
    expect(execution.phase).toBe("done");
    expect(execution.txHash).toBe("0xarb-resolve-87654321");
    // The full locked balance released.
    expect(execution.clientCents).toBe(600_000n);
    expect(mocked.updateSessionState).toHaveBeenCalledWith(SESSION, "EXECUTED");
    expect(mocked.sendClientNotification).toHaveBeenCalledTimes(1);
    expect(execution.notifications).toHaveLength(1);
  });

  it("signing twice as one party cannot reach the threshold", async () => {
    await useSession.getState().signArbitration("party1");
    await useSession.getState().signArbitration("party1");

    expect(useSession.getState().arbitrationState?.resolvedAt).toBeUndefined();
    expect(mocked.updateSessionState).not.toHaveBeenCalledWith(SESSION, "EXECUTED");
  });

  it("party 1 plus the arbiter also resolves (2-of-3)", async () => {
    await useSession.getState().signArbitration("party1");
    await useSession.getState().signArbitration("arbiter");
    expect(useSession.getState().arbitrationState?.resolvedAt).toBeTruthy();
  });
});

describe("Path C — store actions", () => {
  beforeEach(async () => {
    seedApprovedSession(ExecutionPath.StagedRelease);
    await useSession.getState().proceedToExecution();
  });

  it("rejects a schedule that does not exhaust the escrow", async () => {
    await useSession.getState().initStagedRelease(threeMilestones.slice(0, 2));

    const { stagedReleaseState, error } = useSession.getState();
    expect(stagedReleaseState).toBeNull();
    expect(error).toMatch(/must sum to the escrow total/i);
  });

  it("accepts a balanced schedule and records the deposit", async () => {
    await useSession.getState().initStagedRelease(threeMilestones);

    const { stagedReleaseState, execution, error } = useSession.getState();
    expect(error).toBeNull();
    expect(stagedReleaseState?.milestones).toHaveLength(3);
    expect(stagedReleaseState?.totalCents).toBe(600_000n);
    expect(stagedReleaseState?.remainingCents).toBe(600_000n);
    expect(execution.txHash).toBe("0xstaged-deposit-87654321");
  });

  it("drives one milestone through submit → approve → release", async () => {
    await useSession.getState().initStagedRelease(threeMilestones);
    const id = useSession.getState().stagedReleaseState!.milestones[0].id;

    await useSession.getState().submitEvidence(id, new File(["e"], "memo.pdf"));
    expect(useSession.getState().stagedReleaseState?.milestones[0].status).toBe("submitted");

    await useSession.getState().approveMilestone(id);
    expect(useSession.getState().stagedReleaseState?.milestones[0].status).toBe("approved");
    // Approval alone must not move money.
    expect(useSession.getState().stagedReleaseState?.releasedCents).toBe(0n);

    await useSession.getState().releaseMilestone(id);
    const state = useSession.getState().stagedReleaseState;
    expect(state?.milestones[0].status).toBe("released");
    expect(state?.releasedCents).toBe(200_000n);
    expect(state?.remainingCents).toBe(400_000n);
    expect(state?.currentMilestoneIndex).toBe(1);
    // Not the last milestone, so no notification yet.
    expect(mocked.sendClientNotification).not.toHaveBeenCalled();
  });

  it("refuses to release a milestone that was never approved", async () => {
    await useSession.getState().initStagedRelease(threeMilestones);
    const id = useSession.getState().stagedReleaseState!.milestones[0].id;

    await useSession.getState().releaseMilestone(id);
    expect(useSession.getState().error).toMatch(/must be approved/i);
    expect(useSession.getState().stagedReleaseState?.releasedCents).toBe(0n);
  });

  it("releasing the final milestone completes the session and notifies", async () => {
    await useSession.getState().initStagedRelease(threeMilestones);
    const ids = useSession.getState().stagedReleaseState!.milestones.map((m) => m.id);

    for (const id of ids) {
      await useSession.getState().submitEvidence(id, new File(["e"], "memo.pdf"));
      await useSession.getState().approveMilestone(id);
      await useSession.getState().releaseMilestone(id);
    }

    const { stagedReleaseState, execution } = useSession.getState();
    expect(stagedReleaseState?.releasedCents).toBe(600_000n);
    expect(stagedReleaseState?.remainingCents).toBe(0n);
    expect(stagedReleaseState?.completedAt).toBeTruthy();
    expect(mocked.updateSessionState).toHaveBeenCalledWith(SESSION, "EXECUTED");
    expect(execution.phase).toBe("done");
    expect(mocked.sendClientNotification).toHaveBeenCalledTimes(1);
  });
});

describe("reset", () => {
  it("clears release-path state", async () => {
    seedApprovedSession(ExecutionPath.ArbitrationEscrow);
    await useSession.getState().proceedToExecution();
    expect(useSession.getState().arbitrationState).not.toBeNull();

    useSession.getState().reset();

    const s = useSession.getState();
    expect(s.arbitrationState).toBeNull();
    expect(s.stagedReleaseState).toBeNull();
    expect(s.releasePathChosen).toBe(false);
  });
});
