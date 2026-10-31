// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

import { describe, it, expect } from "vitest";
import { runLexGuardPipeline } from "./pipeline";
import { primeVDB } from "./vdb";
import { ExecutionPath, type ParsedRetainerPayload, type TrustAnchors } from "./types";
import { type AIParserProvider } from "../lib/ai/providers";

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
    unearnedBalance: 4200,
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

/** Stub provider — the pipeline only calls `correct`; `parse` is a placeholder. */
function stub(correct: AIParserProvider["correct"]): AIParserProvider {
  return { label: "stub", parse: async () => payload(), correct };
}

describe("runLexGuardPipeline nudge loop", () => {
  it("catches a numeric discrepancy, nudges once, and resolves", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    let calls = 0;
    // AI extracted $3,200 but the document/VDB says $4,200; AI fixes on nudge.
    const provider = stub(async (_field, _current, sentinel) => {
      calls++;
      return sentinel;
    });
    const result = await runLexGuardPipeline({
      payload: payload({ unearnedBalance: 3200 }),
      vdb,
      anchors,
      chainlinkVerifiedBar: "123456",
      provider,
    });
    expect(calls).toBe(1);
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0].resolved).toBe(true);
    expect(result.payload.unearnedBalance).toBe(4200);
    expect(result.escalation).toBeNull();
  });

  it("escalates after 3 nudges when the AI will not correct", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    let calls = 0;
    const provider = stub(async () => {
      calls++;
      return 3200; // keeps returning the wrong value
    });
    const result = await runLexGuardPipeline({
      payload: payload({ unearnedBalance: 3200 }),
      vdb,
      anchors,
      chainlinkVerifiedBar: "123456",
      provider,
    });
    expect(calls).toBe(3);
    expect(result.corrections).toHaveLength(3);
    expect(result.escalation).not.toBeNull();
    expect(result.escalation?.fieldLabel).toBe("Unearned Balance");
    expect(result.payload.unearnedBalance).toBe(3200);
  });

  it("passes a consistent extraction with no nudges", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    let calls = 0;
    const provider = stub(async () => {
      calls++;
      return null;
    });
    const result = await runLexGuardPipeline({
      payload: payload(),
      vdb,
      anchors,
      chainlinkVerifiedBar: "123456",
      provider,
    });
    expect(calls).toBe(0);
    expect(result.corrections).toHaveLength(0);
    expect(result.escalation).toBeNull();
  });

  it("escalates on broken arithmetic that is not nudgeable", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const provider = stub(async (_f, _c, s) => s);
    // unearned matches the doc but earned makes the sum wrong (900 + 4200 ≠ 5000).
    const result = await runLexGuardPipeline({
      payload: payload({ earnedFees: 900 }),
      vdb,
      anchors,
      chainlinkVerifiedBar: "123456",
      provider,
    });
    expect(result.escalation?.field).toBe("arithmetic");
  });
});
