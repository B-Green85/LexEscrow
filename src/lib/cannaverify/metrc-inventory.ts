// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * CannaVerify — inventory / batch confirmation (spec §5, "Inventory confirmed").
 *
 * For product-transfer escrow, Metrc package data is compared against the agreed
 * inventory schedule that AI extracted from the documents. Every scheduled batch
 * must exist in Metrc *and* be Active; a batch that is present but inactive is a
 * failure, not a pass.
 */

import type { CannaVerifyCheck } from "./types";

interface MetrcPackage {
  label?: string;
  quantity?: number;
  unit?: string;
  status?: string;
}

interface MetrcPackagesResponse {
  packages?: MetrcPackage[];
}

export async function checkInventory(
  expectedBatches: string[],
  metrcBaseUrl: string,
): Promise<CannaVerifyCheck> {
  const base: CannaVerifyCheck = {
    checkType: "inventory_confirmed",
    result: "ERROR",
    detail: "",
  };

  // No schedule extracted from the documents — nothing to reconcile against.
  if (!expectedBatches || expectedBatches.length === 0) {
    return {
      ...base,
      result: "PASS",
      detail: "No inventory schedule specified — condition skipped",
    };
  }

  try {
    const res = await fetch(`${metrcBaseUrl}/v2/packages`);
    if (!res.ok) {
      return { ...base, detail: `Metrc package lookup failed with HTTP ${res.status}.` };
    }

    const data = (await res.json()) as MetrcPackagesResponse;
    const packages = data.packages ?? [];
    const byLabel = new Map(packages.map((p) => [p.label ?? "", p]));

    const missing: string[] = [];
    const inactive: string[] = [];
    for (const batch of expectedBatches) {
      const pkg = byLabel.get(batch);
      if (!pkg) missing.push(batch);
      else if (pkg.status !== "Active") inactive.push(`${batch} (${pkg.status ?? "unknown"})`);
    }

    if (missing.length === 0 && inactive.length === 0) {
      return {
        ...base,
        result: "PASS",
        detail: `All ${expectedBatches.length} scheduled batch${expectedBatches.length === 1 ? "" : "es"} confirmed Active in Metrc.`,
      };
    }

    const parts: string[] = [];
    if (missing.length > 0) parts.push(`not found in Metrc: ${missing.join(", ")}`);
    if (inactive.length > 0) parts.push(`not Active: ${inactive.join(", ")}`);
    return {
      ...base,
      result: "FAIL",
      detail: `Inventory does not match the agreed schedule — ${parts.join("; ")}.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...base, detail: `Could not reach the Metrc package endpoint: ${message}` };
  }
}
