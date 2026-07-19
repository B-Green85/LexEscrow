/**
 * BarVerify — 50-state bar association verification (spec §10, "Adapter Library
 * Vision"; §14 V1 roadmap).
 *
 * The legal asset class turns on one fact an escrow cannot assume: that the
 * attorney of record is actually admitted and in good standing *right now*. A
 * retainer release to a suspended attorney is the failure mode this adapter
 * exists to prevent, and a regex over the bar number cannot detect it — a
 * disbarred attorney's number is still six digits.
 *
 * Fifty jurisdictions, fifty registries, no common API. So the shape here is a
 * router: one canonical result type, one entry per state, and per-state
 * implementations added independently. California is live in V1 (the CRE
 * Chainlink Functions call target, mocked locally by `src/mock/calbar-adapter`);
 * the other forty-nine are declared but unimplemented.
 *
 * A scaffolded state returns `error`, never `active`. That asymmetry is the
 * whole safety property: "we have not built this yet" and "this attorney is in
 * good standing" must never be the same value, because the caller turns the
 * result into a boolean that gates money.
 */

/** Every outcome a bar lookup can produce. */
export interface BarVerifyResult {
  barNumber: string;
  state: string;
  status: "active" | "inactive" | "suspended" | "not_found" | "error";
  attorneyName?: string;
  admissionDate?: string;
  firmName?: string;
  detail: string;
}

/** One jurisdiction's routing entry. */
export interface StateBarAdapter {
  /** USPS two-letter code — the map's key. */
  code: string;
  /** Full state name, as the UI and trust anchors spell it. */
  state: string;
  /** Adapter slug: the module that implements (or will implement) this state. */
  adapter: string;
  /** The regulator whose registry is authoritative for this state. */
  authority: string;
  /** False while the state is a scaffold. */
  implemented: boolean;
}

/** Where the CA adapter lives during local demo and CRE simulation. */
export const CALBAR_DEFAULT_BASE_URL = "http://localhost:3001";

/**
 * The full routing table — all 50 states.
 *
 * Exported so a V2 adapter is a mechanical addition rather than a redesign:
 * implement `verifyBarForState_XX`, flip `implemented`, add the case to the
 * router. Callers can also read it to tell an officer *why* a state came back
 * unverified, which "error" alone does not.
 */
export const STATE_ADAPTER_MAP: Record<string, StateBarAdapter> = {
  AL: { code: "AL", state: "Alabama", adapter: "alabar", authority: "Alabama State Bar", implemented: false },
  AK: { code: "AK", state: "Alaska", adapter: "alaskabar", authority: "Alaska Bar Association", implemented: false },
  AZ: { code: "AZ", state: "Arizona", adapter: "azbar", authority: "State Bar of Arizona", implemented: false },
  AR: { code: "AR", state: "Arkansas", adapter: "arkbar", authority: "Arkansas Judiciary — Office of Professional Conduct", implemented: false },
  CA: { code: "CA", state: "California", adapter: "calbar", authority: "The State Bar of California", implemented: true },
  CO: { code: "CO", state: "Colorado", adapter: "coloradobar", authority: "Colorado Supreme Court — Office of Attorney Registration", implemented: false },
  CT: { code: "CT", state: "Connecticut", adapter: "ctbar", authority: "Connecticut Judicial Branch — Statewide Grievance Committee", implemented: false },
  DE: { code: "DE", state: "Delaware", adapter: "debar", authority: "Delaware State Bar Association", implemented: false },
  FL: { code: "FL", state: "Florida", adapter: "floridabar", authority: "The Florida Bar", implemented: false },
  GA: { code: "GA", state: "Georgia", adapter: "gabar", authority: "State Bar of Georgia", implemented: false },
  HI: { code: "HI", state: "Hawaii", adapter: "hsba", authority: "Hawaii State Bar Association", implemented: false },
  ID: { code: "ID", state: "Idaho", adapter: "idahobar", authority: "Idaho State Bar", implemented: false },
  IL: { code: "IL", state: "Illinois", adapter: "iardc", authority: "Illinois Attorney Registration and Disciplinary Commission", implemented: false },
  IN: { code: "IN", state: "Indiana", adapter: "inbar", authority: "Indiana Supreme Court — Roll of Attorneys", implemented: false },
  IA: { code: "IA", state: "Iowa", adapter: "iowabar", authority: "Iowa Judicial Branch — Office of Professional Regulation", implemented: false },
  KS: { code: "KS", state: "Kansas", adapter: "ksbar", authority: "Kansas Office of Judicial Administration — Attorney Registration", implemented: false },
  KY: { code: "KY", state: "Kentucky", adapter: "kybar", authority: "Kentucky Bar Association", implemented: false },
  LA: { code: "LA", state: "Louisiana", adapter: "labar", authority: "Louisiana State Bar Association", implemented: false },
  ME: { code: "ME", state: "Maine", adapter: "mainebar", authority: "Maine Board of Overseers of the Bar", implemented: false },
  MD: { code: "MD", state: "Maryland", adapter: "mdbar", authority: "Maryland Judiciary — Attorney Information System", implemented: false },
  MA: { code: "MA", state: "Massachusetts", adapter: "mabbo", authority: "Massachusetts Board of Bar Overseers", implemented: false },
  MI: { code: "MI", state: "Michigan", adapter: "michbar", authority: "State Bar of Michigan", implemented: false },
  MN: { code: "MN", state: "Minnesota", adapter: "mnbar", authority: "Minnesota Lawyer Registration Office", implemented: false },
  MS: { code: "MS", state: "Mississippi", adapter: "msbar", authority: "The Mississippi Bar", implemented: false },
  MO: { code: "MO", state: "Missouri", adapter: "mobar", authority: "The Missouri Bar", implemented: false },
  MT: { code: "MT", state: "Montana", adapter: "montanabar", authority: "State Bar of Montana", implemented: false },
  NE: { code: "NE", state: "Nebraska", adapter: "nebar", authority: "Nebraska State Bar Association", implemented: false },
  NV: { code: "NV", state: "Nevada", adapter: "nvbar", authority: "State Bar of Nevada", implemented: false },
  NH: { code: "NH", state: "New Hampshire", adapter: "nhbar", authority: "New Hampshire Bar Association", implemented: false },
  NJ: { code: "NJ", state: "New Jersey", adapter: "njbar", authority: "New Jersey Courts — Attorney Registration", implemented: false },
  NM: { code: "NM", state: "New Mexico", adapter: "nmbar", authority: "State Bar of New Mexico", implemented: false },
  NY: { code: "NY", state: "New York", adapter: "nysbar", authority: "New York State Unified Court System — Attorney Registration", implemented: false },
  NC: { code: "NC", state: "North Carolina", adapter: "ncbar", authority: "North Carolina State Bar", implemented: false },
  ND: { code: "ND", state: "North Dakota", adapter: "ndbar", authority: "State Bar Association of North Dakota", implemented: false },
  OH: { code: "OH", state: "Ohio", adapter: "ohiobar", authority: "Supreme Court of Ohio — Office of Attorney Services", implemented: false },
  OK: { code: "OK", state: "Oklahoma", adapter: "okbar", authority: "Oklahoma Bar Association", implemented: false },
  OR: { code: "OR", state: "Oregon", adapter: "osbar", authority: "Oregon State Bar", implemented: false },
  PA: { code: "PA", state: "Pennsylvania", adapter: "padb", authority: "Disciplinary Board of the Supreme Court of Pennsylvania", implemented: false },
  RI: { code: "RI", state: "Rhode Island", adapter: "ribar", authority: "Rhode Island Supreme Court — Attorney Registration", implemented: false },
  SC: { code: "SC", state: "South Carolina", adapter: "scbar", authority: "South Carolina Bar", implemented: false },
  SD: { code: "SD", state: "South Dakota", adapter: "sdbar", authority: "State Bar of South Dakota", implemented: false },
  TN: { code: "TN", state: "Tennessee", adapter: "tnbpr", authority: "Tennessee Board of Professional Responsibility", implemented: false },
  TX: { code: "TX", state: "Texas", adapter: "texasbar", authority: "State Bar of Texas", implemented: false },
  UT: { code: "UT", state: "Utah", adapter: "utahbar", authority: "Utah State Bar", implemented: false },
  VT: { code: "VT", state: "Vermont", adapter: "vtbar", authority: "Vermont Judiciary — Attorney Licensing", implemented: false },
  VA: { code: "VA", state: "Virginia", adapter: "vsb", authority: "Virginia State Bar", implemented: false },
  WA: { code: "WA", state: "Washington", adapter: "wsba", authority: "Washington State Bar Association", implemented: false },
  WV: { code: "WV", state: "West Virginia", adapter: "wvbar", authority: "West Virginia State Bar", implemented: false },
  WI: { code: "WI", state: "Wisconsin", adapter: "wisbar", authority: "State Bar of Wisconsin", implemented: false },
  WY: { code: "WY", state: "Wyoming", adapter: "wyobar", authority: "Wyoming State Bar", implemented: false },
};

/**
 * Resolve a jurisdiction from whatever the caller has.
 *
 * Trust anchors carry the full state name ("California"); adapter callers and
 * config tend to carry the code ("CA"). Both resolve, because forcing one
 * spelling on the boundary would mean a data-entry difference reads as an
 * unsupported state.
 */
export function resolveState(state: string): StateBarAdapter | null {
  const key = state.trim();
  if (!key) return null;

  const byCode = STATE_ADAPTER_MAP[key.toUpperCase()];
  if (byCode) return byCode;

  const normalized = key.toLowerCase();
  return Object.values(STATE_ADAPTER_MAP).find((e) => e.state.toLowerCase() === normalized) ?? null;
}

// ── Per-state implementations ────────────────────────────────────────────────

/** The registry's `status` strings, narrowed to the union or rejected. */
const KNOWN_STATUSES = new Set(["active", "inactive", "suspended", "not_found"]);

interface CalBarResponse {
  barNumber?: string;
  status?: string;
  attorneyName?: string;
  admissionDate?: string;
  firmName?: string;
  detail?: string;
}

/**
 * California — live in V1.
 *
 * Under CRE this is a Chainlink Functions call whose result is written on-chain
 * by BFT consensus; locally it hits the mock CA Bar adapter on port 3001.
 */
async function verifyBarForState_CA(
  barNumber: string,
  state: string,
  baseUrl: string,
): Promise<BarVerifyResult> {
  const base: BarVerifyResult = { barNumber, state, status: "error", detail: "" };

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/verify/${encodeURIComponent(barNumber)}`);
    if (!res.ok) {
      return {
        ...base,
        detail: `California State Bar lookup failed with HTTP ${res.status}.`,
      };
    }

    const data = (await res.json()) as CalBarResponse;
    const status = (data.status ?? "").toLowerCase();

    // An unrecognized status is an error, not a pass. The registry adding a
    // value we have never seen must not resolve to "active" by default.
    if (!KNOWN_STATUSES.has(status)) {
      return {
        ...base,
        detail: `California State Bar returned an unrecognized status: ${data.status ?? "(none)"}.`,
      };
    }

    return {
      barNumber: data.barNumber ?? barNumber,
      state,
      status: status as BarVerifyResult["status"],
      ...(data.attorneyName && { attorneyName: data.attorneyName }),
      ...(data.admissionDate && { admissionDate: data.admissionDate }),
      ...(data.firmName && { firmName: data.firmName }),
      detail: data.detail ?? `California State Bar reports status: ${status}.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...base, detail: `Could not reach the California State Bar adapter: ${message}` };
  }
}

/**
 * Every state without an implementation.
 *
 * `error` rather than `not_found`: the attorney may well be in perfect
 * standing — we simply have not built the adapter that could tell. Reporting
 * absence of capability as absence of the attorney would be a lie about the
 * registry.
 */
function scaffoldResult(barNumber: string, entry: StateBarAdapter): BarVerifyResult {
  return {
    barNumber,
    state: entry.state,
    status: "error",
    detail: `${entry.state} bar verification — V2 adapter (scaffold)`,
  };
}

// ── Router ───────────────────────────────────────────────────────────────────

/**
 * Verify an attorney's standing with their state bar.
 *
 * Never throws. Every failure path — unknown state, unreachable adapter,
 * malformed response, unimplemented jurisdiction — returns a `BarVerifyResult`
 * with a `detail` an escrow officer can act on, because the caller is a
 * settlement gate and an exception there is indistinguishable from a crash.
 */
export async function verifyBar(
  barNumber: string,
  state: string,
  adapterBaseUrl: string = CALBAR_DEFAULT_BASE_URL,
): Promise<BarVerifyResult> {
  const trimmed = barNumber.trim();
  const entry = resolveState(state);

  if (!entry) {
    return {
      barNumber: trimmed,
      state,
      status: "error",
      detail: `"${state}" is not a recognized US state — no bar verification adapter is routable.`,
    };
  }

  if (!trimmed) {
    return {
      barNumber: trimmed,
      state: entry.state,
      status: "not_found",
      detail: `No bar number was provided for ${entry.state}.`,
    };
  }

  switch (entry.code) {
    case "CA":
      return verifyBarForState_CA(trimmed, entry.state, adapterBaseUrl);
    // V2: one case per state as its adapter lands.
    default:
      return scaffoldResult(trimmed, entry);
  }
}
