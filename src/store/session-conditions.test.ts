// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

// @vitest-environment jsdom
/**
 * Session 7 — condition tracking wiring (spec §6 Stages 6–7).
 *
 * Drives the real session store against the in-memory backend fallback rather
 * than asserting on mocks. The pure builder is tested next to itself in
 * `lib/conditions`; what is worth proving *here* is the wiring — that arriving
 * at Stage 4 actually persists a checklist, that recording a deposit actually
 * lands `funds_deposited` on the hash chain and starts the sweep, and above all
 * that the 30-second re-derivation cannot quietly undo a human's decision.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSession } from "./session";
import * as backend from "../lib/backend";
import { ExecutionPath, type ParsedRetainerPayload } from "../lexguard/types";
import type { AnchorReceipt } from "../lib/anchor-receipt";
import type { ESignEnvelope, ESignStatus } from "../lib/esign";

/**
 * Let the store's fire-and-forget persistence settle.
 *
 * Several ticks, not one: audit appends are serialized behind a lock and each
 * one performs a real SHA-256 through Web Crypto, so a single macrotask is not
 * enough for a chain of them to land.
 */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function payload(overrides: Partial<ParsedRetainerPayload> = {}): ParsedRetainerPayload {
  return {
    clientId: "C-1",
    lawFirmWallet: "0xFirm",
    clientWallet: "0xClient",
    totalHeld: 18_500,
    earnedFees: 6_000,
    unearnedBalance: 12_500,
    disputedHours: 0,
    disputedAmount: 0,
    signaturesVerified: true,
    recommendedPath: ExecutionPath.DirectSettlement,
    anomaliesFlagged: [],
    anomaliesSuppressed: false,
    barNumber: "123456",
    clientName: "Jane Anderson",
    extractedBarNumber: null,
    ...overrides,
  };
}

function receipt(sessionId: string): AnchorReceipt {
  return {
    receiptId: "r-1",
    issuedAt: "2026-07-18T10:00:00Z",
    assertionType: "escrow_document_registration",
    transactionId: sessionId,
    assetClass: "legal",
    summary: { overallStatus: "verified_all", verifiedCount: 1, totalCount: 1 },
    items: [
      {
        label: "retainer.pdf",
        hmac: "seal-1",
        hash: "sha256:" + "a".repeat(64),
        size: 2048,
        registered: true,
        registeredAt: "2026-07-18T10:00:00Z",
        onChainTx: "0xanchor-abc",
      },
    ],
    assertionText: "…",
    receiptHash: "b".repeat(64),
  };
}

function envelope(sessionId: string, status: ESignStatus): ESignEnvelope {
  return {
    envelopeId: "env-1",
    sessionId,
    documentLabel: "retainer.pdf",
    signers: [{ name: "Jane Anderson", email: "jane@example.com", role: "Client", routingOrder: 1 }],
    status,
    sentAt: "2026-07-18T10:00:00Z",
  };
}

let sessionId: string;

/** Seed a legal session that has finished processing, as the pipeline leaves it. */
function seed(overrides: Record<string, unknown> = {}) {
  sessionId = `wf-cond-${Math.random().toString(36).slice(2)}`;
  useSession.setState({
    sessionId,
    assetClass: "legal",
    payload: payload(),
    rawAnchors: {},
    anchorReceipt: receipt(sessionId),
    eSignEnvelopes: [],
    cannaVerifyConditions: null,
    barActive: true,
    conditions: [],
    conditionSummary: { total: 0, met: 0, pending: 0, failed: 0, allMet: false },
    fundsDeposited: false,
    depositTxHash: null,
    escrowBalance: 0n,
    conditionPolling: false,
    conditionPollTimer: null,
    error: null,
    ...overrides,
  });
  return sessionId;
}

const events = async () =>
  (await backend.getAuditTrail(sessionId)).map((e) => e.eventType);

const eventPayload = async (type: string) => {
  const entry = (await backend.getAuditTrail(sessionId)).find((e) => e.eventType === type);
  return entry ? JSON.parse(entry.payloadJson) : null;
};

beforeEach(() => seed());
afterEach(() => useSession.getState().stopConditionPolling());

// ── initConditions ───────────────────────────────────────────────────────────

describe("initConditions", () => {
  it("builds the checklist and persists every condition", async () => {
    useSession.getState().initConditions();
    await flush();

    const { conditions, conditionSummary } = useSession.getState();
    // Legal + a registered receipt = a document condition and a bar condition.
    expect(conditions.map((c) => c.type).sort()).toEqual(["bar_verify", "document"]);
    expect(conditionSummary).toMatchObject({ total: 2, met: 2, allMet: true });

    const stored = await backend.getConditions(sessionId);
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.sessionId === sessionId)).toBe(true);
  });

  it("stores the type-specific metadata alongside each row", async () => {
    useSession.getState().initConditions();
    await flush();

    const doc = (await backend.getConditions(sessionId)).find((r) => r.conditionType === "document");
    expect(doc).toBeDefined();
    expect(JSON.parse(doc!.metadataJson!)).toMatchObject({
      documentLabel: "retainer.pdf",
      assetClass: "legal",
    });
  });

  it("is reached by navigating to the Condition Definition screen", async () => {
    useSession.getState().navigateToConditions();
    await flush();
    expect(useSession.getState().screen).toBe("conditions");
    expect(useSession.getState().conditions.length).toBeGreaterThan(0);
  });

  it("does nothing without a parsed payload", () => {
    seed({ payload: null });
    useSession.getState().initConditions();
    expect(useSession.getState().conditions).toEqual([]);
  });
});

// ── Fund custody ─────────────────────────────────────────────────────────────

describe("confirmFundsDeposited", () => {
  it("records the deposit, the balance and the audit entry", async () => {
    useSession.getState().initConditions();
    useSession.getState().confirmFundsDeposited("  0xdeposit-9  ");
    await flush();

    const state = useSession.getState();
    expect(state.fundsDeposited).toBe(true);
    // Trimmed, and denominated in integer cents from the payload total.
    expect(state.depositTxHash).toBe("0xdeposit-9");
    expect(state.escrowBalance).toBe(1_850_000n);

    expect(await events()).toContain("funds_deposited");
    expect(await eventPayload("funds_deposited")).toMatchObject({
      tx_hash: "0xdeposit-9",
      amount_usdc: 18_500,
    });
  });

  it("refuses a blank transaction hash", () => {
    useSession.getState().confirmFundsDeposited("   ");
    const state = useSession.getState();
    expect(state.fundsDeposited).toBe(false);
    expect(state.error).toMatch(/deposit transaction hash/i);
  });

  it("starts the condition sweep while conditions remain unmet", () => {
    seed({ barActive: null }); // bar verification pending → not allMet
    useSession.getState().initConditions();
    useSession.getState().confirmFundsDeposited("0xdeposit-1");
    expect(useSession.getState().conditionPolling).toBe(true);
    expect(useSession.getState().conditionPollTimer).not.toBeNull();
  });

  it("does not start a sweep when there is nothing left to watch", () => {
    useSession.getState().initConditions(); // everything already met
    useSession.getState().confirmFundsDeposited("0xdeposit-1");
    expect(useSession.getState().conditionPolling).toBe(false);
  });
});

// ── updateConditions ─────────────────────────────────────────────────────────

describe("updateConditions", () => {
  it("picks up an envelope status change and persists it", async () => {
    seed({ eSignEnvelopes: [envelope(sessionId, "sent")] });
    useSession.getState().initConditions();
    await flush();

    const esignId = useSession.getState().conditions.find((c) => c.type === "esign")!.id;
    expect(useSession.getState().conditions.find((c) => c.id === esignId)!.status).toBe(
      "in_progress",
    );

    // The envelope completes; the sweep re-derives.
    useSession.setState({ eSignEnvelopes: [envelope(sessionId, "completed")] });
    useSession.getState().updateConditions();
    await flush();

    expect(useSession.getState().conditions.find((c) => c.id === esignId)!.status).toBe("met");
    const stored = (await backend.getConditions(sessionId)).find((r) => r.conditionId === esignId);
    expect(stored!.status).toBe("met");
    expect(await events()).toContain("condition_status_changed");
  });

  it("does not duplicate conditions across repeated sweeps", async () => {
    useSession.getState().initConditions();
    await flush();
    for (let i = 0; i < 3; i++) useSession.getState().updateConditions();
    await flush();

    expect(useSession.getState().conditions).toHaveLength(2);
    expect(await backend.getConditions(sessionId)).toHaveLength(2);
  });

  it("stops the sweep once everything is met", async () => {
    seed({ eSignEnvelopes: [envelope(sessionId, "sent")] });
    useSession.getState().initConditions();
    useSession.getState().confirmFundsDeposited("0xdeposit-1");
    expect(useSession.getState().conditionPolling).toBe(true);

    useSession.setState({ eSignEnvelopes: [envelope(sessionId, "completed")] });
    useSession.getState().updateConditions();
    await flush();

    expect(useSession.getState().conditionSummary.allMet).toBe(true);
    // The sweep itself calls stopConditionPolling on the tick that closes the
    // last gate; proceeding to settlement also clears it.
    await useSession.getState().proceedToSettlement();
    expect(useSession.getState().conditionPolling).toBe(false);
  });
});

// ── Human decisions survive the sweep ────────────────────────────────────────

describe("human decisions", () => {
  it("waives a condition, logs the reason, and flips allMet", async () => {
    seed({ barActive: null });
    useSession.getState().initConditions();
    await flush();
    expect(useSession.getState().conditionSummary.allMet).toBe(false);

    const barId = useSession.getState().conditions.find((c) => c.type === "bar_verify")!.id;
    useSession.getState().waiveCondition(barId, "Verified by phone with the state bar");
    await flush();

    expect(useSession.getState().conditionSummary.allMet).toBe(true);
    // A waiver is resolved, not verified — it must not inflate the met count.
    expect(useSession.getState().conditionSummary.met).toBe(1);
    expect(await eventPayload("condition_waived")).toMatchObject({
      condition_id: barId,
      waiver_reason: "Verified by phone with the state bar",
    });
  });

  it("does not let a later sweep revoke a waiver", async () => {
    seed({ barActive: false }); // bar verification actively failed
    useSession.getState().initConditions();
    await flush();

    const barId = useSession.getState().conditions.find((c) => c.type === "bar_verify")!.id;
    useSession.getState().waiveCondition(barId, "Standing confirmed out of band");
    expect(useSession.getState().conditions.find((c) => c.id === barId)!.status).toBe("waived");

    // This is the regression that matters: the builder still says `failed`.
    useSession.getState().updateConditions();
    await flush();

    expect(useSession.getState().conditions.find((c) => c.id === barId)!.status).toBe("waived");
    expect(useSession.getState().conditionSummary.allMet).toBe(true);
  });

  it("does not let a later sweep undo a manual confirmation", async () => {
    seed({ assetClass: "business", barActive: null });
    useSession.getState().initConditions();
    await flush();

    const manualId = useSession.getState().conditions.find((c) => c.type === "manual")!.id;
    useSession.getState().markConditionMet(manualId);
    await flush();
    expect(useSession.getState().conditions.find((c) => c.id === manualId)!.status).toBe("met");
    expect(await events()).toContain("condition_manually_confirmed");

    // The builder always emits `pending` for a manual condition.
    useSession.getState().updateConditions();
    await flush();
    expect(useSession.getState().conditions.find((c) => c.id === manualId)!.status).toBe("met");
  });

  it("refuses to hand-mark a machine-verified condition", async () => {
    useSession.getState().initConditions();
    await flush();
    seed({ barActive: null });
    useSession.getState().initConditions();
    await flush();

    const barId = useSession.getState().conditions.find((c) => c.type === "bar_verify")!.id;
    useSession.getState().markConditionMet(barId);

    // Overriding a verified gate is a waiver, and must be recorded as one.
    expect(useSession.getState().conditions.find((c) => c.id === barId)!.status).toBe("pending");
  });
});

// ── Settlement gate ──────────────────────────────────────────────────────────

describe("proceedToSettlement", () => {
  it("refuses before the escrow is funded", async () => {
    useSession.getState().initConditions();
    await useSession.getState().proceedToSettlement();
    expect(useSession.getState().error).toMatch(/deposit/i);
    expect(useSession.getState().screen).not.toBe("execution");
  });

  it("refuses while a condition is unmet, naming the count", async () => {
    seed({ barActive: null });
    useSession.getState().initConditions();
    useSession.getState().confirmFundsDeposited("0xdeposit-1");
    await useSession.getState().proceedToSettlement();

    expect(useSession.getState().error).toMatch(/1 condition\(s\) are still unmet/);
    expect(useSession.getState().screen).not.toBe("execution");
  });

  it("refuses when no conditions were ever defined", async () => {
    seed({ anchorReceipt: null, assetClass: "art" }); // no conditions for this shape
    useSession.getState().initConditions();
    useSession.setState({ fundsDeposited: true });
    await useSession.getState().proceedToSettlement();

    expect(useSession.getState().error).toMatch(/nothing has been verified/i);
  });

  it("logs conditions_all_met once the gate opens", async () => {
    useSession.getState().initConditions();
    useSession.getState().confirmFundsDeposited("0xdeposit-1");
    await flush();

    expect(useSession.getState().conditionSummary.allMet).toBe(true);
    await useSession.getState().proceedToSettlement();
    await flush();

    expect(await events()).toContain("conditions_all_met");
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("clears the checklist, the custody state and the sweep timer", async () => {
    seed({ barActive: null });
    useSession.getState().initConditions();
    useSession.getState().confirmFundsDeposited("0xdeposit-1");
    await flush();
    expect(useSession.getState().conditionPollTimer).not.toBeNull();

    useSession.getState().reset();

    const state = useSession.getState();
    expect(state.conditions).toEqual([]);
    expect(state.conditionSummary).toEqual({
      total: 0,
      met: 0,
      pending: 0,
      failed: 0,
      allMet: false,
    });
    expect(state.fundsDeposited).toBe(false);
    expect(state.depositTxHash).toBeNull();
    expect(state.escrowBalance).toBe(0n);
    expect(state.conditionPollTimer).toBeNull();
  });
});
