// @vitest-environment jsdom
/**
 * The Clio intake path through `beginProcessing`.
 *
 * Everything downstream of the parse is shared with the Artifact Loader, so
 * what is under test here is only the fork: what stands in for a document hash,
 * what the AI is handed, what ArtifactGuard skips — and, above all, what
 * reaches SQLite.
 *
 * That last one is Clio ToS §10(e) and it is the reason this file exists. The
 * Rust side guarantees `clio_fetch_matter` cannot persist, because the command
 * takes no database handle. This is the other half: the *store* holds the whole
 * matter in memory, so it is the layer with both the Clio data and a route to
 * the audit trail — and the one place a client's email or a bill's balance
 * could plausibly be written by accident.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "./session";
import * as backend from "../lib/backend";
import * as providers from "../lib/ai/providers";
import * as adapters from "../lib/adapters";
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
  parties: [
    {
      name: "Marcus Wexler",
      email: "marcus.wexler.private@example.test",
      phone: "+15550199",
      isClient: false,
      isBillRecipient: false,
    },
  ],
  bills: [
    {
      number: "INV-SECRET-001",
      totalCents: 1_250_000,
      paidCents: 500_000,
      balanceCents: 750_000,
      state: "awaiting_payment",
      issuedAt: "2026-08-01",
      dueAt: null,
      memo: "confidential billing memo",
    },
  ],
  trustBalanceCents: 3_000_000,
  fetchedAt: "2026-09-05T12:00:00Z",
};

/** Every value in the fetched matter that Clio owns and LexEscrow may not keep. */
const CLIO_OWNED_VALUES = [
  "jane.anderson.private@example.test",
  "marcus.wexler.private@example.test",
  "+15550199",
  "INV-SECRET-001",
  "confidential billing memo",
  "Anderson v. Wexler",
  "awaiting_payment",
];

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

/** Every `logEvent` call, as (eventType, payloadJson). */
let audit: Array<[string, string]>;
let parseSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  audit = [];

  vi.spyOn(backend, "isTauri").mockReturnValue(false);
  // Unlocked, so `ensureCredentials` resolves without raising the vault prompt.
  vi.spyOn(backend, "vaultStatus").mockResolvedValue({ exists: true, unlocked: true });
  vi.spyOn(backend, "createSession").mockResolvedValue(undefined);
  vi.spyOn(backend, "updateSessionState").mockResolvedValue(undefined);
  vi.spyOn(backend, "getIntegrationConfigs").mockResolvedValue({});
  vi.spyOn(backend, "saveCondition").mockResolvedValue(undefined);
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

  // Bar verification passes; the adapter is not what this file is about.
  vi.spyOn(adapters, "verifyBar").mockResolvedValue({
    status: "active",
    state: "California",
    detail: "Active member in good standing.",
    attorneyName: "A. Lawyer",
    admissionDate: null,
    firmName: null,
  } as never);

  parseSpy = vi.fn().mockResolvedValue(PARSED);
  vi.spyOn(providers, "resolveProvider").mockResolvedValue({
    label: "Stub",
    parse: parseSpy,
    correct: vi.fn().mockResolvedValue(null),
  } as never);

  useSession.setState({
    // The store is a module singleton, so the screen and the checklist have to
    // be put back — the Continue-gate tests assert on whether the screen
    // advances, and the condition tests count rows.
    screen: "load",
    conditions: [],
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

describe("Clio intake through beginProcessing", () => {
  it("refuses to start with no matter selected", async () => {
    useSession.setState({ clioMatter: null });
    await useSession.getState().beginProcessing();

    expect(useSession.getState().error).toBe("Select a Clio matter before continuing.");
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("derives a clio: identifier instead of hashing a document", async () => {
    const loadArtifact = vi.spyOn(backend, "loadArtifact");
    await useSession.getState().beginProcessing();

    // There is no artifact, so ArtifactGuard's hashing path is never entered.
    expect(loadArtifact).not.toHaveBeenCalled();

    const [session] = vi.mocked(backend.createSession).mock.calls[0];
    expect(session.documentHash.startsWith("clio:")).toBe(true);
    // Emphatically not `sha256:` — nothing downstream may read this as evidence
    // about a document's contents.
    expect(session.documentHash.startsWith("sha256:")).toBe(false);
  });

  it("is deterministic — the same matter names the same session identifier", async () => {
    await useSession.getState().beginProcessing();
    const first = vi.mocked(backend.createSession).mock.calls[0][0].documentHash;

    vi.mocked(backend.createSession).mockClear();
    useSession.setState({ clioMatter: MATTER, intakeSource: "clio", error: null });
    await useSession.getState().beginProcessing();

    expect(vi.mocked(backend.createSession).mock.calls[0][0].documentHash).toBe(first);
  });

  it("hands the AI the matter as JSON, tagged as Clio intake", async () => {
    await useSession.getState().beginProcessing();

    expect(parseSpy).toHaveBeenCalledTimes(1);
    const [userMessage, , intake] = parseSpy.mock.calls[0];
    expect(intake).toBe("clio");

    // JSON, not document text — and the payload the model reads is the one that
    // was fetched.
    const parsed = JSON.parse(userMessage as string);
    expect(parsed.matterId).toBe(4321);
    expect(parsed.trustBalanceCents).toBe(3_000_000);
  });

  it("skips AnchorReceipt registration — there is no document to attest to", async () => {
    await useSession.getState().beginProcessing();

    expect(useSession.getState().anchorReceipt).toBeNull();
    // …and the step is settled rather than left looking stalled.
    const anchorStep = useSession.getState().steps.find((s) => s.key === "anchor");
    expect(anchorStep?.status).toBe("done");
  });

  it("records the intake source and the matter reference in the audit trail", async () => {
    await useSession.getState().beginProcessing();

    const loaded = audit.find(([event]) => event === "document_loaded");
    expect(loaded).toBeDefined();
    const payload = JSON.parse(loaded![1]);
    expect(payload.intake_source).toBe("clio");
    expect(payload.matter_id).toBe(4321);
    expect(payload.matter_reference).toBe("00123-Anderson");
  });

  // ── ToS §10(e) ─────────────────────────────────────────────────────────────

  it("writes no Clio-owned field to the audit trail", async () => {
    // The constraint, asserted against every value in the fetched matter that
    // belongs to Clio rather than to LexEscrow. What LexEscrow may record is its
    // own derived data — the intake identifier, the matter id, the reference
    // number — and that is all this path writes.
    await useSession.getState().beginProcessing();

    const everythingWritten = audit.map(([event, payload]) => `${event} ${payload}`).join("\n");
    for (const value of CLIO_OWNED_VALUES) {
      expect(everythingWritten).not.toContain(value);
    }
  });

  it("writes no Clio-owned field through createSession", async () => {
    await useSession.getState().beginProcessing();

    const written = JSON.stringify(vi.mocked(backend.createSession).mock.calls[0][0]);
    for (const value of CLIO_OWNED_VALUES) {
      expect(written).not.toContain(value);
    }
  });

  // ── The Continue gate (Document Load → Processing) ─────────────────────────

  it("continues past Document Load with no document uploaded", () => {
    // The whole point of the path: a Clio matter *is* the intake, so there is
    // never a retainer file to attach, and the gate that demanded one made the
    // path unreachable from the UI regardless of what `beginProcessing` could
    // do with it.
    useSession.getState().goToProcessing();

    expect(useSession.getState().screen).toBe("processing");
    expect(useSession.getState().error).toBeNull();
  });

  it("never asks a Clio session for a retainer document", () => {
    useSession.setState({ clioMatter: null });
    useSession.getState().goToProcessing();

    expect(useSession.getState().error).toBe("Select a Clio matter before continuing.");
    expect(useSession.getState().error).not.toContain("retainer document");
    expect(useSession.getState().screen).not.toBe("processing");
  });

  it("still requires a document on the artifact path", () => {
    useSession.setState({ intakeSource: "artifact", clioMatter: null, file: null });
    useSession.getState().goToProcessing();

    expect(useSession.getState().error).toBe("Please add a retainer document before continuing.");
    expect(useSession.getState().screen).not.toBe("processing");
  });

  // ── Processing screen labels ───────────────────────────────────────────────

  it("labels the first two steps for what the Clio path actually does", () => {
    useSession.getState().goToProcessing();
    const labels = Object.fromEntries(useSession.getState().steps.map((s) => [s.key, s.label]));

    // Nothing is hashed and no AnchorReceipt is sealed — see the skip in
    // `beginProcessing`. Labels claiming otherwise would misdescribe what the
    // session holds.
    expect(labels.hash).toBe("Generating session identifier");
    expect(labels.anchor).toBe("Registering matter reference");
    expect(labels.bar).toBe("Verifying attorney");
    expect(labels.ai).toBe("AI parsing");
    expect(labels.lexguard).toBe("LexGuard validating");
  });

  it("keeps the Clio labels once processing is running", async () => {
    await useSession.getState().beginProcessing();
    const labels = Object.fromEntries(useSession.getState().steps.map((s) => [s.key, s.label]));

    expect(labels.hash).toBe("Generating session identifier");
    expect(labels.anchor).toBe("Registering matter reference");
  });

  it("leaves the artifact path's labels alone", () => {
    useSession.setState({
      intakeSource: "artifact",
      clioMatter: null,
      file: new File(["retainer"], "retainer.pdf", { type: "application/pdf" }),
    });
    useSession.getState().goToProcessing();
    const labels = Object.fromEntries(useSession.getState().steps.map((s) => [s.key, s.label]));

    expect(labels.hash).toBe("Hashing artifacts");
    expect(labels.anchor).toBe("Registering with AnchorReceipt");
  });

  // ── VDB priming ────────────────────────────────────────────────────────────

  it("primes the VDB from the matter, keyed by the clio: identifier", async () => {
    await useSession.getState().beginProcessing();

    const vdb = useSession.getState().vdb;
    expect(vdb).not.toBeNull();
    // The VDB is normally tied to an artifact's SHA-256. With no artifact, the
    // deterministic intake identifier is what binds the store to its source.
    expect(vdb!.artifactHash.startsWith("clio:")).toBe(true);

    // Dollars, not the cents integers the AI reads. `clioVdbText` does that
    // conversion precisely so LexGuard's co-validation compares $30,000.00
    // against $30,000.00 rather than against 3000000 and escalates every Clio
    // session on what is only an encoding difference.
    const numerics = vdb!.entries.filter((e) => e.type === "numeric");
    expect(numerics.some((e) => Number(e.value) === 30_000)).toBe(true);
    expect(numerics.some((e) => Number(e.value) === 3_000_000)).toBe(false);
  });

  // ── The condition checklist ────────────────────────────────────────────────

  it("waives the ArtifactGuard document condition when conditions are built", async () => {
    await useSession.getState().beginProcessing();
    useSession.getState().navigateToConditions();

    const docs = useSession.getState().conditions.filter((c) => c.type === "document");
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("waived");
    expect(docs[0].failureReason).toBe(
      "Clio matter intake — document registration not applicable.",
    );
  });

  it("does not let the waived document condition block settlement", async () => {
    await useSession.getState().beginProcessing();
    useSession.getState().navigateToConditions();

    const { conditions, conditionSummary } = useSession.getState();
    // Nothing is left pending or failed on account of a document that this
    // intake path was never going to produce.
    expect(conditions.some((c) => c.type === "document" && c.status !== "waived")).toBe(false);
    expect(conditionSummary.pending).toBe(0);
    expect(conditionSummary.failed).toBe(0);
    expect(conditionSummary.allMet).toBe(true);
  });

  it("keeps the waiver across a poll tick", async () => {
    // `updateConditions` is the 30-second sweep. It re-runs the builder and
    // merges, and the id is deterministic, so the row must neither duplicate
    // nor revert.
    await useSession.getState().beginProcessing();
    useSession.getState().navigateToConditions();
    useSession.getState().updateConditions();

    const docs = useSession.getState().conditions.filter((c) => c.type === "document");
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("waived");
  });

  it("persists the waived status and its reason", async () => {
    await useSession.getState().beginProcessing();
    useSession.getState().navigateToConditions();
    // The persistence loop is fire-and-forget; let it drain.
    await new Promise((r) => setTimeout(r, 0));

    const saved = vi
      .mocked(backend.saveCondition)
      .mock.calls.map(([c]) => c)
      .find((c) => c.conditionType === "document");
    expect(saved).toBeDefined();
    expect(saved!.status).toBe("waived");
    expect(saved!.label).toBe("Document registration — not applicable");
  });

  it("leaves every other condition type alone", async () => {
    await useSession.getState().beginProcessing();
    useSession.getState().navigateToConditions();

    // The bar check still runs and still reports its own verdict — waiving the
    // document condition must not have waived anything else.
    const bar = useSession.getState().conditions.find((c) => c.type === "bar_verify");
    expect(bar).toBeDefined();
    expect(bar!.status).toBe("met");
    expect(
      useSession.getState().conditions.filter((c) => c.status === "waived"),
    ).toHaveLength(1);
  });

  it("drops the matter from memory on reset", async () => {
    // Session scope means session scope: starting a new transaction must not
    // leave the previous firm's matter sitting in the store.
    await useSession.getState().beginProcessing();
    expect(useSession.getState().clioMatter).not.toBeNull();

    useSession.getState().reset();
    expect(useSession.getState().clioMatter).toBeNull();
  });
});
