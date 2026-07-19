/**
 * BarVerify adapter tests.
 *
 * The load-bearing assertion in this file is the negative one: nothing that is
 * not an affirmative "active" from a real registry may come back as `active`.
 * An unreachable adapter, an unimplemented state, an unrecognized status and a
 * malformed body must all land somewhere else, because the legal flow reduces
 * this result to a boolean that gates a retainer release.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  verifyBar,
  resolveState,
  STATE_ADAPTER_MAP,
  CALBAR_DEFAULT_BASE_URL,
  type BarVerifyResult,
} from "./bar-verify";

const BASE = "http://localhost:3001";

/** The mock CA Bar adapter's active response (src/mock/calbar-adapter.ts). */
const ACTIVE_BODY = {
  barNumber: "234567",
  status: "active",
  attorneyName: "Alex J. Mercer",
  admissionDate: "2014-06-01",
  firmName: "Mercer Legal Group LLP",
  detail: "Active member in good standing — California State Bar",
};

const INACTIVE_BODY = {
  barNumber: "99",
  status: "inactive",
  detail: "Bar number not found in California State Bar records",
};

/** Stub `fetch` with a fixed JSON body. Returns the spy for URL assertions. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const mockFetch = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch as unknown as ReturnType<typeof vi.fn>;
}

/** Every key the interface declares, with the optional ones optional. */
function expectResultShape(r: BarVerifyResult): void {
  expect(typeof r.barNumber).toBe("string");
  expect(typeof r.state).toBe("string");
  expect(typeof r.detail).toBe("string");
  expect(["active", "inactive", "suspended", "not_found", "error"]).toContain(r.status);
  for (const key of ["attorneyName", "admissionDate", "firmName"] as const) {
    if (r[key] !== undefined) expect(typeof r[key]).toBe("string");
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── California — the live V1 adapter ─────────────────────────────────────────

describe("verifyBar — California", () => {
  it("returns active with the attorney's details for a valid bar number", async () => {
    stubFetch(ACTIVE_BODY);
    const result = await verifyBar("234567", "CA", BASE);

    expect(result.status).toBe("active");
    expect(result.attorneyName).toBe("Alex J. Mercer");
    expect(result.admissionDate).toBe("2014-06-01");
    expect(result.firmName).toBe("Mercer Legal Group LLP");
    expect(result.state).toBe("California");
    expectResultShape(result);
  });

  it("returns inactive for a bar number the registry does not hold", async () => {
    stubFetch(INACTIVE_BODY);
    const result = await verifyBar("99", "CA", BASE);

    expect(result.status).toBe("inactive");
    expect(result.detail).toContain("not found");
    expect(result.attorneyName).toBeUndefined();
    expectResultShape(result);
  });

  it("routes California to the CA adapter endpoint", async () => {
    const mockFetch = stubFetch(ACTIVE_BODY);
    await verifyBar("234567", "CA", BASE);
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3001/verify/234567");
  });

  it("accepts the full state name as the trust anchors spell it", async () => {
    const mockFetch = stubFetch(ACTIVE_BODY);
    // Document Load stores "California", not "CA" — both must route.
    const result = await verifyBar("234567", "California", BASE);
    expect(result.status).toBe("active");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("defaults to the demo adapter base URL when none is given", async () => {
    const mockFetch = stubFetch(ACTIVE_BODY);
    await verifyBar("234567", "CA");
    expect(mockFetch).toHaveBeenCalledWith(`${CALBAR_DEFAULT_BASE_URL}/verify/234567`);
  });

  it("percent-encodes the bar number into the URL", async () => {
    const mockFetch = stubFetch(INACTIVE_BODY);
    await verifyBar("12/34", "CA", BASE);
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3001/verify/12%2F34");
  });

  it("tolerates a base URL with a trailing slash", async () => {
    const mockFetch = stubFetch(ACTIVE_BODY);
    await verifyBar("234567", "CA", "http://localhost:3001/");
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3001/verify/234567");
  });

  it("reports an error with the message when the adapter is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await verifyBar("234567", "CA", BASE);

    expect(result.status).toBe("error");
    expect(result.detail).toContain("ECONNREFUSED");
    expectResultShape(result);
  });

  it("reports an error on a non-OK HTTP response", async () => {
    stubFetch({}, false, 503);
    const result = await verifyBar("234567", "CA", BASE);

    expect(result.status).toBe("error");
    expect(result.detail).toContain("503");
  });

  it("treats an unrecognized registry status as an error, never as active", async () => {
    // The safety property: a value we have never seen cannot pass the gate.
    stubFetch({ barNumber: "234567", status: "probationary" });
    const result = await verifyBar("234567", "CA", BASE);

    expect(result.status).toBe("error");
    expect(result.detail).toContain("probationary");
  });

  it("treats a body with no status at all as an error", async () => {
    stubFetch({ barNumber: "234567" });
    expect((await verifyBar("234567", "CA", BASE)).status).toBe("error");
  });

  it("reports not_found for a blank bar number without calling the adapter", async () => {
    const mockFetch = stubFetch(ACTIVE_BODY);
    const result = await verifyBar("   ", "CA", BASE);

    expect(result.status).toBe("not_found");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Scaffolded states ────────────────────────────────────────────────────────

describe("verifyBar — scaffolded states", () => {
  it("returns an error naming the state as a V2 scaffold", async () => {
    const result = await verifyBar("1234567", "NY", BASE);

    expect(result.status).toBe("error");
    expect(result.detail).toBe("New York bar verification — V2 adapter (scaffold)");
    expectResultShape(result);
  });

  it("never issues a network call for an unimplemented state", async () => {
    const mockFetch = stubFetch(ACTIVE_BODY);
    await verifyBar("1234567", "TX", BASE);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(["NY", "TX", "FL", "IL", "WA", "OH"])(
    "returns a scaffold result mentioning scaffold for %s",
    async (code) => {
      const result = await verifyBar("1234567", code, BASE);
      expect(result.status).toBe("error");
      expect(result.detail).toContain("scaffold");
      expect(result.state).toBe(STATE_ADAPTER_MAP[code].state);
    },
  );

  it("returns an error for a state that is not a US state at all", async () => {
    const result = await verifyBar("1234567", "Ontario", BASE);
    expect(result.status).toBe("error");
    expect(result.detail).toContain("not a recognized US state");
    expectResultShape(result);
  });

  it("never reports active for any state other than California", async () => {
    // Blanket sweep: no scaffold may accidentally satisfy the settlement gate.
    stubFetch(ACTIVE_BODY);
    for (const code of Object.keys(STATE_ADAPTER_MAP)) {
      if (code === "CA") continue;
      const result = await verifyBar("234567", code, BASE);
      expect(result.status, `${code} must not report active`).not.toBe("active");
    }
  });
});

// ── The routing map ──────────────────────────────────────────────────────────

describe("STATE_ADAPTER_MAP", () => {
  it("contains all 50 states", () => {
    expect(Object.keys(STATE_ADAPTER_MAP)).toHaveLength(50);
  });

  it("includes every USPS state code exactly once", () => {
    const expected = [
      "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
      "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
      "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
      "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
      "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    ];
    expect(Object.keys(STATE_ADAPTER_MAP).sort()).toEqual([...expected].sort());
  });

  it("keys every entry by its own code and gives each a distinct state name", () => {
    const names = new Set<string>();
    for (const [key, entry] of Object.entries(STATE_ADAPTER_MAP)) {
      expect(entry.code).toBe(key);
      expect(entry.state.length).toBeGreaterThan(0);
      expect(entry.adapter.length).toBeGreaterThan(0);
      expect(entry.authority.length).toBeGreaterThan(0);
      names.add(entry.state);
    }
    expect(names.size).toBe(50);
  });

  it("marks California as the only implemented adapter in V1", () => {
    const implemented = Object.values(STATE_ADAPTER_MAP)
      .filter((e) => e.implemented)
      .map((e) => e.code);
    expect(implemented).toEqual(["CA"]);
  });

  it("routes California to the calbar adapter", () => {
    expect(STATE_ADAPTER_MAP.CA.adapter).toBe("calbar");
    expect(STATE_ADAPTER_MAP.CA.implemented).toBe(true);
  });

  it("carries the documented adapter slugs for the named V2 states", () => {
    expect(STATE_ADAPTER_MAP.NY.adapter).toBe("nysbar");
    expect(STATE_ADAPTER_MAP.TX.adapter).toBe("texasbar");
    expect(STATE_ADAPTER_MAP.FL.adapter).toBe("floridabar");
    expect(STATE_ADAPTER_MAP.IL.adapter).toBe("iardc");
  });
});

describe("resolveState", () => {
  it("resolves by code, case-insensitively", () => {
    expect(resolveState("ca")?.state).toBe("California");
    expect(resolveState("CA")?.state).toBe("California");
  });

  it("resolves by full name, case-insensitively and with surrounding space", () => {
    expect(resolveState("  new york ")?.code).toBe("NY");
    expect(resolveState("Massachusetts")?.code).toBe("MA");
  });

  it("returns null for anything it cannot route", () => {
    expect(resolveState("")).toBeNull();
    expect(resolveState("   ")).toBeNull();
    expect(resolveState("Ontario")).toBeNull();
    expect(resolveState("ZZ")).toBeNull();
  });
});

// ── Demo data policy ─────────────────────────────────────────────────────────

describe("demo data policy", () => {
  it("uses a clearly fictional attorney in the mock response", async () => {
    stubFetch(ACTIVE_BODY);
    const result = await verifyBar("234567", "CA", BASE);

    // The fixture attorney is invented for this adapter — see
    // src/mock/calbar-adapter.ts and the policy in ./README.md.
    expect(result.attorneyName).toBe("Alex J. Mercer");
    expect(result.firmName).toBe("Mercer Legal Group LLP");
  });

  it("carries no real contact details through the result", async () => {
    stubFetch(ACTIVE_BODY);
    const serialized = JSON.stringify(await verifyBar("234567", "CA", BASE));

    expect(serialized).not.toMatch(/@/); // no email addresses
    expect(serialized).not.toMatch(/\(\d{3}\)|\d{3}-\d{3}-\d{4}/); // no phone numbers
  });
});
