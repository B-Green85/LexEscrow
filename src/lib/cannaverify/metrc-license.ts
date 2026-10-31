// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * CannaVerify — Metrc license status verification (spec §5, "License active").
 *
 * The state regulatory authority confirms the license is active, not suspended,
 * not expired. Under CRE this runs as a Chainlink Functions call whose result is
 * written on-chain by BFT consensus; here it hits the mock Metrc adapter.
 */

import type { CannaVerifyCheck } from "./types";

interface MetrcLicenseResponse {
  licenseNumber?: string;
  licenseType?: string;
  status?: string;
  expirationDate?: string;
  facilityId?: string;
  complianceHolds?: number;
}

/**
 * A license passes only when it is Active *and* carries no compliance holds —
 * an active license with an open enforcement action still blocks the escrow.
 */
export async function checkLicense(
  stateLicenseNum: string,
  metrcBaseUrl: string,
): Promise<CannaVerifyCheck> {
  const base: CannaVerifyCheck = {
    checkType: "license_active",
    stateLicenseNum,
    result: "ERROR",
    detail: "",
  };

  try {
    const res = await fetch(`${metrcBaseUrl}/v2/licenses/${encodeURIComponent(stateLicenseNum)}`);
    if (!res.ok) {
      return { ...base, detail: `Metrc license lookup failed with HTTP ${res.status}.` };
    }

    const data = (await res.json()) as MetrcLicenseResponse;
    const status = data.status ?? "Unknown";
    const holds = data.complianceHolds ?? 0;
    const check: CannaVerifyCheck = { ...base, metrcFacilityId: data.facilityId };

    if (status === "Active" && holds === 0) {
      return {
        ...check,
        result: "PASS",
        detail: `License ${stateLicenseNum} is Active with no compliance holds (expires ${data.expirationDate ?? "unknown"}).`,
      };
    }

    const reasons: string[] = [];
    if (status !== "Active") reasons.push(`status is ${status}, not Active`);
    if (holds > 0) reasons.push(`${holds} open compliance hold${holds === 1 ? "" : "s"}`);
    return {
      ...check,
      result: "FAIL",
      detail: `License ${stateLicenseNum} failed verification — ${reasons.join("; ")}.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...base, detail: `Could not reach the Metrc license endpoint: ${message}` };
  }
}
