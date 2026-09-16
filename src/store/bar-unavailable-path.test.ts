// @vitest-environment jsdom
/**
 * What `beginProcessing` does when the bar registry cannot be reached.
 *
 * Step 2 of the pipeline used to treat every non-`active` verdict the same way:
 * fail the session and stop. That is right for a suspended attorney and wrong
 * for a refused connection — one is a fact about the transaction, the other is
 * a fact about the network, and only the first is a reason to throw away the
 * parse and every validation behind it.
 *
 * So this file asserts both halves of the fallback at once: processing reaches
 * the AI parse, *and* the release gate is no looser for it. The second half is
 * the one worth breaking a build over — "keep going" must never quietly mean
 * "let it through".
 *
 * Driven over the Clio intake path purely because it needs no artifact to be
 * mocked; step 2 is identical on both intake paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "./session";
import * as backend from "../lib/backend";
import * as providers from "../lib/ai/providers";
import * as adapters from "../lib/adapters";
import { BAR_VERIFY_UNAVAILABLE } from "../lib/adapters";
import { BAR_VERIFY_NOT_CONFIGURED } from "../lib/backend";
import { ExecutionPath, type ParsedRetainerPayload } from "../lexguard/types";
import type { ClioMatterPayload } from "../lib/clio";

const MATTER: ClioMatterPayload = {
  matterId: 4321,
  displayNumber: "00123-Anderson",
  description: "Anderson v. Wexler",
  status: "open",
  billingMethod: "hourly",
  openDate: "2026-01-15",
  closeDate: null,
  clientName: "Jane Anderson",
  clientEmail: "jane.anderson.private@example.test",
  clientPhone: "+15550100",
  parties: [],
  bills: [],
  trustBalanceCents: 3_000_000,
  fetchedAt: "2026-09-05T12:00:00Z",
};

const PARSED: ParsedRetainerPayload = {
  clientId: "00123-Anderson",
  lawFirmWallet: "0x0000000000000000000000000000000000000000",
  clientWallet: "0x0000000000000000000000000000000000000000",
  totalHeld: 30_000,
  earnedFees: 5_000,
  unearnedBalance: 25_000,
  disputedHours: 0,
  disputedAmount: 0,
  signaturesVerified: true,
  recommendedPath: ExecutionPath.DirectSettlement,
  anomaliesFlagged: [],
  anomaliesSuppressed: false,
  barNumber: "123456",
};

/** What the adapter returns when nothing answered on the wire. */
const UNAVAILABLE = {
  barNumber: "123456",
  state: "California",
  status: "unavailable" as const,
  detail: `${BAR_VERIFY_UNAVAILABLE} Could not reach the California State Bar adapter: ECONNREFUSED`,
};

/** The other non-verdict: no Apify token, so nothing was ever asked. */
const NOT_CONFIGURED = {
  barNumber: "123456",
  state: "California",
  status: "not_configured" as const,
  detail: BAR_VERIFY_NOT_CONFIGURED,
};

let audit: Array<[string, string]>;
let parseSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  audit = [];

  vi.spyOn(backend, "isTauri").mockReturnValue(false);
  vi.spyOn(backend, "vaultStatus").mockResolvedValue({ exists: true, unlocked: true });
  vi.spyOn(backend, "createSession").mockResolvedValue(undefined);
  vi.spyOn(backend, "updateSessionState").mockResolvedValue(undefined);
  vi.spyOn(backend, "getIntegrationConfigs").mockResolvedValue({});
  vi.spyOn(backend, "saveCondition").mockResolvedValue(undefined as never);
  vi.spyOn(backend, "getClioPublic").mockResolvedValue({
    appId: "app-1234",
    clientId: "client-abc",
    redirectUri: "http://127.0.0.1:8080/callback",
    hasClientSecret: true,
    hasCredentials: true,
    connected: true,
    tokenExpiresAt: "2026-09-05T13:00:00Z",
  });
  vi.spyOn(backend, "logEvent").mockImplementation(async (_s, eventType, _u, payloadJson) => {
    audit.push([eventType, payloadJson]);
    return {
      logId: audit.length,
      sessionId: "s",
      eventType,
      userIdentity: "u",
      payloadJson,
      blockTimestamp: "",
      previousHash: null,
      entryHash: "",
    };
  });

  // The subject: the registry could not be reached.
  vi.spyOn(adapters, "verifyBar").mockResolvedValue(UNAVAILABLE as never);

  parseSpy = vi.fn().mockResolvedValue(PARSED);
  vi.spyOn(providers, "resolveProvider").mockResolvedValue({
    label: "Stub",
    parse: parseSpy,
    correct: vi.fn().mockResolvedValue(null),
  } as never);

  useSession.setState({
    intakeSource: "clio",
    clioMatter: MATTER,
    file: null,
    assetClass: "legal",
    entryMode: "ai",
    anchors: {
      attorneyBarNumber: "123456",
      state: "California",
      clientFullLegalName: "Jane Anderson",
      clientEmail: "jane.anderson.private@example.test",
      clientPhone: "+15550100",
    },
    error: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an unreachable bar registry", () => {
  it("continues to the AI parse instead of halting the session", async () => {
    await useSession.getState().beginProcessing();

    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(backend.updateSessionState).mock.calls.map(([, s]) => s)).toContain("PARSING");
  });

  it("raises no fatal error and never fails the session", async () => {
    await useSession.getState().beginProcessing();

    expect(useSession.getState().error).toBeNull();
    expect(vi.mocked(backend.updateSessionState).mock.calls.map(([, s]) => s)).not.toContain(
      "FAILED",
    );
  });

  it("marks the step amber with what the officer has to do", async () => {
    await useSession.getState().beginProcessing();

    const step = useSession.getState().steps.find((s) => s.key === "bar");
    // Amber, not red: the registry said nothing about this attorney, so the
    // check still has to be finished by hand — but nothing about the
    // transaction has failed. Red is reserved for a check that ran and did not
    // pass.
    expect(step?.status).toBe("warning");
    expect(step?.label).toContain("manual review required");
  });

  it("leaves standing unknown rather than asserting the attorney failed", async () => {
    await useSession.getState().beginProcessing();

    // Null, not false: false is a claim about the attorney that nothing here
    // supports. The adapter's verdict is kept whole alongside it.
    expect(useSession.getState().barActive).toBeNull();
    expect(useSession.getState().barVerifyResult?.status).toBe("unavailable");
  });

  it("records the failure in the audit trail", async () => {
    await useSession.getState().beginProcessing();

    const entry = audit.find(([event]) => event === "bar_verification_result");
    expect(entry).toBeDefined();
    const payload = JSON.parse(entry![1]);
    expect(payload.active).toBe(false);
    expect(payload.status).toBe("unavailable");
    expect(payload.detail).toContain("manual review required");
  });

  it("keeps the release gate shut", async () => {
    // The whole point of continuing: the parse is salvaged, the money is not
    // released. The bar condition is pending — neither met nor waived — and
    // `allMet` requires every condition to be one or the other.
    await useSession.getState().beginProcessing();
    useSession.getState().initConditions();

    const bar = useSession.getState().conditions.find((c) => c.type === "bar_verify");
    expect(bar?.status).toBe("pending");
    // No `failureReason` inventing a verdict about the attorney…
    expect(bar?.failureReason).toBeUndefined();
    // …but the reason the officer needs is on the condition itself.
    expect(bar?.description).toContain("manual review required");
    expect(useSession.getState().conditionSummary.allMet).toBe(false);
  });
});

/**
 * An unconfigured Apify token must not look like a failed transaction.
 *
 * This is the distinction the Processing screen turns into colour: red means a
 * check ran and did not pass, and a blank field in Configuration is neither. An
 * officer who sees red here starts investigating an escrow that is fine.
 */
describe("an unconfigured bar verification", () => {
  beforeEach(() => {
    vi.spyOn(adapters, "verifyBar").mockResolvedValue(NOT_CONFIGURED as never);
  });

  it("marks the step neutral grey, not red and not amber", async () => {
    await useSession.getState().beginProcessing();

    const step = useSession.getState().steps.find((s) => s.key === "bar");
    expect(step?.status).toBe("advisory");
    expect(step?.status).not.toBe("error");
    expect(step?.status).not.toBe("warning");
    expect(step?.label).toContain("Apify token");
  });

  it("does not halt processing or fail the session", async () => {
    await useSession.getState().beginProcessing();

    expect(useSession.getState().error).toBeNull();
    expect(vi.mocked(backend.updateSessionState).mock.calls.map(([, s]) => s)).not.toContain(
      "FAILED",
    );
  });

  it("leaves standing unknown rather than asserting the attorney failed", async () => {
    await useSession.getState().beginProcessing();
    expect(useSession.getState().barActive).toBeNull();
  });

  it("keeps the release gate shut", async () => {
    // Continuing is not the same as passing: an unverified attorney still
    // blocks the release, exactly as an unreachable registry does.
    await useSession.getState().beginProcessing();
    useSession.getState().initConditions();

    const bar = useSession.getState().conditions.find((c) => c.type === "bar_verify");
    expect(bar?.status).toBe("pending");
    expect(useSession.getState().conditionSummary.allMet).toBe(false);
  });

  it("records the source actor in the audit trail", async () => {
    await useSession.getState().beginProcessing();

    const entry = audit.find(([event]) => event === "bar_verification_result");
    expect(entry).toBeDefined();
    const payload = JSON.parse(entry![1]);
    expect(payload.status).toBe("not_configured");
    expect(payload.verified).toBe(false);
    expect(payload.has_public_discipline).toBe(false);
    expect(payload.source).toBe("apify/jungle_synthesizer~multi-state-bar-scraper");
  });
});
