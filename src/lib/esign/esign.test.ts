/**
 * eSign layer tests — the mock provider's lifecycle simulation and the
 * completion pipeline's anchor-matching logic (spec §20, §23).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockDocuSignProvider, DEMO_CERTIFICATE_TEXT, DEMO_ENVELOPE_PREFIX } from "./mock-docusign-provider";
import { isTerminal, toESignStatus, type ESignSigner } from "./types";
import { signersMatchAnchors, useSession } from "../../store/session";
import { resolveESignProvider, resetMockESignProvider } from "./index";
import { deriveSigners } from "../../screens/ConditionDefinition";
import { ASSET_CLASS_LIST, ASSET_CLASSES, emptyAnchorsFor, anchorsToTrustAnchors } from "../assetClasses";
import type { TrustAnchors } from "../../lexguard/types";

const EMPTY_DOC = new Uint8Array([1, 2, 3]);

function signer(name: string, email = "a@example.com"): ESignSigner {
  return { name, email, role: "Buyer", routingOrder: 1 };
}

async function send(p: MockDocuSignProvider, label = "doc.pdf"): Promise<string> {
  return p.sendEnvelope("wf-1", EMPTY_DOC, label, [signer("Jane Anderson")], "Subject", "Message");
}

// ── MockDocuSignProvider ─────────────────────────────────────────────────────

describe("MockDocuSignProvider", () => {
  let provider: MockDocuSignProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    // A fixed epoch keeps envelope IDs and ages deterministic.
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));
    provider = new MockDocuSignProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports its provider name", () => {
    expect(provider.providerName()).toBe("DocuSign (demo)");
  });

  it("sendEnvelope returns an envelope ID with the demo prefix", async () => {
    const id = await send(provider);
    expect(id.startsWith(DEMO_ENVELOPE_PREFIX)).toBe(true);
  });

  it("pollStatus returns 'sent' immediately after creation", async () => {
    const id = await send(provider);
    await expect(provider.pollStatus(id)).resolves.toBe("sent");
  });

  it("pollStatus stays 'sent' just before the 10s boundary", async () => {
    const id = await send(provider);
    vi.advanceTimersByTime(9_999);
    await expect(provider.pollStatus(id)).resolves.toBe("sent");
  });

  it("pollStatus returns 'delivered' after 10 seconds", async () => {
    const id = await send(provider);
    vi.advanceTimersByTime(10_000);
    await expect(provider.pollStatus(id)).resolves.toBe("delivered");
  });

  it("pollStatus stays 'delivered' just before the 30s boundary", async () => {
    const id = await send(provider);
    vi.advanceTimersByTime(29_999);
    await expect(provider.pollStatus(id)).resolves.toBe("delivered");
  });

  it("pollStatus returns 'completed' after 30 seconds", async () => {
    const id = await send(provider);
    vi.advanceTimersByTime(30_000);
    await expect(provider.pollStatus(id)).resolves.toBe("completed");
  });

  it("getCertificate returns the demo certificate bytes", async () => {
    const id = await send(provider);
    vi.advanceTimersByTime(30_000);
    const bytes = await provider.getCertificate(id);
    expect(new TextDecoder().decode(bytes)).toBe(DEMO_CERTIFICATE_TEXT);
  });

  it("tracks two concurrent envelopes independently", async () => {
    const first = await send(provider, "first.pdf");
    // Second envelope is created 20s into the first one's life.
    vi.advanceTimersByTime(20_000);
    const second = await send(provider, "second.pdf");

    expect(first).not.toBe(second);
    await expect(provider.pollStatus(first)).resolves.toBe("delivered");
    await expect(provider.pollStatus(second)).resolves.toBe("sent");

    // +15s: the first crosses 30s (completed), the second crosses 10s.
    vi.advanceTimersByTime(15_000);
    await expect(provider.pollStatus(first)).resolves.toBe("completed");
    await expect(provider.pollStatus(second)).resolves.toBe("delivered");
  });

  it("issues unique IDs for envelopes created in the same millisecond", async () => {
    const a = await send(provider);
    const b = await send(provider);
    expect(a).not.toBe(b);
  });

  it("rejects polling or downloading an unknown envelope", async () => {
    await expect(provider.pollStatus("DEMO-ENV-nope")).rejects.toThrow(/Unknown envelope/);
    await expect(provider.getCertificate("DEMO-ENV-nope")).rejects.toThrow(/Unknown envelope/);
  });

  it("reset() forgets tracked envelopes", async () => {
    const id = await send(provider);
    provider.reset();
    await expect(provider.pollStatus(id)).rejects.toThrow(/Unknown envelope/);
  });
});

// ── Status coercion ──────────────────────────────────────────────────────────

describe("toESignStatus", () => {
  it("passes the five modelled states through, case-insensitively", () => {
    expect(toESignStatus("Completed")).toBe("completed");
    expect(toESignStatus("DELIVERED")).toBe("delivered");
    expect(toESignStatus(" sent ")).toBe("sent");
    expect(toESignStatus("declined")).toBe("declined");
    expect(toESignStatus("voided")).toBe("voided");
  });

  it("treats 'signed' as delivered — signed is not yet a completion", () => {
    expect(toESignStatus("signed")).toBe("delivered");
  });

  it("treats unknown DocuSign states as still in flight, never terminal", () => {
    // An unrecognized value must not be able to fulfill a condition.
    expect(toESignStatus("created")).toBe("sent");
    expect(toESignStatus("correct")).toBe("sent");
    expect(isTerminal(toESignStatus("something-new"))).toBe(false);
  });

  it("classifies terminal states", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("declined")).toBe(true);
    expect(isTerminal("voided")).toBe(true);
    expect(isTerminal("sent")).toBe(false);
    expect(isTerminal("delivered")).toBe(false);
  });
});

// ── Completion pipeline: AnchorMatcher on signer identities (spec §23) ───────

describe("signersMatchAnchors", () => {
  const anchors: TrustAnchors = {
    attorneyBarNumber: "123456",
    state: "California",
    clientFullLegalName: "Jane Anderson",
    clientEmail: "jane@example.com",
    clientPhone: "+15550000000",
  };

  it("matches a signer whose name is a trust anchor", () => {
    expect(signersMatchAnchors([signer("Jane Anderson")], anchors, {})).toBe(true);
  });

  it("matches case- and whitespace-insensitively", () => {
    expect(signersMatchAnchors([signer("  jane   ANDERSON ")], anchors, {})).toBe(true);
  });

  it("does not match a signer absent from the anchors", () => {
    expect(signersMatchAnchors([signer("Mallory Smith")], anchors, {})).toBe(false);
  });

  it("matches names carried only in the raw per-class anchor record", () => {
    const raw = { buyerName: "GreenLeaf Dispensary", sellerName: "Emerald Co" };
    expect(signersMatchAnchors([signer("GreenLeaf Dispensary")], anchors, raw)).toBe(true);
    expect(signersMatchAnchors([signer("Emerald Co")], anchors, raw)).toBe(true);
  });

  it("matches a signer name contained within a longer anchor value", () => {
    // "Jane Anderson" signing against the anchor "Jane Anderson LLC".
    const raw = { buyerName: "Jane Anderson LLC" };
    expect(signersMatchAnchors([signer("Jane Anderson")], anchors, raw)).toBe(true);
  });

  it("matches only on whole words — a name fragment is not an identity", () => {
    // "Cal" must not match the state anchor "California", nor "Ander" "Anderson".
    expect(signersMatchAnchors([signer("Cal")], anchors, {})).toBe(false);
    expect(signersMatchAnchors([signer("Ander")], anchors, {})).toBe(false);
    // A trailing-word fragment is equally not a match.
    expect(signersMatchAnchors([signer("Jane Anders")], anchors, {})).toBe(false);
  });

  it("does not let a short anchor value match an unrelated signer", () => {
    // The state anchor is a word of neither name below.
    const raw = { licenseType: "Dispensary", state: "CA" };
    expect(signersMatchAnchors([signer("Cassandra Nguyen")], anchors, raw)).toBe(false);
  });

  it("requires EVERY signer to match, not just one", () => {
    const signers = [signer("Jane Anderson", "a@x.com"), signer("Mallory Smith", "b@x.com")];
    expect(signersMatchAnchors(signers, anchors, {})).toBe(false);
  });

  it("fails closed on an empty signer list or empty anchors", () => {
    expect(signersMatchAnchors([], anchors, {})).toBe(false);
    const blank: TrustAnchors = {
      attorneyBarNumber: "",
      state: "",
      clientFullLegalName: "",
      clientEmail: "",
    };
    expect(signersMatchAnchors([signer("Jane Anderson")], blank, {})).toBe(false);
  });

  it("fails closed on a blank signer name", () => {
    expect(signersMatchAnchors([signer("   ")], anchors, {})).toBe(false);
  });
});

// ── Condition Definition: signer derivation across all seven asset classes ───

describe("deriveSigners", () => {
  /** Fill every anchor field for a class with a plausible value. */
  function filledAnchors(cls: (typeof ASSET_CLASS_LIST)[number]): Record<string, string> {
    const raw = emptyAnchorsFor(cls);
    for (const field of ASSET_CLASSES[cls].anchorFields) {
      if (raw[field.key]) continue; // select fields already carry a default
      raw[field.key] =
        field.type === "email"
          ? `${field.key.toLowerCase()}@example.com`
          : field.type === "money"
            ? "100000"
            : field.type === "state"
              ? "California"
              : `${field.label} Value`;
    }
    return raw;
  }

  it.each(ASSET_CLASS_LIST)("derives at least one signer for %s", (cls) => {
    const raw = filledAnchors(cls);
    const signers = deriveSigners(cls, anchorsToTrustAnchors(cls, raw), raw);

    expect(signers.length).toBeGreaterThan(0);
    for (const s of signers) {
      expect(s.name.trim()).not.toBe("");
      expect(s.email).toMatch(/@/);
      expect(s.role.trim()).not.toBe("");
      expect(s.routingOrder).toBe(1);
    }
  });

  it.each(ASSET_CLASS_LIST)("never emits duplicate signer emails for %s", (cls) => {
    const raw = filledAnchors(cls);
    const signers = deriveSigners(cls, anchorsToTrustAnchors(cls, raw), raw);
    const emails = signers.map((s) => s.email.toLowerCase());
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("pairs each email anchor with its sibling name anchor", () => {
    const raw = filledAnchors("real_estate");
    raw.buyerName = "Ada Buyer";
    raw.buyerEmail = "ada@example.com";
    raw.sellerName = "Bob Seller";
    raw.sellerEmail = "bob@example.com";

    const signers = deriveSigners("real_estate", anchorsToTrustAnchors("real_estate", raw), raw);
    expect(signers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Ada Buyer", email: "ada@example.com", role: "Buyer" }),
        expect.objectContaining({ name: "Bob Seller", email: "bob@example.com", role: "Seller" }),
      ]),
    );
  });

  it("falls back to the projected primary party when the raw record is empty", () => {
    // A session hydrated from a batch item carries TrustAnchors but no raw record.
    const anchors: TrustAnchors = {
      attorneyBarNumber: "123456",
      state: "California",
      clientFullLegalName: "Jane Anderson",
      clientEmail: "jane@example.com",
    };
    const signers = deriveSigners("legal", anchors, {});
    expect(signers).toEqual([
      { name: "Jane Anderson", email: "jane@example.com", role: "Client", routingOrder: 1 },
    ]);
  });

  it("returns no signers when nothing identifies a party", () => {
    const blank: TrustAnchors = {
      attorneyBarNumber: "",
      state: "",
      clientFullLegalName: "",
      clientEmail: "",
    };
    expect(deriveSigners("legal", blank, {})).toEqual([]);
  });
});

// ── handleESignCompletion — the real store action, end to end ────────────────

describe("handleESignCompletion", () => {
  const anchors: TrustAnchors = {
    attorneyBarNumber: "123456",
    state: "California",
    clientFullLegalName: "Jane Anderson",
    clientEmail: "jane@example.com",
  };

  /**
   * Push a real envelope through the mock provider and into store state. The
   * audit trail is a process-wide in-memory chain, so each case gets its own
   * session ID to keep assertions independent.
   */
  async function seedEnvelope(signers: ESignSigner[], sessionId = "wf-test"): Promise<string> {
    const provider = await resolveESignProvider();
    const envelopeId = await provider.sendEnvelope(
      sessionId,
      EMPTY_DOC,
      "agreement.pdf",
      signers,
      "Subject",
      "Message",
    );
    useSession.setState({
      sessionId,
      anchors,
      rawAnchors: {},
      error: null,
      eSignEnvelopes: [
        {
          envelopeId,
          sessionId,
          documentLabel: "agreement.pdf",
          signers,
          status: "completed",
          sentAt: new Date().toISOString(),
        },
      ],
    });
    return envelopeId;
  }

  const current = (id: string) =>
    useSession.getState().eSignEnvelopes.find((e) => e.envelopeId === id);

  beforeEach(() => {
    resetMockESignProvider();
    useSession.getState().reset();
  });

  it("hashes the certificate and records the on-chain anchor", async () => {
    const id = await seedEnvelope([signer("Jane Anderson")]);
    await useSession.getState().handleESignCompletion(id);

    const envelope = current(id)!;
    // SHA-256 of "DEMO-CERTIFICATE-PDF", computed by ArtifactGuard's browser path.
    expect(envelope.certificateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(envelope.onChainTx).toBe(`0xanchor-esign-${id.slice(-8)}`);
    expect(envelope.completedAt).toBeTruthy();
    expect(envelope.status).toBe("completed");
  });

  it("hashes deterministically — the same certificate yields the same hash", async () => {
    const first = await seedEnvelope([signer("Jane Anderson")]);
    await useSession.getState().handleESignCompletion(first);
    const hashA = current(first)!.certificateHash;

    const second = await seedEnvelope([signer("Jane Anderson")]);
    await useSession.getState().handleESignCompletion(second);
    const hashB = current(second)!.certificateHash;

    expect(hashA).toBe(hashB);
  });

  it("sets anchorMatch true when the signer matches a trust anchor", async () => {
    const id = await seedEnvelope([signer("Jane Anderson")]);
    await useSession.getState().handleESignCompletion(id);
    expect(current(id)!.anchorMatch).toBe(true);
  });

  it("sets anchorMatch false when the signer does not match — without blocking the record", async () => {
    const id = await seedEnvelope([signer("Mallory Smith")]);
    await useSession.getState().handleESignCompletion(id);

    const envelope = current(id)!;
    expect(envelope.anchorMatch).toBe(false);
    // The completion is still recorded; the mismatch escalates to human review
    // rather than discarding the certificate (spec §23).
    expect(envelope.certificateHash).toMatch(/^sha256:/);
    expect(envelope.status).toBe("completed");
  });

  it("writes esign_completed to the hash-chained audit trail", async () => {
    const id = await seedEnvelope([signer("Jane Anderson")], "wf-audit");
    await useSession.getState().handleESignCompletion(id);

    const { getAuditTrail } = await import("../backend");
    const trail = await getAuditTrail("wf-audit");
    const completed = trail.find((e) => e.eventType === "esign_completed");
    expect(completed).toBeDefined();

    const payload = JSON.parse(completed!.payloadJson);
    expect(payload.envelope_id).toBe(id);
    expect(payload.anchor_match).toBe(true);
    expect(payload.certificate_hash).toMatch(/^sha256:/);
  });

  it("records a completion failure instead of throwing when the envelope is unknown to the provider", async () => {
    const id = await seedEnvelope([signer("Jane Anderson")]);
    // Drop provider-side state so getCertificate rejects.
    resetMockESignProvider();

    await expect(useSession.getState().handleESignCompletion(id)).resolves.toBeUndefined();
    expect(useSession.getState().error).toMatch(/completion pipeline failed/i);
    expect(current(id)!.certificateHash).toBeUndefined();
  });
});
