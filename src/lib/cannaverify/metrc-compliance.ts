/**
 * CannaVerify — open compliance hold check (spec §5, "No compliance holds").
 *
 * Any open regulatory hold or enforcement action blocks fund deposit and release
 * until it is resolved. This reads the same Metrc license record as
 * `metrc-license.ts` but evaluates only the hold count, so the condition
 * checklist can tell an escrow officer *which* of the two failed.
 */

import type { CannaVerifyCheck } from "./types";

interface MetrcLicenseResponse {
  facilityId?: string;
  complianceHolds?: number;
}

export async function checkComplianceHolds(
  stateLicenseNum: string,
  metrcBaseUrl: string,
): Promise<CannaVerifyCheck> {
  const base: CannaVerifyCheck = {
    checkType: "compliance_holds",
    stateLicenseNum,
    result: "ERROR",
    detail: "",
  };

  try {
    const res = await fetch(`${metrcBaseUrl}/v2/licenses/${encodeURIComponent(stateLicenseNum)}`);
    if (!res.ok) {
      return { ...base, detail: `Metrc compliance lookup failed with HTTP ${res.status}.` };
    }

    const data = (await res.json()) as MetrcLicenseResponse;
    const holds = data.complianceHolds ?? 0;
    const check: CannaVerifyCheck = { ...base, metrcFacilityId: data.facilityId };

    if (holds === 0) {
      return { ...check, result: "PASS", detail: "No open compliance holds or enforcement actions." };
    }
    return {
      ...check,
      result: "FAIL",
      detail: `${holds} open compliance hold${holds === 1 ? "" : "s"} on record — funds cannot be released until resolved.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...base, detail: `Could not reach the Metrc compliance endpoint: ${message}` };
  }
}
