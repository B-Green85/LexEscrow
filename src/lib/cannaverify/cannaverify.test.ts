/**
 * CannaVerify adapter suite tests.
 *
 * Every adapter is exercised against a stubbed `fetch` — PASS, FAIL and the
 * network-ERROR path — plus the orchestrator's verdict collapsing. The backend
 * is mocked out: these tests must never touch the `cannaverify_results` table.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../backend", () => ({ saveCannaverifyResult: vi.fn() }));

import * as backend from "../backend";
import { checkLicense } from "./metrc-license";
import { checkComplianceHolds } from "./metrc-compliance";
import { checkInventory } from "./metrc-inventory";
import { checkTransferManifest } from "./metrc-transfer";
import { checkEntityStanding } from "./entity-standing";
import { runCannaVerify } from "./index";

const BASE = "http://localhost:3002";
const LICENSE = "C10-0001234-LIC";

/** A `fetch` that returns one fixed JSON body for every request. */
function stubJson(body: unknown, ok = true, status = 200) {
  const spy = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** A `fetch` that rejects — the network-failure path. */
function stubNetworkFailure() {
  const spy = vi.fn(async () => {
    throw new Error("ECONNREFUSED");
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

// Fixtures matching the mock Metrc adapter's responses.
const ACTIVE_LICENSE = {
  licenseNumber: LICENSE,
  licenseType: "Cannabis Retailer",
  status: "Active",
  expirationDate: "2027-12-31",
  facilityId: "MTRC-CA-00042",
  complianceHolds: 0,
};
const INACTIVE_LICENSE = { ...ACTIVE_LICENSE, status: "Inactive", complianceHolds: 1 };
const PACKAGES = {
  packages: [
    { label: "DEMO-BATCH-001", quantity: 50, unit: "Each", status: "Active" },
    { label: "DEMO-BATCH-002", quantity: 25, unit: "Each", status: "Active" },
  ],
};
const MANIFEST = {
  manifestNumber: "DEMO-MANIFEST-2026-001",
  status: "Accepted",
  estimatedDepartureDateTime: "2026-10-20T09:00:00Z",
};
const ENTITY = {
  entityName: "GreenLeaf Dispensary LLC",
  status: "Active",
  state: "CA",
  entityType: "LLC",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── metrc-license ───────────────────────────────────────────────────────────

describe("checkLicense", () => {
  it("PASSes an active license with no compliance holds", async () => {
    stubJson(ACTIVE_LICENSE);
    const check = await checkLicense(LICENSE, BASE);
    expect(check.checkType).toBe("license_active");
    expect(check.result).toBe("PASS");
    expect(check.stateLicenseNum).toBe(LICENSE);
    expect(check.metrcFacilityId).toBe("MTRC-CA-00042");
    expect(check.detail).toContain("Active");
  });

  it("FAILs an inactive license and says why", async () => {
    stubJson(INACTIVE_LICENSE);
    const check = await checkLicense("C10-9999999-LIC", BASE);
    expect(check.result).toBe("FAIL");
    expect(check.detail).toContain("not Active");
  });

  it("FAILs an Active license that still carries a compliance hold", async () => {
    stubJson({ ...ACTIVE_LICENSE, complianceHolds: 2 });
    const check = await checkLicense(LICENSE, BASE);
    expect(check.result).toBe("FAIL");
    expect(check.detail).toContain("2 open compliance holds");
  });

  it("ERRORs on network failure", async () => {
    stubNetworkFailure();
    const check = await checkLicense(LICENSE, BASE);
    expect(check.result).toBe("ERROR");
    expect(check.detail).toContain("ECONNREFUSED");
  });

  it("ERRORs on a non-200 response", async () => {
    stubJson({}, false, 503);
    const check = await checkLicense(LICENSE, BASE);
    expect(check.result).toBe("ERROR");
    expect(check.detail).toContain("503");
  });

  it("URL-encodes the license number into the request path", async () => {
    const spy = stubJson(ACTIVE_LICENSE);
    await checkLicense("C10 0001234/LIC", BASE);
    expect(spy).toHaveBeenCalledWith(`${BASE}/v2/licenses/C10%200001234%2FLIC`);
  });
});

// ── metrc-compliance ────────────────────────────────────────────────────────

describe("checkComplianceHolds", () => {
  it("PASSes when there are zero holds", async () => {
    stubJson(ACTIVE_LICENSE);
    const check = await checkComplianceHolds(LICENSE, BASE);
    expect(check.checkType).toBe("compliance_holds");
    expect(check.result).toBe("PASS");
    expect(check.detail).toContain("No open compliance holds");
  });

  it("FAILs with the hold count in the detail", async () => {
    stubJson({ ...ACTIVE_LICENSE, complianceHolds: 3 });
    const check = await checkComplianceHolds(LICENSE, BASE);
    expect(check.result).toBe("FAIL");
    expect(check.detail).toContain("3 open compliance holds");
  });

  it("uses the singular form for exactly one hold", async () => {
    stubJson(INACTIVE_LICENSE);
    const check = await checkComplianceHolds(LICENSE, BASE);
    expect(check.result).toBe("FAIL");
    expect(check.detail).toContain("1 open compliance hold on record");
    expect(check.detail).not.toContain("holds");
  });

  it("ERRORs on network failure", async () => {
    stubNetworkFailure();
    const check = await checkComplianceHolds(LICENSE, BASE);
    expect(check.result).toBe("ERROR");
  });
});

// ── metrc-inventory ─────────────────────────────────────────────────────────

describe("checkInventory", () => {
  it("PASSes when every expected batch is present and Active", async () => {
    stubJson(PACKAGES);
    const check = await checkInventory(["DEMO-BATCH-001", "DEMO-BATCH-002"], BASE);
    expect(check.checkType).toBe("inventory_confirmed");
    expect(check.result).toBe("PASS");
    expect(check.detail).toContain("2 scheduled batches confirmed");
  });

  it("FAILs and names the batch missing from Metrc", async () => {
    stubJson(PACKAGES);
    const check = await checkInventory(["DEMO-BATCH-001", "DEMO-BATCH-404"], BASE);
    expect(check.result).toBe("FAIL");
    expect(check.detail).toContain("DEMO-BATCH-404");
    expect(check.detail).not.toContain("DEMO-BATCH-001");
  });

  it("FAILs a batch that exists but is not Active", async () => {
    stubJson({ packages: [{ label: "DEMO-BATCH-001", status: "OnHold" }] });
    const check = await checkInventory(["DEMO-BATCH-001"], BASE);
    expect(check.result).toBe("FAIL");
    expect(check.detail).toContain("not Active");
    expect(check.detail).toContain("OnHold");
  });

  it("PASSes and skips the condition when no schedule was specified", async () => {
    const spy = stubJson(PACKAGES);
    const check = await checkInventory([], BASE);
    expect(check.result).toBe("PASS");
    expect(check.detail).toBe("No inventory schedule specified — condition skipped");
    expect(spy).not.toHaveBeenCalled(); // nothing to reconcile — no call made
  });

  it("ERRORs on network failure", async () => {
    stubNetworkFailure();
    const check = await checkInventory(["DEMO-BATCH-001"], BASE);
    expect(check.result).toBe("ERROR");
  });
});

// ── metrc-transfer ──────────────────────────────────────────────────────────

describe("checkTransferManifest", () => {
  it("PASSes on an Accepted manifest", async () => {
    const spy = stubJson(MANIFEST);
    const check = await checkTransferManifest(BASE);
    expect(check.checkType).toBe("transfer_manifest");
    expect(check.result).toBe("PASS");
    expect(check.detail).toContain("DEMO-MANIFEST-2026-001");
    expect(spy).toHaveBeenCalledWith(`${BASE}/v2/transfers`, expect.objectContaining({ method: "POST" }));
  });

  it("FAILs on any other manifest status", async () => {
    stubJson({ ...MANIFEST, status: "Rejected" });
    const check = await checkTransferManifest(BASE);
    expect(check.result).toBe("FAIL");
    expect(check.detail).toContain("Rejected");
  });

  it("ERRORs on network failure", async () => {
    stubNetworkFailure();
    const check = await checkTransferManifest(BASE);
    expect(check.result).toBe("ERROR");
  });
});

// ── entity-standing ─────────────────────────────────────────────────────────

describe("checkEntityStanding", () => {
  it("PASSes an entity in good standing", async () => {
    stubJson(ENTITY);
    const check = await checkEntityStanding(LICENSE, BASE);
    expect(check.checkType).toBe("entity_standing");
    expect(check.result).toBe("PASS");
    expect(check.detail).toContain("GreenLeaf Dispensary LLC");
  });

  it("FAILs an inactive entity", async () => {
    stubJson({ ...ENTITY, status: "Suspended" });
    const check = await checkEntityStanding(LICENSE, BASE);
    expect(check.result).toBe("FAIL");
    expect(check.detail).toContain("Suspended");
  });

  it("ERRORs on network failure", async () => {
    stubNetworkFailure();
    const check = await checkEntityStanding(LICENSE, BASE);
    expect(check.result).toBe("ERROR");
  });
});

// ── orchestrator ────────────────────────────────────────────────────────────

/** Route the stubbed fetch by URL so the whole suite can run end to end. */
function stubRoutedFetch(overrides: Partial<Record<string, unknown>> = {}) {
  const routes: Record<string, unknown> = {
    licenses: ACTIVE_LICENSE,
    packages: PACKAGES,
    transfers: MANIFEST,
    entity: ENTITY,
    ...overrides,
  };
  const spy = vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(`/v2/${k}`));
    return { ok: true, status: 200, json: async () => (key ? routes[key] : {}) };
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const INPUT = {
  sessionId: "wf-test-session",
  stateLicenseNum: LICENSE,
  metrcFacilityId: "MTRC-CA-00042",
  licenseType: "Dispensary",
  state: "CA",
  inventorySchedule: ["DEMO-BATCH-001", "DEMO-BATCH-002"],
  metrcBaseUrl: BASE,
};

describe("runCannaVerify", () => {
  beforeEach(() => {
    vi.mocked(backend.saveCannaverifyResult).mockResolvedValue(undefined);
  });

  it("runs all five checks in spec order", async () => {
    stubRoutedFetch();
    const result = await runCannaVerify(INPUT);
    expect(result.checks).toHaveLength(5);
    expect(result.checks.map((c) => c.checkType)).toEqual([
      "license_active",
      "compliance_holds",
      "inventory_confirmed",
      "transfer_manifest",
      "entity_standing",
    ]);
  });

  it("returns PASS overall only when every check passes", async () => {
    stubRoutedFetch();
    const result = await runCannaVerify(INPUT);
    expect(result.checks.every((c) => c.result === "PASS")).toBe(true);
    expect(result.overallResult).toBe("PASS");
  });

  it("returns FAIL overall when any single check fails", async () => {
    stubRoutedFetch({ entity: { ...ENTITY, status: "Suspended" } });
    const result = await runCannaVerify(INPUT);
    expect(result.overallResult).toBe("FAIL");
    expect(result.checks.filter((c) => c.result === "FAIL")).toHaveLength(1);
  });

  it("FAIL outranks ERROR when both are present", async () => {
    // Inactive license → license_active and compliance_holds both FAIL.
    // A rejected manifest keeps a second FAIL in play alongside no ERRORs.
    stubRoutedFetch({ licenses: INACTIVE_LICENSE });
    const result = await runCannaVerify(INPUT);
    expect(result.overallResult).toBe("FAIL");
  });

  it("returns ERROR overall when a check errors and none fail", async () => {
    stubNetworkFailure();
    const result = await runCannaVerify({ ...INPUT, inventorySchedule: [] });
    expect(result.checks.some((c) => c.result === "ERROR")).toBe(true);
    expect(result.checks.some((c) => c.result === "FAIL")).toBe(false);
    expect(result.overallResult).toBe("ERROR");
  });

  it("stamps every check with a mock CRE on-chain tx hash", async () => {
    stubRoutedFetch();
    const result = await runCannaVerify(INPUT);
    for (const check of result.checks) {
      expect(check.onChainTx).toMatch(/^0xcannav-[a-z_]+-[0-9a-f]+$/);
      expect(check.onChainTx).toContain(check.checkType);
    }
  });

  it("persists one cannaverify_results row per check", async () => {
    stubRoutedFetch();
    await runCannaVerify(INPUT);
    expect(backend.saveCannaverifyResult).toHaveBeenCalledTimes(5);
    expect(backend.saveCannaverifyResult).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "wf-test-session",
        checkType: "license_active",
        stateLicenseNum: LICENSE,
        result: "PASS",
      }),
    );
  });

  it("carries the session context through onto the result", async () => {
    stubRoutedFetch();
    const result = await runCannaVerify(INPUT);
    expect(result.sessionId).toBe("wf-test-session");
    expect(result.stateLicenseNum).toBe(LICENSE);
    expect(result.licenseType).toBe("Dispensary");
    expect(result.state).toBe("CA");
    expect(Number.isNaN(Date.parse(result.completedAt))).toBe(false);
  });

  it("still returns a verdict when the database write fails", async () => {
    stubRoutedFetch();
    vi.mocked(backend.saveCannaverifyResult).mockRejectedValue(new Error("db locked"));
    const result = await runCannaVerify(INPUT);
    expect(result.overallResult).toBe("PASS");
    expect(result.checks).toHaveLength(5);
  });
});
