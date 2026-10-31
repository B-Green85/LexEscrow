// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Session 4 — escalation extension (spec §29, §31).
 *
 * Covers the fields the correction dialog depends on: every AI nudge attempt,
 * LexGuard's independent extraction, and the additional discrepancies that turn
 * a single escalation into a multi-field cascade.
 */

import { describe, it, expect } from "vitest";
import { runLexGuardPipeline } from "./pipeline";
import { primeVDB } from "./vdb";
import { ExecutionPath, type ParsedRetainerPayload, type TrustAnchors } from "./types";
import { type AIParserProvider } from "../lib/ai/providers";
import { escalationFindings } from "../lib/corrections";

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

function stub(correct: AIParserProvider["correct"]): AIParserProvider {
  return { label: "stub", parse: async () => payload(), correct };
}

const run = (p: ParsedRetainerPayload, provider: AIParserProvider, vdb: Awaited<ReturnType<typeof primeVDB>>) =>
  runLexGuardPipeline({ payload: p, vdb, anchors, chainlinkVerifiedBar: "123456", provider });

describe("Escalation — AI nudge attempts", () => {
  it("records all three attempts when AI is consistently wrong", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(payload({ unearnedBalance: 3200 }), stub(async () => 3200), vdb);

    expect(result.escalation?.aiAttempt1).toBe(3200);
    expect(result.escalation?.aiAttempt2).toBe(3200);
    expect(result.escalation?.aiAttempt3).toBe(3200);
  });

  it("records an oscillating AI as three distinct attempt values", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const sequence = [3300, 3400, 3500];
    let i = 0;
    const result = await run(payload({ unearnedBalance: 3200 }), stub(async () => sequence[i++]), vdb);

    // The officer must be able to tell "stuck" from "guessing" at a glance.
    expect(result.escalation?.aiAttempt1).toBe(3300);
    expect(result.escalation?.aiAttempt2).toBe(3400);
    expect(result.escalation?.aiAttempt3).toBe(3500);
  });

  it("leaves later attempts undefined when the correction transport fails", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    // A null correction breaks the loop after one attempt — nudges 2 and 3
    // never happened, and must not be rendered as if they had.
    const result = await run(payload({ unearnedBalance: 3200 }), stub(async () => null), vdb);

    expect(result.escalation).not.toBeNull();
    expect(result.escalation?.aiAttempt1).toBeUndefined();
    expect(result.escalation?.aiAttempt2).toBeUndefined();
    expect(result.escalation?.aiAttempt3).toBeUndefined();
  });

  it("records no attempts for a discrepancy the nudge loop never touches", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    // Bar mismatch is not nudgeable — there is nothing for AI to re-extract.
    const result = await run(
      payload({ extractedBarNumber: "999999" }),
      stub(async (_f, _c, s) => s),
      vdb,
    );

    expect(result.escalation?.field).toBe("barNumber");
    expect(result.escalation?.aiAttempt1).toBeUndefined();
  });
});

describe("Escalation — documentExtractedValue", () => {
  it("matches the observedValue LexGuard held at escalation point", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(payload({ unearnedBalance: 3200 }), stub(async () => 3200), vdb);

    // Raw, not formatted — the dialog pre-fills an editable input from it.
    expect(result.escalation?.documentExtractedValue).toBe(4200);
    expect(result.escalation?.observedValue).toBe("$4,200.00");
  });

  it("carries the total held for an arithmetic escalation", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(payload({ earnedFees: 900 }), stub(async (_f, _c, s) => s), vdb);

    expect(result.escalation?.field).toBe("arithmetic");
    expect(result.escalation?.documentExtractedValue).toBe(5000);
    // Arithmetic is a constraint, not a field — corrections target the total.
    expect(result.escalation?.correctionField).toBe("totalHeld");
  });

  it("carries the trust anchor for an anchor-matcher escalation", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(
      payload({ clientName: "Someone Else" }),
      stub(async (_f, _c, s) => s),
      vdb,
    );

    expect(result.escalation?.module).toBe("anchor-matcher");
    expect(result.escalation?.documentExtractedValue).toBe("Jane Anderson");
  });
});

describe("Escalation — additionalDiscrepancies", () => {
  it("is empty when only one module fires", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(
      payload({ clientName: "Someone Else" }),
      stub(async (_f, _c, s) => s),
      vdb,
    );

    expect(result.escalation?.additionalDiscrepancies).toEqual([]);
  });

  it("collects the arithmetic break that rides along with a numeric discrepancy", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    // unearned stuck at 3200 also breaks 800 + 3200 = 5000.
    const result = await run(payload({ unearnedBalance: 3200 }), stub(async () => 3200), vdb);

    expect(result.escalation?.field).toBe("unearnedBalance");
    const extra = result.escalation?.additionalDiscrepancies ?? [];
    expect(extra.map((d) => d.field)).toContain("arithmetic");
  });

  it("collects discrepancies from several modules at once", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(
      payload({ unearnedBalance: 3200, clientName: "Someone Else", extractedBarNumber: "999999" }),
      stub(async () => 3200),
      vdb,
    );

    const findings = escalationFindings(result.escalation!);
    const fields = findings.map((f) => f.field);
    expect(fields).toContain("unearnedBalance");
    expect(fields).toContain("arithmetic");
    expect(fields).toContain("barNumber");
    expect(fields).toContain("clientName");
    expect(findings.length).toBeGreaterThanOrEqual(4);
  });

  it("gives every additional discrepancy its own module attribution", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(
      payload({ unearnedBalance: 3200, clientName: "Someone Else" }),
      stub(async () => 3200),
      vdb,
    );

    const byField = new Map(
      escalationFindings(result.escalation!).map((f) => [f.field, f.module]),
    );
    expect(byField.get("unearnedBalance")).toBe("payload-diff");
    expect(byField.get("clientName")).toBe("anchor-matcher");
  });

  it("propagates nudge attempts onto the primary finding only", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(payload({ unearnedBalance: 3200 }), stub(async () => 3200), vdb);

    const findings = escalationFindings(result.escalation!);
    const arithmetic = findings.find((f) => f.field === "arithmetic");
    // Only unearnedBalance was nudged; the arithmetic finding never was.
    expect(findings[0].aiAttempt1).toBe(3200);
    expect(arithmetic?.aiAttempt1).toBeUndefined();
  });

  it("returns no escalation at all for a clean payload", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(payload(), stub(async () => null), vdb);
    expect(result.escalation).toBeNull();
  });
});

describe("Escalation — existing pipeline behaviour is unchanged", () => {
  it("still resolves a single nudge without escalating", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(
      payload({ unearnedBalance: 3200 }),
      stub(async (_f, _c, sentinel) => sentinel),
      vdb,
    );

    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0].resolved).toBe(true);
    expect(result.payload.unearnedBalance).toBe(4200);
    expect(result.escalation).toBeNull();
  });

  it("still escalates at exactly three nudges, not before", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    let calls = 0;
    const result = await run(
      payload({ unearnedBalance: 3200 }),
      stub(async () => {
        calls++;
        return 3200;
      }),
      vdb,
    );

    expect(calls).toBe(3);
    expect(result.corrections).toHaveLength(3);
    expect(result.escalation?.fieldLabel).toBe("Unearned Balance");
  });

  it("still reports the legacy display fields on the primary escalation", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const result = await run(payload({ unearnedBalance: 3200 }), stub(async () => 3200), vdb);

    expect(result.escalation?.module).toBe("payload-diff");
    expect(result.escalation?.aiValue).toBe("$3,200.00");
    expect(result.escalation?.recommendation).toContain("billing records");
  });
});
