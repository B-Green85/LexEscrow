// @vitest-environment jsdom
/**
 * Session 4 — correction audit trail (spec §32).
 *
 * Drives the real session store (against the in-memory backend fallback) rather
 * than asserting on mocks, because the thing worth proving is end-to-end: that
 * confirming an escalation actually writes the officer's value into the payload
 * *and* lands a HUMAN_CORRECTION entry on the hash chain with every AI attempt
 * attached. A component test cannot show that; only the wiring can.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useSession } from "./session";
import * as backend from "../lib/backend";
import { primeVDB } from "../lexguard/vdb";
import { ExecutionPath, type ParsedRetainerPayload, type TrustAnchors } from "../lexguard/types";
import type { Escalation, LexGuardCorrection } from "../lexguard/pipeline";

const DOC = [
  "BILLING RECONCILIATION",
  "Total Retainer Held: $5,000.00",
  "Earned Fees: $800.00",
  "Unearned Balance: $4,200.00",
].join("\n");

const anchors: TrustAnchors = {
  attorneyBarNumber: "123456",
  state: "California",
  clientFullLegalName: "Jane Anderson",
  clientEmail: "client@example.com",
};

function payload(overrides: Partial<ParsedRetainerPayload> = {}): ParsedRetainerPayload {
  return {
    clientId: "C-1",
    lawFirmWallet: "0xFirm",
    clientWallet: "0xClient",
    totalHeld: 5000,
    earnedFees: 800,
    unearnedBalance: 3200,
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

const escalation: Escalation = {
  module: "payload-diff",
  field: "unearnedBalance",
  fieldLabel: "Unearned Balance",
  aiValue: "$3,200.00",
  observedValue: "$4,200.00",
  recommendation: "Review the billing records section.",
  documentExtractedValue: 4200,
  correctionField: "unearnedBalance",
  aiAttempt1: 3200,
  aiAttempt2: 3200,
  aiAttempt3: 3200,
  additionalDiscrepancies: [],
};

/** Seed a session mid-escalation, exactly as the pipeline would have left it. */
async function seedSession(overrides: Record<string, unknown> = {}) {
  const sessionId = `wf-audit-${Math.random().toString(36).slice(2)}`;
  const vdb = await primeVDB(DOC, "sha256:x", sessionId);
  useSession.setState({
    sessionId,
    vdb,
    anchors,
    payload: payload(),
    escalation,
    corrections: [],
    entryMode: "ai",
    operator: "jane.doe@brownlaw.com",
    screen: "escalation",
    ...overrides,
  });
  return sessionId;
}

const eventsOfType = async (sessionId: string, type: string) =>
  (await backend.getAuditTrail(sessionId))
    .filter((e) => e.eventType === type)
    .map((e) => JSON.parse(e.payloadJson) as Record<string, unknown>);

beforeEach(() => {
  useSession.setState({ corrections: [], escalation: null, error: null, busy: false });
});

describe("HUMAN_CORRECTION", () => {
  it("writes the officer's value into the payload and clears the escalation", async () => {
    await seedSession();
    await useSession.getState().resolveEscalationWithCorrections([
      { field: "unearnedBalance", value: 4200 },
    ]);

    const state = useSession.getState();
    expect(state.payload?.unearnedBalance).toBe(4200);
    expect(state.escalation).toBeNull();
  });

  it("lands a HUMAN_CORRECTION entry carrying all three AI attempts, in cents", async () => {
    const sessionId = await seedSession();
    await useSession.getState().resolveEscalationWithCorrections([
      { field: "unearnedBalance", value: 4200 },
    ]);

    const [entry] = await eventsOfType(sessionId, "HUMAN_CORRECTION");
    expect(entry).toMatchObject({
      field: "unearnedBalance",
      lexguard_module: "payload-diff",
      document_extracted_value: 420000,
      ai_attempt_1: 320000,
      ai_attempt_2: 320000,
      ai_attempt_3: 320000,
      officer_corrected_value: 420000,
      officer_identity: "jane.doe@brownlaw.com",
      attestation: true,
    });
    expect(entry.block_timestamp).toBeTruthy();
    expect(entry.constraint).toContain("unearnedBalance");
  });

  it("routes to review once the corrected payload validates clean", async () => {
    await seedSession();
    await useSession.getState().resolveEscalationWithCorrections([
      { field: "unearnedBalance", value: 4200 },
    ]);

    const state = useSession.getState();
    expect(state.screen).toBe("review");
    // Stage 4's gate is fresh — the officer has not reviewed this payload yet.
    expect(state.acknowledged).toBe(false);
    expect(state.scrollCompleted).toBe(false);
  });

  it("escalates again when the officer's value introduces a new discrepancy", async () => {
    await seedSession();
    // 800 + 900 ≠ 5000 — the correction fixes nothing and breaks arithmetic.
    await useSession.getState().resolveEscalationWithCorrections([
      { field: "unearnedBalance", value: 900 },
    ]);

    const state = useSession.getState();
    expect(state.screen).toBe("escalation");
    expect(state.escalation).not.toBeNull();
    // The officer's value was preserved, not reverted.
    expect(state.payload?.unearnedBalance).toBe(900);
  });

  it("logs one entry per field for a multi-field cascade", async () => {
    const sessionId = await seedSession({
      escalation: {
        ...escalation,
        additionalDiscrepancies: [
          {
            field: "clientName",
            module: "anchor-matcher",
            aiValue: "Jane Andersen",
            observedValue: "Jane Anderson",
            correctionField: "clientName",
          },
        ],
      },
    });

    await useSession.getState().resolveEscalationWithCorrections([
      { field: "unearnedBalance", value: 4200 },
      { field: "clientName", value: "Jane Anderson" },
    ]);

    const entries = await eventsOfType(sessionId, "HUMAN_CORRECTION");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.lexguard_module)).toEqual(["payload-diff", "anchor-matcher"]);
    // Non-money fields are audited as-is, not converted to cents.
    expect(entries[1].officer_corrected_value).toBe("Jane Anderson");
  });
});

describe("HUMAN_OVERRIDE", () => {
  const applied: LexGuardCorrection = {
    module: "payload-diff",
    field: "unearnedBalance",
    aiValue: 3200,
    observedValue: 4200,
    nudgeCount: 1,
    resolved: true,
    timestamp: new Date("2026-07-18T12:00:00Z").toISOString(),
  };

  it("applies the override and records the reason against the officer's identity", async () => {
    const sessionId = await seedSession({
      escalation: null,
      corrections: [applied],
      payload: payload({ unearnedBalance: 4200 }),
      screen: "review",
    });

    await useSession.getState().applyHumanOverride({
      field: "unearnedBalance",
      overrideValue: 4150,
      reason: "Per wire confirmation addendum — supersedes retainer figure",
    });

    const [entry] = await eventsOfType(sessionId, "HUMAN_OVERRIDE");
    expect(entry).toMatchObject({
      field: "unearnedBalance",
      lexguard_module: "payload-diff",
      lexguard_corrected_value: 420000,
      officer_override_value: 415000,
      override_reason: "Per wire confirmation addendum — supersedes retainer figure",
      officer_identity: "jane.doe@brownlaw.com",
    });
  });

  it("resets the Stage 4 scroll and acknowledgment gate", async () => {
    await seedSession({
      escalation: null,
      corrections: [applied],
      payload: payload({ unearnedBalance: 4200 }),
      screen: "review",
      scrollCompleted: true,
      acknowledged: true,
    });

    await useSession.getState().applyHumanOverride({
      field: "unearnedBalance",
      overrideValue: 4200,
      reason: "confirmed against the addendum",
    });

    const state = useSession.getState();
    expect(state.scrollCompleted).toBe(false);
    expect(state.acknowledged).toBe(false);
  });

  it("keeps LexGuard running — an override that breaks arithmetic escalates", async () => {
    await seedSession({
      escalation: null,
      corrections: [applied],
      payload: payload({ unearnedBalance: 4200 }),
      screen: "review",
    });

    await useSession.getState().applyHumanOverride({
      field: "unearnedBalance",
      overrideValue: 4150, // 800 + 4150 ≠ 5000
      reason: "wire confirmation",
    });

    expect(useSession.getState().screen).toBe("escalation");
  });

  it("is a distinct event type from HUMAN_CORRECTION", async () => {
    const sessionId = await seedSession({
      escalation: null,
      corrections: [applied],
      payload: payload({ unearnedBalance: 4200 }),
      screen: "review",
    });

    await useSession.getState().applyHumanOverride({
      field: "unearnedBalance",
      overrideValue: 4200,
      reason: "confirmed",
    });

    expect(await eventsOfType(sessionId, "HUMAN_OVERRIDE")).toHaveLength(1);
    expect(await eventsOfType(sessionId, "HUMAN_CORRECTION")).toHaveLength(0);
  });
});

describe("audit chain integrity", () => {
  it("keeps the hash chain verifiable across correction and override events", async () => {
    const sessionId = await seedSession();
    await useSession.getState().resolveEscalationWithCorrections([
      { field: "unearnedBalance", value: 4200 },
    ]);
    await useSession.getState().applyHumanOverride({
      field: "unearnedBalance",
      overrideValue: 4200,
      reason: "re-confirmed against the source document",
    });

    const trail = await backend.getAuditTrail(sessionId);
    expect(trail.length).toBeGreaterThan(0);
    expect(await backend.verifyAuditChain()).toMatchObject({ valid: true });
  });
});
