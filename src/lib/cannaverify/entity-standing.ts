// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * CannaVerify — Secretary of State entity standing (spec §5, "Entity standing").
 *
 * Confirms the business entity behind the license is in good standing with its
 * state of incorporation. Multi-state in production (`sos-entity.ts` in the spec's
 * adapter tree); one mock endpoint here.
 */

import type { CannaVerifyCheck } from "./types";

interface EntityStandingResponse {
  entityName?: string;
  status?: string;
  state?: string;
  entityType?: string;
}

export async function checkEntityStanding(
  stateLicenseNum: string,
  metrcBaseUrl: string,
): Promise<CannaVerifyCheck> {
  const base: CannaVerifyCheck = {
    checkType: "entity_standing",
    stateLicenseNum,
    result: "ERROR",
    detail: "",
  };

  try {
    const res = await fetch(`${metrcBaseUrl}/v2/entity/${encodeURIComponent(stateLicenseNum)}`);
    if (!res.ok) {
      return { ...base, detail: `Entity standing lookup failed with HTTP ${res.status}.` };
    }

    const data = (await res.json()) as EntityStandingResponse;
    const status = data.status ?? "Unknown";
    const name = data.entityName ?? "Entity";

    if (status === "Active") {
      return {
        ...base,
        result: "PASS",
        detail: `${name} (${data.entityType ?? "entity"}, ${data.state ?? "—"}) is in good standing.`,
      };
    }
    return {
      ...base,
      result: "FAIL",
      detail: `${name} is ${status} with the ${data.state ?? "state"} Secretary of State — not in good standing.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...base, detail: `Could not reach the entity standing endpoint: ${message}` };
  }
}
