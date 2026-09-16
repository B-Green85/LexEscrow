/**
 * BarVerify — multi-state bar association verification (spec §10, "Adapter
 * Library Vision"; §14 V1 roadmap).
 *
 * The legal asset class turns on one fact an escrow cannot assume: that the
 * attorney of record is actually admitted and in good standing *right now*. A
 * retainer release to a suspended attorney is the failure mode this adapter
 * exists to prevent, and a regex over the bar number cannot detect it — a
 * disbarred attorney's number is still six digits.
 *
 * Fifty jurisdictions, fifty registries, no common API. V1 routed one of them
 * to a mock adapter on `localhost:3001` that was never running outside a demo,
 * so every real session failed this step. The lookup now goes to the Rust
 * backend, which queries fourteen official registries through a single Apify
 * actor with a vault-held token; the remaining thirty-six stay declared and
 * unroutable.
 *
 * This module keeps the interpretation — the safety-critical part. Five of its
 * eight statuses are *not* verdicts about the attorney, and collapsing any of
 * them into one would be the bug:
 *
 *   * `unsupported_state` — no crawler covers this jurisdiction.
 *   * `not_configured`    — no Apify token, so nothing was ever asked.
 *   * `unavailable`       — the registry was not reached, or refused.
 *   * `not_found`         — the registry answered and holds no such attorney.
 *   * `error`             — the registry answered with something unreadable.
 *
 * None of them is ever `active`, so the gate stays shut either way. What
 * changes is what the officer is told to do, and whether the session survives:
 * "we cannot check this" must not read as "this attorney is not in good
 * standing", and neither must halt a run over a fact about our configuration
 * rather than about the transaction.
 */

import * as backend from "../backend";

/** Every outcome a bar lookup can produce. */
export interface BarVerifyResult {
  barNumber: string;
  state: string;
  status:
    | "active"
    | "inactive"
    | "suspended"
    | "not_found"
    | "error"
    | "unavailable"
    | "not_configured"
    | "unsupported_state";
  attorneyName?: string;
  admissionDate?: string;
  firmName?: string;
  /**
   * A public disciplinary record against this attorney.
   *
   * Independent of `status` on purpose: an attorney can be `active` and still
   * carry a formal reprimand, and the officer needs to see that before
   * releasing a retainer. Absent means the registry did not say, which is not
   * the same as "clean".
   */
  hasPublicDiscipline?: boolean;
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

/**
 * What produced a verdict, recorded on the condition row and in the audit
 * trail. Replaces the `localhost:3001` mock adapter base URL that used to sit
 * here — the registry is now reached through a single Apify actor rather than
 * one HTTP endpoint per state, so there is a source to name but no base URL to
 * configure.
 */
export const BAR_VERIFY_SOURCE = "apify/jungle_synthesizer~multi-state-bar-scraper";

/**
 * The fourteen jurisdictions the actor actually crawls, as its input schema
 * enumerates them.
 *
 * Kept next to the routing table rather than derived from it so the two can be
 * cross-checked: `implemented` below is this list, and a state drifting out of
 * agreement is a test failure rather than a silent empty result.
 */
export const APIFY_SUPPORTED_STATES = [
  "AZ", "CA", "FL", "GA", "ID", "IL", "MA", "MN", "NJ", "NY", "OH", "PA", "TN", "TX",
] as const;

/**
 * What `detail` leads with when the registry could not be reached.
 *
 * Exported so the pipeline and its tests name the same disposition rather than
 * matching on prose: this string *is* the instruction to the officer, and the
 * underlying transport error is appended after it as the reason.
 */
export const BAR_VERIFY_UNAVAILABLE = "Bar verification unavailable — manual review required.";

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
  AZ: { code: "AZ", state: "Arizona", adapter: "azbar", authority: "State Bar of Arizona", implemented: true },
  AR: { code: "AR", state: "Arkansas", adapter: "arkbar", authority: "Arkansas Judiciary — Office of Professional Conduct", implemented: false },
  CA: { code: "CA", state: "California", adapter: "calbar", authority: "The State Bar of California", implemented: true },
  CO: { code: "CO", state: "Colorado", adapter: "coloradobar", authority: "Colorado Supreme Court — Office of Attorney Registration", implemented: false },
  CT: { code: "CT", state: "Connecticut", adapter: "ctbar", authority: "Connecticut Judicial Branch — Statewide Grievance Committee", implemented: false },
  DE: { code: "DE", state: "Delaware", adapter: "debar", authority: "Delaware State Bar Association", implemented: false },
  FL: { code: "FL", state: "Florida", adapter: "floridabar", authority: "The Florida Bar", implemented: true },
  GA: { code: "GA", state: "Georgia", adapter: "gabar", authority: "State Bar of Georgia", implemented: true },
  HI: { code: "HI", state: "Hawaii", adapter: "hsba", authority: "Hawaii State Bar Association", implemented: false },
  ID: { code: "ID", state: "Idaho", adapter: "idahobar", authority: "Idaho State Bar", implemented: true },
  IL: { code: "IL", state: "Illinois", adapter: "iardc", authority: "Illinois Attorney Registration and Disciplinary Commission", implemented: true },
  IN: { code: "IN", state: "Indiana", adapter: "inbar", authority: "Indiana Supreme Court — Roll of Attorneys", implemented: false },
  IA: { code: "IA", state: "Iowa", adapter: "iowabar", authority: "Iowa Judicial Branch — Office of Professional Regulation", implemented: false },
  KS: { code: "KS", state: "Kansas", adapter: "ksbar", authority: "Kansas Office of Judicial Administration — Attorney Registration", implemented: false },
  KY: { code: "KY", state: "Kentucky", adapter: "kybar", authority: "Kentucky Bar Association", implemented: false },
  LA: { code: "LA", state: "Louisiana", adapter: "labar", authority: "Louisiana State Bar Association", implemented: false },
  ME: { code: "ME", state: "Maine", adapter: "mainebar", authority: "Maine Board of Overseers of the Bar", implemented: false },
  MD: { code: "MD", state: "Maryland", adapter: "mdbar", authority: "Maryland Judiciary — Attorney Information System", implemented: false },
  MA: { code: "MA", state: "Massachusetts", adapter: "mabbo", authority: "Massachusetts Board of Bar Overseers", implemented: true },
  MI: { code: "MI", state: "Michigan", adapter: "michbar", authority: "State Bar of Michigan", implemented: false },
  MN: { code: "MN", state: "Minnesota", adapter: "mnbar", authority: "Minnesota Lawyer Registration Office", implemented: true },
  MS: { code: "MS", state: "Mississippi", adapter: "msbar", authority: "The Mississippi Bar", implemented: false },
  MO: { code: "MO", state: "Missouri", adapter: "mobar", authority: "The Missouri Bar", implemented: false },
  MT: { code: "MT", state: "Montana", adapter: "montanabar", authority: "State Bar of Montana", implemented: false },
  NE: { code: "NE", state: "Nebraska", adapter: "nebar", authority: "Nebraska State Bar Association", implemented: false },
  NV: { code: "NV", state: "Nevada", adapter: "nvbar", authority: "State Bar of Nevada", implemented: false },
  NH: { code: "NH", state: "New Hampshire", adapter: "nhbar", authority: "New Hampshire Bar Association", implemented: false },
  NJ: { code: "NJ", state: "New Jersey", adapter: "njbar", authority: "New Jersey Courts — Attorney Registration", implemented: true },
  NM: { code: "NM", state: "New Mexico", adapter: "nmbar", authority: "State Bar of New Mexico", implemented: false },
  NY: { code: "NY", state: "New York", adapter: "nysbar", authority: "New York State Unified Court System — Attorney Registration", implemented: true },
  NC: { code: "NC", state: "North Carolina", adapter: "ncbar", authority: "North Carolina State Bar", implemented: false },
  ND: { code: "ND", state: "North Dakota", adapter: "ndbar", authority: "State Bar Association of North Dakota", implemented: false },
  OH: { code: "OH", state: "Ohio", adapter: "ohiobar", authority: "Supreme Court of Ohio — Office of Attorney Services", implemented: true },
  OK: { code: "OK", state: "Oklahoma", adapter: "okbar", authority: "Oklahoma Bar Association", implemented: false },
  OR: { code: "OR", state: "Oregon", adapter: "osbar", authority: "Oregon State Bar", implemented: false },
  PA: { code: "PA", state: "Pennsylvania", adapter: "padb", authority: "Disciplinary Board of the Supreme Court of Pennsylvania", implemented: true },
  RI: { code: "RI", state: "Rhode Island", adapter: "ribar", authority: "Rhode Island Supreme Court — Attorney Registration", implemented: false },
  SC: { code: "SC", state: "South Carolina", adapter: "scbar", authority: "South Carolina Bar", implemented: false },
  SD: { code: "SD", state: "South Dakota", adapter: "sdbar", authority: "State Bar of South Dakota", implemented: false },
  TN: { code: "TN", state: "Tennessee", adapter: "tnbpr", authority: "Tennessee Board of Professional Responsibility", implemented: true },
  TX: { code: "TX", state: "Texas", adapter: "texasbar", authority: "State Bar of Texas", implemented: true },
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

// ── Interpretation ───────────────────────────────────────────────────────────

/**
 * Registry status strings that mean "may not practice".
 *
 * Mapped rather than passed through because the union the caller branches on is
 * fixed, and the registries between them emit at least six spellings of "no".
 * `disbarred` lands on `suspended`: both mean the licence does not currently
 * authorize practice, which is the only distinction the gate acts on — the
 * exact word survives in `detail`.
 */
const STATUS_MAP: Record<string, BarVerifyResult["status"]> = {
  active: "active",
  inactive: "inactive",
  suspended: "suspended",
  disbarred: "suspended",
  retired: "inactive",
  deceased: "inactive",
};

/**
 * Turn the backend verdict into a routed result.
 *
 * Exported for tests: this is where "no token" is told apart from "no such
 * attorney", and getting that wrong shows up as a red banner on a screen rather
 * than as a thrown error.
 */
export function interpretBackendResult(
  raw: backend.BarVerifyApiResult,
  barNumber: string,
  stateName: string,
): BarVerifyResult {
  const base: BarVerifyResult = {
    barNumber,
    state: stateName,
    status: "error",
    detail: "",
    ...(raw.hasPublicDiscipline && { hasPublicDiscipline: true }),
  };

  if (raw.error) {
    // Not configured is a fact about this install, not about the attorney, and
    // it is the one failure the officer can fix in thirty seconds. It is held
    // apart from every other error so the UI can render it neutrally.
    if (raw.error === backend.BAR_VERIFY_NOT_CONFIGURED) {
      return { ...base, status: "not_configured", detail: raw.error };
    }
    if (raw.error.startsWith("Bar verification does not cover")) {
      return { ...base, status: "unsupported_state", detail: raw.error };
    }
    // Everything else — unreachable gateway, non-2xx, unreadable body — is a
    // registry we did not get an answer from.
    console.warn("bar verification unavailable", stateName, raw.error);
    return { ...base, status: "unavailable", detail: `${BAR_VERIFY_UNAVAILABLE} ${raw.error}` };
  }

  // No error and no status: the registry answered and holds no such attorney.
  if (!raw.licenseStatus) {
    return {
      ...base,
      status: "not_found",
      detail: `${stateName} bar registry has no record for bar number ${barNumber}.`,
    };
  }

  const mapped = STATUS_MAP[raw.licenseStatus.trim().toLowerCase()];

  // A status the registries have never emitted before must not resolve to
  // "active" by default.
  if (!mapped) {
    return {
      ...base,
      detail: `${stateName} bar registry returned an unrecognized status: ${raw.licenseStatus}.`,
    };
  }

  const discipline = raw.hasPublicDiscipline
    ? " Public disciplinary record on file."
    : "";

  return {
    ...base,
    status: mapped,
    ...(raw.name && { attorneyName: raw.name }),
    detail: `${stateName} bar registry reports status: ${raw.licenseStatus}.${discipline}`,
  };
}

// ── Router ───────────────────────────────────────────────────────────────────

/**
 * Verify an attorney's standing with their state bar.
 *
 * Never throws. Every failure path — unknown state, uncovered jurisdiction,
 * missing token, unreachable registry, malformed response — returns a
 * `BarVerifyResult` with a `detail` an escrow officer can act on, because the
 * caller is a settlement gate and an exception there is indistinguishable from
 * a crash.
 */
export async function verifyBar(barNumber: string, state: string): Promise<BarVerifyResult> {
  const trimmed = barNumber.trim();
  const entry = resolveState(state);

  if (!entry) {
    return {
      barNumber: trimmed,
      state,
      status: "unsupported_state",
      detail: `"${state}" is not a recognized US state — no bar verification adapter is routable.`,
    };
  }

  if (!entry.implemented) {
    return {
      barNumber: trimmed,
      state: entry.state,
      status: "unsupported_state",
      detail:
        `Bar verification does not cover ${entry.state} — supported states are ` +
        `${APIFY_SUPPORTED_STATES.join(", ")}.`,
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

  // The backend resolves the state to the actor's two-letter code itself; the
  // full name is passed because that is what the trust anchors carry, and it
  // round-trips through one normalizer rather than two.
  let raw: backend.BarVerifyApiResult;
  try {
    raw = await backend.verifyBarNumber(trimmed, entry.code);
  } catch (e) {
    // The command is written never to reject, so this is belt-and-braces: an
    // IPC fault, not a registry verdict.
    const message = e instanceof Error ? e.message : String(e);
    console.warn("bar verification transport failed", entry.state, message);
    return {
      barNumber: trimmed,
      state: entry.state,
      status: "unavailable",
      detail: `${BAR_VERIFY_UNAVAILABLE} ${message}`,
    };
  }

  return interpretBackendResult(raw, trimmed, entry.state);
}
