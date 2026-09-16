/**
 * BarVerify adapter tests.
 *
 * The load-bearing assertion in this file is the negative one: nothing that is
 * not an affirmative "active" from a real registry may come back as `active`.
 * An uncovered state, a missing token, an unreachable registry, an unrecognized
 * status and an absent record must all land somewhere else, because the legal
 * flow reduces this result to a boolean that gates a retainer release.
 *
 * The second theme is that the five non-verdicts stay distinct. `not_configured`
 * in particular has to survive all the way to the screen as its own thing — it
 * renders neutrally, while every other failure renders as a problem.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as backend from "../backend";
import {
  verifyBar,
  resolveState,
  interpretBackendResult,
  STATE_ADAPTER_MAP,
  APIFY_SUPPORTED_STATES,
  BAR_VERIFY_SOURCE,
  BAR_VERIFY_UNAVAILABLE,
  type BarVerifyResult,
} from "./bar-verify";

const ALL_STATUSES = [
  "active",
  "inactive",
  "suspended",
  "not_found",
  "error",
  "unavailable",
  "not_configured",
  "unsupported_state",
];

/** A backend verdict, with the shape the Rust command actually returns. */
function apiResult(over: Partial<backend.BarVerifyApiResult> = {}): backend.BarVerifyApiResult {
  return {
    verified: false,
    name: null,
    licenseStatus: null,
    hasPublicDiscipline: false,
    state: "CA",
    error: null,
    ...over,
  };
}

/** Stub the Rust command with a fixed verdict. Returns the spy. */
function stubBackend(result: backend.BarVerifyApiResult) {
  return vi.spyOn(backend, "verifyBarNumber").mockResolvedValue(result);
}

function expectResultShape(r: BarVerifyResult): void {
  expect(typeof r.barNumber).toBe("string");
  expect(typeof r.state).toBe("string");
  expect(typeof r.detail).toBe("string");
  expect(ALL_STATUSES).toContain(r.status);
  for (const key of ["attorneyName", "admissionDate", "firmName"] as const) {
    if (r[key] !== undefined) expect(typeof r[key]).toBe("string");
  }
  if (r.hasPublicDiscipline !== undefined) expect(typeof r.hasPublicDiscipline).toBe("boolean");
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── A covered state, end to end ──────────────────────────────────────────────

describe("verifyBar — a covered state", () => {
  it("returns active with the attorney's name for a licensed attorney", async () => {
    stubBackend(apiResult({ verified: true, name: "Hae-Ri You", licenseStatus: "Active" }));
    const r = await verifyBar("300000", "CA");

    expect(r.status).toBe("active");
    expect(r.attorneyName).toBe("Hae-Ri You");
    expect(r.state).toBe("California");
    expect(r.detail).toContain("Active");
    expectResultShape(r);
  });

  it("passes the two-letter code to the backend, not the full state name", async () => {
    const spy = stubBackend(apiResult({ verified: true, licenseStatus: "Active" }));
    await verifyBar("300000", "California");
    // The actor's input schema enumerates codes; a full name is rejected by it.
    expect(spy).toHaveBeenCalledWith("300000", "CA");
  });

  it("accepts the full state name as the trust anchors spell it", async () => {
    stubBackend(apiResult({ verified: true, licenseStatus: "Active" }));
    const r = await verifyBar("300000", "California");
    expect(r.status).toBe("active");
  });

  it("trims the bar number before sending it", async () => {
    const spy = stubBackend(apiResult({ verified: true, licenseStatus: "Active" }));
    await verifyBar("  300000  ", "CA");
    expect(spy).toHaveBeenCalledWith("300000", "CA");
  });

  it("reports not_found for a blank bar number without calling the backend", async () => {
    const spy = stubBackend(apiResult());
    const r = await verifyBar("   ", "CA");

    expect(r.status).toBe("not_found");
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── The five things that are not verdicts ────────────────────────────────────

describe("verifyBar — non-verdicts stay distinct", () => {
  it("reports not_configured when no Apify token is stored", async () => {
    stubBackend(apiResult({ error: backend.BAR_VERIFY_NOT_CONFIGURED }));
    const r = await verifyBar("300000", "CA");

    expect(r.status).toBe("not_configured");
    expect(r.detail).toBe(backend.BAR_VERIFY_NOT_CONFIGURED);
  });

  it("does not collapse not_configured into unavailable", async () => {
    // These render differently — grey versus amber — so the distinction has to
    // survive the router.
    stubBackend(apiResult({ error: backend.BAR_VERIFY_NOT_CONFIGURED }));
    const configured = await verifyBar("300000", "CA");

    stubBackend(apiResult({ error: "Could not reach the bar verification service: timeout" }));
    const unreachable = await verifyBar("300000", "CA");

    expect(configured.status).toBe("not_configured");
    expect(unreachable.status).toBe("unavailable");
  });

  it("reports unavailable when the registry could not be reached", async () => {
    stubBackend(apiResult({ error: "Could not reach the bar verification service: timeout" }));
    const r = await verifyBar("300000", "CA");

    expect(r.status).toBe("unavailable");
    expect(r.detail).toContain(BAR_VERIFY_UNAVAILABLE);
  });

  it("reports unavailable on a non-2xx from the service", async () => {
    stubBackend(apiResult({ error: "Bar verification service returned HTTP 503." }));
    const r = await verifyBar("300000", "CA");
    expect(r.status).toBe("unavailable");
  });

  it("reports unsupported_state for a state no crawler covers", async () => {
    const spy = stubBackend(apiResult());
    const r = await verifyBar("12345", "WY");

    expect(r.status).toBe("unsupported_state");
    expect(r.detail).toContain("Wyoming");
    // Named, so the officer learns which states would work.
    expect(r.detail).toContain("CA");
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports unsupported_state for a string that is not a US state", async () => {
    const r = await verifyBar("12345", "Narnia");
    expect(r.status).toBe("unsupported_state");
    expect(r.detail).toContain("Narnia");
  });

  it("reports not_found when the registry answered and holds no record", async () => {
    stubBackend(apiResult({ verified: false, licenseStatus: null, error: null }));
    const r = await verifyBar("999999", "CA");

    expect(r.status).toBe("not_found");
    expect(r.detail).toBe("No record found in state bar registry — manual verification required.");
  });

  it("keeps the blank-bar-number message distinct from an empty registry result", async () => {
    // Both are `not_found`, and they are different things to hand an officer:
    // one means the registry was searched and came back empty, the other means
    // there was nothing to search for.
    stubBackend(apiResult({ verified: false, licenseStatus: null, error: null }));
    const empty = await verifyBar("999999", "CA");
    const blank = await verifyBar("   ", "CA");

    expect(empty.status).toBe("not_found");
    expect(blank.status).toBe("not_found");
    expect(blank.detail).toContain("No bar number was provided");
    expect(blank.detail).not.toBe(empty.detail);
  });

  it("never reports active for any non-verdict", async () => {
    const failures: backend.BarVerifyApiResult[] = [
      apiResult({ error: backend.BAR_VERIFY_NOT_CONFIGURED }),
      apiResult({ error: "Could not reach the bar verification service: refused" }),
      apiResult({ error: "Bar verification service returned HTTP 500." }),
      apiResult({ error: "Bar verification does not cover \"Wyoming\" — supported states are CA." }),
      apiResult({ verified: false, licenseStatus: null }),
    ];
    for (const f of failures) {
      stubBackend(f);
      const r = await verifyBar("300000", "CA");
      expect(r.status).not.toBe("active");
      expectResultShape(r);
    }
  });
});

// ── Status interpretation ────────────────────────────────────────────────────

describe("interpretBackendResult", () => {
  it("maps every status the registries emit", () => {
    const cases: Array<[string, BarVerifyResult["status"]]> = [
      ["Active", "active"],
      ["Inactive", "inactive"],
      ["Suspended", "suspended"],
      ["Disbarred", "suspended"],
      ["Retired", "inactive"],
      ["Deceased", "inactive"],
    ];
    for (const [raw, expected] of cases) {
      const r = interpretBackendResult(
        apiResult({ verified: raw === "Active", licenseStatus: raw }),
        "300000",
        "California",
      );
      expect(r.status, `${raw} should map to ${expected}`).toBe(expected);
      // The exact registry word survives even where two map to one status.
      expect(r.detail).toContain(raw);
    }
  });

  it("is case-insensitive about the registry's spelling", () => {
    for (const raw of ["active", "ACTIVE", " Active "]) {
      const r = interpretBackendResult(
        apiResult({ verified: true, licenseStatus: raw }),
        "300000",
        "California",
      );
      expect(r.status).toBe("active");
    }
  });

  it("treats an unrecognized registry status as an error, never as active", () => {
    const r = interpretBackendResult(
      apiResult({ verified: false, licenseStatus: "Pending Review" }),
      "300000",
      "California",
    );
    expect(r.status).toBe("error");
    expect(r.detail).toContain("unrecognized");
  });

  it("surfaces public discipline independently of the verdict", () => {
    // An attorney can be active and still carry a formal reprimand; the officer
    // needs both facts, so one must not mask the other.
    const r = interpretBackendResult(
      apiResult({ verified: true, licenseStatus: "Active", hasPublicDiscipline: true }),
      "300000",
      "California",
    );
    expect(r.status).toBe("active");
    expect(r.hasPublicDiscipline).toBe(true);
    expect(r.detail).toContain("disciplinary");
  });

  it("carries discipline through on a failure path too", () => {
    const r = interpretBackendResult(
      apiResult({ error: "Bar verification service returned HTTP 500.", hasPublicDiscipline: true }),
      "300000",
      "California",
    );
    expect(r.hasPublicDiscipline).toBe(true);
  });
});

// ── Routing table ────────────────────────────────────────────────────────────

describe("STATE_ADAPTER_MAP", () => {
  it("contains all 50 states", () => {
    expect(Object.keys(STATE_ADAPTER_MAP)).toHaveLength(50);
  });

  it("keys every entry by its own code and gives each a distinct state name", () => {
    const names = new Set<string>();
    for (const [key, entry] of Object.entries(STATE_ADAPTER_MAP)) {
      expect(entry.code).toBe(key);
      expect(names.has(entry.state)).toBe(false);
      names.add(entry.state);
    }
  });

  /**
   * The routing table and the actor's input enum have to agree. A state marked
   * implemented that the actor does not crawl returns an empty dataset, which
   * reads as "no such attorney" — a false negative against a real person.
   */
  it("marks exactly the states the actor crawls as implemented", () => {
    const implemented = Object.values(STATE_ADAPTER_MAP)
      .filter((e) => e.implemented)
      .map((e) => e.code)
      .sort();
    expect(implemented).toEqual([...APIFY_SUPPORTED_STATES].sort());
  });

  it("covers fourteen jurisdictions", () => {
    expect(APIFY_SUPPORTED_STATES).toHaveLength(14);
  });
});

describe("resolveState", () => {
  it("resolves by code, case-insensitively", () => {
    expect(resolveState("CA")?.code).toBe("CA");
    expect(resolveState("ca")?.code).toBe("CA");
  });

  it("resolves by full name, case-insensitively and with surrounding space", () => {
    expect(resolveState("California")?.code).toBe("CA");
    expect(resolveState("  new jersey  ")?.code).toBe("NJ");
  });

  it("returns null for anything it cannot route", () => {
    expect(resolveState("Narnia")).toBeNull();
    expect(resolveState("")).toBeNull();
    expect(resolveState("   ")).toBeNull();
  });
});

describe("provenance", () => {
  it("names the actor that produced a verdict", () => {
    // Recorded on the condition row and in the audit trail — a verdict with no
    // attributable source proves nothing on read-back.
    expect(BAR_VERIFY_SOURCE).toBe("apify/jungle_synthesizer~multi-state-bar-scraper");
  });
});
