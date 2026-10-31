// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * payload-diff — numeric cross-reference and arithmetic validation.
 *
 * Every financial value is converted to integer cents (`bigint`) before any
 * arithmetic or comparison, so validation is exact and immune to IEEE-754 drift
 * (`0.1 + 0.2 !== 0.3`). Dollars are reconstructed only for display.
 */

import type { NumericObservations, ParsedRetainerPayload, PayloadCents } from "./types";
import { queryVDB, type VDBStore } from "./vdb";

export interface PayloadDiff {
  field: string;
  aiValue: number | string;
  observedValue: number | string;
  discrepancy: boolean;
  nudgeCount: number;
  resolved: boolean;
  timestamp: string;
}

/** Dollars → integer cents. Exactly one rounding, at the parse boundary. */
export function toCents(dollars: number): bigint {
  return BigInt(Math.round(dollars * 100));
}

/** Integer cents → dollars (display / interop only). */
export function fromCents(cents: bigint): number {
  return Number(cents) / 100;
}

/** Integer cents → `$1,234.56` with thousands separators, no float involved. */
export function formatUsd(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = abs / 100n;
  const remainder = (abs % 100n).toString().padStart(2, "0");
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${remainder}`;
}

/** Canonical integer-cents projection of an AI payload. */
export function toPayloadCents(p: ParsedRetainerPayload): PayloadCents {
  return {
    totalHeldCents: toCents(p.totalHeld),
    earnedFeesCents: toCents(p.earnedFees),
    unearnedBalanceCents: toCents(p.unearnedBalance),
    disputedAmountCents: toCents(p.disputedAmount),
    disputedHours: p.disputedHours,
  };
}

/**
 * Arithmetic integrity: earned fees + unearned balance must equal total held —
 * exact BigInt equality on integer cents.
 */
export function validateArithmetic(payload: ParsedRetainerPayload): boolean {
  const earned = toCents(payload.earnedFees);
  const unearned = toCents(payload.unearnedBalance);
  const total = toCents(payload.totalHeld);
  return earned + unearned === total;
}

/**
 * Cross-reference every numeric field AI extracted against values independently
 * observed in the raw artifact. Comparison is in integer cents (cent-exact).
 */
export function diffNumericFields(
  aiPayload: ParsedRetainerPayload,
  observed: NumericObservations,
): PayloadDiff[] {
  const diffs: PayloadDiff[] = [];
  for (const [field, observedValue] of Object.entries(observed)) {
    const aiValue = (aiPayload as unknown as Record<string, unknown>)[field];
    if (typeof aiValue !== "number") continue;
    if (toCents(aiValue) !== toCents(observedValue)) {
      diffs.push({
        field,
        aiValue,
        observedValue,
        discrepancy: true,
        nudgeCount: 0,
        resolved: false,
        timestamp: new Date().toISOString(),
      });
    }
  }
  return diffs;
}

/**
 * VDB-assisted numeric diff — uses the primed VDB as a fast lookup layer
 * (never as the validation authority). Always runs the arithmetic check, which
 * no lookup can replace.
 */
export function diffNumericsWithVDB(
  aiPayload: ParsedRetainerPayload,
  vdb: VDBStore,
): PayloadDiff[] {
  const diffs: PayloadDiff[] = [];

  const vdbUnearned = queryVDB(vdb, "numeric", "unearnedBalance").map((e) => Number(e.value));
  const aiUnearnedCents = toCents(aiPayload.unearnedBalance);
  if (vdbUnearned.length > 0 && !vdbUnearned.some((v) => toCents(v) === aiUnearnedCents)) {
    diffs.push({
      field: "unearnedBalance",
      aiValue: aiPayload.unearnedBalance,
      observedValue: vdbUnearned[0],
      discrepancy: true,
      nudgeCount: 0,
      resolved: false,
      timestamp: new Date().toISOString(),
    });
  }

  if (!validateArithmetic(aiPayload)) {
    diffs.push({
      field: "arithmetic",
      aiValue: `${aiPayload.earnedFees} + ${aiPayload.unearnedBalance}`,
      observedValue: aiPayload.totalHeld,
      discrepancy: true,
      nudgeCount: 0,
      resolved: false,
      timestamp: new Date().toISOString(),
    });
  }

  return diffs;
}
