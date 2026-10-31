// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * CannaVerify — transfer manifest confirmation (spec §5, "Transfer manifest").
 *
 * Confirms the transfer manifest is initiated in Metrc and accepted. Under CRE
 * this is the condition that gates release on physical custody actually moving.
 */

import type { CannaVerifyCheck } from "./types";

interface MetrcTransferResponse {
  manifestNumber?: string;
  status?: string;
  estimatedDepartureDateTime?: string;
}

export async function checkTransferManifest(metrcBaseUrl: string): Promise<CannaVerifyCheck> {
  const base: CannaVerifyCheck = {
    checkType: "transfer_manifest",
    result: "ERROR",
    detail: "",
  };

  try {
    const res = await fetch(`${metrcBaseUrl}/v2/transfers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      return { ...base, detail: `Metrc transfer lookup failed with HTTP ${res.status}.` };
    }

    const data = (await res.json()) as MetrcTransferResponse;
    const status = data.status ?? "Unknown";
    const manifest = data.manifestNumber ?? "unknown";

    if (status === "Accepted") {
      return {
        ...base,
        result: "PASS",
        detail: `Manifest ${manifest} accepted in Metrc (departure ${data.estimatedDepartureDateTime ?? "unscheduled"}).`,
      };
    }
    return {
      ...base,
      result: "FAIL",
      detail: `Manifest ${manifest} is ${status}, not Accepted — transfer is not confirmed.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...base, detail: `Could not reach the Metrc transfer endpoint: ${message}` };
  }
}
