// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

import { describe, it, expect } from "vitest";
import {
  toCents,
  fromCents,
  formatUsd,
  toPayloadCents,
  validateArithmetic,
  diffNumericFields,
  diffNumericsWithVDB,
} from "./payload-diff";
import { primeVDB } from "./vdb";
import { ExecutionPath, type ParsedRetainerPayload } from "./types";

function payload(overrides: Partial<ParsedRetainerPayload> = {}): ParsedRetainerPayload {
  return {
    clientId: "C-001",
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
    ...overrides,
  };
}

describe("integer-cents conversion", () => {
  it("converts dollars to exact integer cents", () => {
    expect(toCents(4200)).toBe(420000n);
    expect(toCents(4200.99)).toBe(420099n);
    expect(fromCents(420000n)).toBe(4200);
  });

  it("formats integer cents as USD without floating point", () => {
    expect(formatUsd(420000n)).toBe("$4,200.00");
    expect(formatUsd(0n)).toBe("$0.00");
    expect(formatUsd(100050n)).toBe("$1,000.50");
    expect(formatUsd(-500n)).toBe("-$5.00");
    expect(formatUsd(123456789n)).toBe("$1,234,567.89");
  });

  it("projects a payload to canonical integer cents", () => {
    const c = toPayloadCents(payload());
    expect(c.totalHeldCents).toBe(500000n);
    expect(c.earnedFeesCents).toBe(80000n);
    expect(c.unearnedBalanceCents).toBe(420000n);
    expect(typeof c.totalHeldCents).toBe("bigint");
  });
});

describe("validateArithmetic (BigInt, exact)", () => {
  it("passes when earned + unearned === total", () => {
    expect(validateArithmetic(payload())).toBe(true);
  });

  it("is immune to IEEE-754 drift that breaks naive float math", () => {
    // 0.1 + 0.2 !== 0.3 in float, but the cents check must pass.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(validateArithmetic(payload({ earnedFees: 0.1, unearnedBalance: 0.2, totalHeld: 0.3 }))).toBe(true);
  });

  it("fails on a genuine one-cent mismatch", () => {
    expect(validateArithmetic(payload({ totalHeld: 5000.01 }))).toBe(false);
  });
});

describe("diffNumericFields", () => {
  it("returns no diffs when AI matches observed", () => {
    expect(diffNumericFields(payload(), { unearnedBalance: 4200, earnedFees: 800 })).toEqual([]);
  });

  it("flags a numeric discrepancy in cents", () => {
    const diffs = diffNumericFields(payload(), { unearnedBalance: 4300 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe("unearnedBalance");
    expect(diffs[0].aiValue).toBe(4200);
    expect(diffs[0].observedValue).toBe(4300);
    expect(diffs[0].discrepancy).toBe(true);
  });
});

describe("diffNumericsWithVDB", () => {
  const SAMPLE = [
    "BILLING RECONCILIATION",
    "Total Retainer Held: $5,000.00",
    "Earned Fees: $800.00",
    "Unearned Balance: $4,200.00",
  ].join("\n");

  it("clears a correct payload against the VDB", async () => {
    const vdb = await primeVDB(SAMPLE, "sha256:abc", "s1");
    expect(diffNumericsWithVDB(payload(), vdb)).toEqual([]);
  });

  it("flags both the VDB mismatch and the arithmetic break", async () => {
    const vdb = await primeVDB(SAMPLE, "sha256:abc", "s1");
    // AI says unearned 3200 (doc shows 4200) and 800 + 3200 !== 5000.
    const diffs = diffNumericsWithVDB(payload({ unearnedBalance: 3200 }), vdb);
    const fields = diffs.map((d) => d.field);
    expect(fields).toContain("unearnedBalance");
    expect(fields).toContain("arithmetic");
  });
});
