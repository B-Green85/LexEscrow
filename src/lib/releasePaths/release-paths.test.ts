// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Release paths — Path B (ArbitrationEscrow) and Path C (StagedRelease).
 *
 * The backend module is mocked, but not with inert stubs: the fakes below keep
 * real in-memory state and reproduce the SQL semantics that matter, above all
 * the `COALESCE(?, col)` update behavior. A stub that simply returned
 * `undefined` would let a regression through — signing as party 2 clearing
 * party 1's signature, or releasing a milestone erasing its approval — which is
 * exactly the class of bug these paths must not have.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionPath, type ParsedRetainerPayload } from "../../lexguard/types";
import * as backend from "../backend";
import {
  approveMilestone,
  getArbitrationState,
  getStagedReleaseState,
  initArbitration,
  initStagedRelease,
  releaseMilestone,
  signArbitrationRelease,
  submitMilestoneEvidence,
  type MilestoneInput,
} from "./index";

vi.mock("../backend", () => ({
  createMilestone: vi.fn(),
  updateMilestoneStatus: vi.fn(),
  getMilestones: vi.fn().mockResolvedValue([]),
  createArbitration: vi.fn(),
  updateArbitration: vi.fn(),
  getArbitration: vi.fn().mockResolvedValue(null),
  loadArtifact: vi.fn().mockResolvedValue({ hash: "sha256:abc123" }),
  logEvent: vi.fn(),
  updateSessionState: vi.fn(),
  setExecutionPath: vi.fn(),
}));

const mocked = vi.mocked(backend);

const SESSION = "wf-test-session-12345678";

// ── Stateful fakes ───────────────────────────────────────────────────────────

let milestoneRows: backend.MilestoneRow[] = [];
let arbitrationRow: backend.ArbitrationRow | null = null;

/** COALESCE(?, col) — an omitted value preserves what is stored. */
const coalesce = <T,>(next: T | null | undefined, current: T | null): T | null =>
  next === undefined || next === null ? current : next;

function installFakes() {
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

  mocked.loadArtifact.mockResolvedValue({
    filename: "memo.pdf",
    hash: "sha256:abc123",
    size: 8,
    normalizedText: "evidence",
  });
}

function payloadWith(totalHeld: number): ParsedRetainerPayload {
  return {
    clientId: "C-001",
    lawFirmWallet: "0xfirm",
    clientWallet: "0xclient",
    totalHeld,
    earnedFees: 0,
    unearnedBalance: totalHeld,
    disputedHours: 0,
    disputedAmount: 0,
    signaturesVerified: true,
    recommendedPath: ExecutionPath.ArbitrationEscrow,
    anomaliesFlagged: [],
    anomaliesSuppressed: false,
    barNumber: "123456",
  };
}

/** Event names written to the audit trail, in order. */
const loggedEvents = (): string[] => mocked.logEvent.mock.calls.map((c) => c[1]);

const payloadOf = (event: string): Record<string, unknown> => {
  const call = mocked.logEvent.mock.calls.find((c) => c[1] === event);
  if (!call) throw new Error(`no ${event} event was logged`);
  return JSON.parse(call[3] as string);
};

beforeEach(() => {
  vi.clearAllMocks();
  milestoneRows = [];
  arbitrationRow = null;
  installFakes();
});

// ── Path B — Arbitration Escrow ──────────────────────────────────────────────

describe("Path B — arbitration escrow", () => {
  it("initArbitration creates the record and returns a locked state", async () => {
    const state = await initArbitration(SESSION, payloadWith(5000), "0xarbiter");

    expect(mocked.createArbitration).toHaveBeenCalledWith({
      sessionId: SESSION,
      arbiterAddress: "0xarbiter",
      threshold: 2,
    });
    expect(state.locked).toBe(true);
    expect(state.threshold).toBe(2);
    expect(state.party1Signed).toBe(false);
    expect(state.party2Signed).toBe(false);
    expect(state.arbiterSigned).toBe(false);
    expect(state.resolvedAt).toBeUndefined();
  });

  it("initArbitration generates the mock lock transaction", async () => {
    const state = await initArbitration(SESSION, payloadWith(5000));
    expect(state.lockTxHash).toBe("0xarb-lock-12345678");
  });

  it("initArbitration funds the session on Path B rather than executing it", async () => {
    await initArbitration(SESSION, payloadWith(5000));
    expect(mocked.setExecutionPath).toHaveBeenCalledWith(SESSION, ExecutionPath.ArbitrationEscrow);
    expect(mocked.updateSessionState).toHaveBeenCalledWith(SESSION, "FUNDED");
    expect(mocked.updateSessionState).not.toHaveBeenCalledWith(SESSION, "EXECUTED");
  });

  it("initArbitration logs arbitration_locked with the escrow amounts", async () => {
    await initArbitration(SESSION, payloadWith(5000), "0xarbiter");
    expect(loggedEvents()).toContain("arbitration_locked");
    const logged = payloadOf("arbitration_locked");
    expect(logged.tx_hash).toBe("0xarb-lock-12345678");
    expect(logged.threshold).toBe(2);
    expect(logged.total_held_usdc).toBe(5000);
    expect(logged.arbiter_address).toBe("0xarbiter");
  });

  it("one signature does not meet the 2-of-3 threshold", async () => {
    await initArbitration(SESSION, payloadWith(5000));
    const result = await signArbitrationRelease(SESSION, "party1");

    expect(result.resolved).toBe(false);
    expect(result.txHash).toBeUndefined();
    expect(loggedEvents()).toContain("arbitration_signature_added");
    expect(loggedEvents()).not.toContain("arbitration_resolved");
  });

  it("party1 + party2 reaches the threshold and resolves", async () => {
    await initArbitration(SESSION, payloadWith(5000));
    await signArbitrationRelease(SESSION, "party1");
    const result = await signArbitrationRelease(SESSION, "party2");

    expect(result.resolved).toBe(true);
    expect(result.txHash).toBe("0xarb-resolve-12345678");
    expect(mocked.updateSessionState).toHaveBeenCalledWith(SESSION, "EXECUTED");
    expect(loggedEvents()).toContain("arbitration_resolved");
  });

  it("party1 + arbiter also reaches the threshold (2-of-3)", async () => {
    await initArbitration(SESSION, payloadWith(5000));
    await signArbitrationRelease(SESSION, "party1");
    const result = await signArbitrationRelease(SESSION, "arbiter");

    expect(result.resolved).toBe(true);
    const state = await getArbitrationState(SESSION);
    expect(state?.party1Signed).toBe(true);
    expect(state?.arbiterSigned).toBe(true);
    expect(state?.party2Signed).toBe(false);
  });

  it("party2 + arbiter also reaches the threshold (2-of-3)", async () => {
    await initArbitration(SESSION, payloadWith(5000));
    await signArbitrationRelease(SESSION, "party2");
    const result = await signArbitrationRelease(SESSION, "arbiter");
    expect(result.resolved).toBe(true);
  });

  it("signing twice as the same party is ignored", async () => {
    await initArbitration(SESSION, payloadWith(5000));
    await signArbitrationRelease(SESSION, "party1");
    const second = await signArbitrationRelease(SESSION, "party1");

    // One party must never be able to clear a 2-of-3 threshold alone.
    expect(second.resolved).toBe(false);
    expect(mocked.updateSessionState).not.toHaveBeenCalledWith(SESSION, "EXECUTED");
    expect(loggedEvents().filter((e) => e === "arbitration_signature_added")).toHaveLength(1);
  });

  it("a later signature does not clear an earlier one", async () => {
    await initArbitration(SESSION, payloadWith(5000));
    await signArbitrationRelease(SESSION, "party1");
    const mid = await getArbitrationState(SESSION);
    expect(mid?.party1Signed).toBe(true);

    await signArbitrationRelease(SESSION, "party2");
    const after = await getArbitrationState(SESSION);
    expect(after?.party1Signed).toBe(true);
    expect(after?.party2Signed).toBe(true);
  });

  it("signing after resolution replays the outcome without re-releasing", async () => {
    await initArbitration(SESSION, payloadWith(5000));
    await signArbitrationRelease(SESSION, "party1");
    await signArbitrationRelease(SESSION, "party2");
    const resolvedCalls = loggedEvents().filter((e) => e === "arbitration_resolved").length;

    const again = await signArbitrationRelease(SESSION, "arbiter");
    expect(again.resolved).toBe(true);
    expect(again.txHash).toBe("0xarb-resolve-12345678");
    expect(loggedEvents().filter((e) => e === "arbitration_resolved")).toHaveLength(resolvedCalls);
  });

  it("resolution notes are persisted with the resolution", async () => {
    await initArbitration(SESSION, payloadWith(5000));
    await signArbitrationRelease(SESSION, "party1");
    await signArbitrationRelease(SESSION, "party2", "split agreed 80/20");

    const state = await getArbitrationState(SESSION);
    expect(state?.resolutionNotes).toBe("split agreed 80/20");
    expect(state?.resolvedAt).toBeTruthy();
  });

  it("getArbitrationState returns the current tally", async () => {
    await initArbitration(SESSION, payloadWith(5000), "0xarbiter");
    const state = await getArbitrationState(SESSION);

    expect(state).not.toBeNull();
    expect(state?.locked).toBe(true);
    expect(state?.arbiterAddress).toBe("0xarbiter");
    expect(state?.threshold).toBe(2);
  });

  it("getArbitrationState returns null when nothing is locked", async () => {
    expect(await getArbitrationState(SESSION)).toBeNull();
  });

  it("signing an unlocked session throws", async () => {
    await expect(signArbitrationRelease(SESSION, "party1")).rejects.toThrow(/No arbitration/i);
  });
});

// ── Path C — Staged Release ──────────────────────────────────────────────────

const threeMilestones: MilestoneInput[] = [
  { label: "Due diligence complete", description: "Buyer review", amountCents: 200_000n, conditionType: "document" },
  { label: "Title transferred", description: "Recorded deed", amountCents: 300_000n, conditionType: "event" },
  { label: "Final walkthrough", description: "Sign-off", amountCents: 100_000n, conditionType: "manual" },
];
const TOTAL = 600_000n;

async function initThree() {
  return initStagedRelease(SESSION, threeMilestones, TOTAL);
}

/** Drive one milestone from pending through to released. */
async function fullyRelease(milestoneId: string) {
  await submitMilestoneEvidence(SESSION, milestoneId, new File(["evidence"], "memo.pdf"));
  await approveMilestone(SESSION, milestoneId, "officer@firm.com");
  return releaseMilestone(SESSION, milestoneId, "0xrecipient", "officer@firm.com");
}

describe("Path C — staged release", () => {
  it("initStagedRelease accepts milestones that sum to the escrow total", async () => {
    const state = await initThree();

    expect(state.milestones).toHaveLength(3);
    expect(state.totalCents).toBe(TOTAL);
    expect(state.releasedCents).toBe(0n);
    expect(state.remainingCents).toBe(TOTAL);
    expect(state.currentMilestoneIndex).toBe(0);
    expect(mocked.createMilestone).toHaveBeenCalledTimes(3);
  });

  it("initStagedRelease rejects a schedule that under-allocates", async () => {
    const short = threeMilestones.slice(0, 2); // 500_000 of 600_000
    await expect(initStagedRelease(SESSION, short, TOTAL)).rejects.toThrow(/must sum to the escrow total/i);
    expect(mocked.createMilestone).not.toHaveBeenCalled();
  });

  it("initStagedRelease rejects a schedule that over-allocates", async () => {
    const over = [...threeMilestones, { ...threeMilestones[0], amountCents: 50_000n }];
    await expect(initStagedRelease(SESSION, over, TOTAL)).rejects.toThrow(/must sum to the escrow total/i);
  });

  it("initStagedRelease rejects an empty schedule", async () => {
    await expect(initStagedRelease(SESSION, [], TOTAL)).rejects.toThrow(/at least one milestone/i);
  });

  it("initStagedRelease rejects a non-positive milestone amount", async () => {
    const bad: MilestoneInput[] = [
      { label: "A", description: "", amountCents: 600_000n, conditionType: "manual" },
      { label: "B", description: "", amountCents: 0n, conditionType: "manual" },
    ];
    await expect(initStagedRelease(SESSION, bad, TOTAL)).rejects.toThrow(/positive amount/i);
  });

  it("initStagedRelease rejects more than the milestone ceiling", async () => {
    const many: MilestoneInput[] = Array.from({ length: 11 }, (_, i) => ({
      label: `M${i}`,
      description: "",
      amountCents: 100n,
      conditionType: "manual" as const,
    }));
    await expect(initStagedRelease(SESSION, many, 1_100n)).rejects.toThrow(/at most 10 milestones/i);
  });

  it("initStagedRelease funds the session and records the path", async () => {
    await initThree();
    expect(mocked.setExecutionPath).toHaveBeenCalledWith(SESSION, ExecutionPath.StagedRelease);
    expect(mocked.updateSessionState).toHaveBeenCalledWith(SESSION, "FUNDED");
  });

  it("initStagedRelease logs the milestone count and deposit tx", async () => {
    await initThree();
    const logged = payloadOf("staged_release_initiated");
    expect(logged.milestone_count).toBe(3);
    expect(logged.tx_hash).toBe("0xstaged-deposit-12345678");
    expect(logged.total_usdc).toBe(6000);
  });

  it("submitMilestoneEvidence moves the milestone to submitted and records the hash", async () => {
    const state = await initThree();
    const updated = await submitMilestoneEvidence(
      SESSION,
      state.milestones[0].id,
      new File(["evidence"], "memo.pdf"),
    );

    expect(updated.status).toBe("submitted");
    expect(updated.evidenceHash).toBe("sha256:abc123");
    expect(updated.submittedAt).toBeTruthy();
    expect(payloadOf("milestone_evidence_submitted").evidence_hash).toBe("sha256:abc123");
  });

  it("approveMilestone requires submitted evidence", async () => {
    const state = await initThree();
    await expect(approveMilestone(SESSION, state.milestones[0].id, "officer@firm.com")).rejects.toThrow(
      /must have evidence submitted/i,
    );
  });

  it("approveMilestone records the human authorization without moving funds", async () => {
    const state = await initThree();
    const id = state.milestones[0].id;
    await submitMilestoneEvidence(SESSION, id, new File(["evidence"], "memo.pdf"));
    const approved = await approveMilestone(SESSION, id, "officer@firm.com");

    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).toBeTruthy();
    expect(approved.txHash).toBeUndefined();
    expect(payloadOf("milestone_approved").officer_identity).toBe("officer@firm.com");
    expect((await getStagedReleaseState(SESSION))?.releasedCents).toBe(0n);
  });

  it("releaseMilestone refuses a milestone that was never approved", async () => {
    const state = await initThree();
    const id = state.milestones[0].id;
    await submitMilestoneEvidence(SESSION, id, new File(["evidence"], "memo.pdf"));

    await expect(releaseMilestone(SESSION, id, "0xrecipient", "officer@firm.com")).rejects.toThrow(
      /must be approved/i,
    );
  });

  it("releaseMilestone generates a transaction hash and preserves the earlier trail", async () => {
    const state = await initThree();
    const id = state.milestones[0].id;
    const released = await fullyRelease(id);

    expect(released.status).toBe("released");
    expect(released.txHash).toBe(`0xmilestone-${id.slice(-8)}`);
    expect(released.releasedAt).toBeTruthy();
    // Releasing must not erase the evidence or the approval that authorized it.
    expect(released.evidenceHash).toBe("sha256:abc123");
    expect(released.submittedAt).toBeTruthy();
    expect(released.approvedAt).toBeTruthy();
  });

  it("a partial release advances the current milestone without completing the session", async () => {
    const state = await initThree();
    await fullyRelease(state.milestones[0].id);

    const after = await getStagedReleaseState(SESSION);
    expect(after?.releasedCents).toBe(200_000n);
    expect(after?.remainingCents).toBe(400_000n);
    expect(after?.currentMilestoneIndex).toBe(1);
    expect(after?.completedAt).toBeUndefined();
    expect(mocked.updateSessionState).not.toHaveBeenCalledWith(SESSION, "EXECUTED");
  });

  it("releasing every milestone marks the session EXECUTED", async () => {
    const state = await initThree();
    for (const m of state.milestones) await fullyRelease(m.id);

    expect(mocked.updateSessionState).toHaveBeenCalledWith(SESSION, "EXECUTED");
    expect(loggedEvents()).toContain("staged_release_completed");

    const final = await getStagedReleaseState(SESSION);
    expect(final?.releasedCents).toBe(TOTAL);
    expect(final?.remainingCents).toBe(0n);
    expect(final?.currentMilestoneIndex).toBe(3);
    expect(final?.completedAt).toBeTruthy();
  });

  it("milestone_released logs the amount, recipient and running totals", async () => {
    const state = await initThree();
    await fullyRelease(state.milestones[0].id);

    const logged = payloadOf("milestone_released");
    expect(logged.amount_usdc).toBe(2000);
    expect(logged.recipient).toBe("0xrecipient");
    expect(logged.released_total_usdc).toBe(2000);
    expect(logged.remaining_usdc).toBe(4000);
  });

  it("getStagedReleaseState returns computed totals in definition order", async () => {
    await initThree();
    const state = await getStagedReleaseState(SESSION);

    expect(state?.milestones.map((m) => m.label)).toEqual([
      "Due diligence complete",
      "Title transferred",
      "Final walkthrough",
    ]);
    expect(state?.totalCents).toBe(TOTAL);
    expect(state?.milestones[0].amountCents).toBe(200_000n);
  });

  it("getStagedReleaseState returns null before any milestone exists", async () => {
    expect(await getStagedReleaseState(SESSION)).toBeNull();
  });

  it("evidence cannot be resubmitted against a released milestone", async () => {
    const state = await initThree();
    const id = state.milestones[0].id;
    await fullyRelease(id);

    await expect(
      submitMilestoneEvidence(SESSION, id, new File(["again"], "memo2.pdf")),
    ).rejects.toThrow(/already been released/i);
  });
});
