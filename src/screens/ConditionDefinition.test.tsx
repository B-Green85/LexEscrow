/**
 * Render checks for the Stage 4 Condition Definition screen.
 *
 * Uses `react-dom/server` rather than a DOM testing library — no new tooling,
 * and a server render still executes the whole component tree, so a broken
 * import, an undefined field access or a bad branch surfaces as a thrown error
 * rather than a silent pass.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { ConditionDefinitionView, type ConditionDefinitionViewProps } from "./ConditionDefinition";
import type { ClioMatterPayload } from "../lib/clio";
import {
  ASSET_CLASS_LIST,
  ASSET_CLASSES,
  anchorsToTrustAnchors,
  emptyAnchorsFor,
  type AssetClass,
} from "../lib/assetClasses";
import type { ESignEnvelope } from "../lib/esign";

function filledAnchors(cls: AssetClass): Record<string, string> {
  const raw = emptyAnchorsFor(cls);
  for (const field of ASSET_CLASSES[cls].anchorFields) {
    if (raw[field.key]) continue;
    raw[field.key] =
      field.type === "money" ? "100000" : field.type === "state" ? "California" : `${field.label} Value`;
  }
  // Signer emails are entered per signer (no longer anchor fields) — fill them
  // so each party routes to a DocuSign email and "Send for Signature" is offered.
  for (const s of ASSET_CLASSES[cls].signers) {
    raw[s.emailKey] = `${s.emailKey.toLowerCase()}@example.com`;
  }
  return raw;
}

function props(
  cls: AssetClass,
  extra: Partial<ConditionDefinitionViewProps> = {},
): ConditionDefinitionViewProps {
  const raw = filledAnchors(cls);
  return {
    assetClass: cls,
    anchors: anchorsToTrustAnchors(cls, raw),
    rawAnchors: raw,
    artifact: { filename: "agreement.pdf", hash: "sha256:" + "a".repeat(64), size: 2048 },
    eSignEnvelopes: [],
    eSignPolling: false,
    busy: false,
    error: null,
    barActive: true,
    cannaVerifyConditions: null,
    cannaVerifyRunning: false,
    onSendForSignature: async () => new Map(),
    onRunCannaVerify: () => {},
    onProceed: () => {},
    ...extra,
  };
}

const CLIO_MATTER: ClioMatterPayload = {
  matterId: 4321,
  displayNumber: "00001-Anderson",
  description: "Anderson v. Wexler",
  status: "open",
  billingMethod: "hourly",
  openDate: "2026-01-15",
  closeDate: null,
  clientName: "Jane Anderson",
  clientEmail: null,
  clientPhone: null,
  parties: [],
  bills: [],
  trustBalanceCents: 3_000_000,
  fetchedAt: "2026-09-05T12:00:00Z",
};

const render = (cls: AssetClass, extra: Partial<ConditionDefinitionViewProps> = {}) =>
  renderToString(createElement(ConditionDefinitionView, props(cls, extra)));

/** React escapes text nodes — "Art & Collectibles" ships as "Art &amp; Collectibles". */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

describe("ConditionDefinition screen", () => {
  it.each(ASSET_CLASS_LIST)("renders for the %s asset class", (cls) => {
    const html = render(cls);

    expect(html).toContain("Condition Definition");
    expect(html).toContain(esc(ASSET_CLASSES[cls].displayName));
    // All four condition families are present for every class.
    expect(html).toContain("Document-based conditions");
    expect(html).toContain("Time-based conditions");
    expect(html).toContain("Multi-party signature conditions");
    expect(html).toContain("Confirm Conditions &amp; Proceed to Escrow");
  });

  it.each(ASSET_CLASS_LIST)("offers Send for Signature for %s", (cls) => {
    expect(render(cls)).toContain("Send for Signature");
  });

  it("shows the CannaVerify panel only for cannabis", () => {
    expect(render("cannabis_ind")).toContain("CannaVerify conditions");
    expect(render("legal")).not.toContain("CannaVerify conditions");
  });

  it("shows bar verification as the legal event condition", () => {
    const html = render("legal");
    expect(html).toContain("California State Bar");
    expect(html).toContain("Verified");
  });

  it("shows the V2 adapter placeholder for classes without an adapter", () => {
    expect(render("art")).toContain("Condition verification via CRE adapter — V2 feature");
  });

  it("renders a completed envelope with its certificate hash and anchor match", () => {
    const envelope: ESignEnvelope = {
      envelopeId: "DEMO-ENV-12345678",
      sessionId: "wf-1",
      documentLabel: "agreement.pdf",
      signers: [
        { name: "Jane Anderson", email: "jane@example.com", role: "Client", routingOrder: 1 },
      ],
      status: "completed",
      sentAt: new Date("2026-07-18T12:00:00Z").toISOString(),
      completedAt: new Date("2026-07-18T12:01:00Z").toISOString(),
      certificateHash: "sha256:" + "b".repeat(64),
      onChainTx: "0xanchor-esign-12345678",
      anchorMatch: true,
    };
    const html = render("legal", { eSignEnvelopes: [envelope] });

    expect(html).toContain("DEMO-ENV-12345678");
    expect(html).toContain("✅ Signed");
    expect(html).toContain("0xanchor-esign-12345678");
    expect(html).toContain("sepolia.etherscan.io");
    expect(html).toContain("Matches trust anchors");
  });

  it("flags an envelope whose signers do not match the trust anchors", () => {
    const html = render("legal", {
      eSignEnvelopes: [
        {
          envelopeId: "DEMO-ENV-87654321",
          sessionId: "wf-1",
          documentLabel: "agreement.pdf",
          signers: [
            { name: "Mallory", email: "m@example.com", role: "Client", routingOrder: 1 },
          ],
          status: "completed",
          sentAt: new Date("2026-07-18T12:00:00Z").toISOString(),
          certificateHash: "sha256:" + "c".repeat(64),
          onChainTx: "0xanchor-esign-87654321",
          anchorMatch: false,
        },
      ],
    });
    expect(html).toContain("No anchor match — human review");
  });

  it("renders each non-terminal envelope status chip", () => {
    const base = {
      sessionId: "wf-1",
      documentLabel: "agreement.pdf",
      signers: [{ name: "Jane", email: "j@example.com", role: "Client", routingOrder: 1 }],
      sentAt: new Date("2026-07-18T12:00:00Z").toISOString(),
    };
    const html = render("legal", {
      eSignPolling: true,
      eSignEnvelopes: [
        { ...base, envelopeId: "E-1", status: "sent" },
        { ...base, envelopeId: "E-2", status: "delivered" },
        { ...base, envelopeId: "E-3", status: "declined" },
        { ...base, envelopeId: "E-4", status: "voided" },
      ] as ESignEnvelope[],
    });

    expect(html).toContain("📤 Sent");
    expect(html).toContain("📬 Delivered");
    expect(html).toContain("❌ Declined");
    expect(html).toContain("🚫 Voided");
    expect(html).toContain("Polling every 30s");
  });

  it("renders without a document — the pending state, not a crash", () => {
    const html = render("legal", { artifact: null });
    expect(html).toContain("No document has been registered");
    expect(html).toContain("⏳ Pending");
  });

  it("disables Proceed only when no condition family is configured at all", () => {
    const noConditions = render("legal", { artifact: null, eSignEnvelopes: [] });
    expect(noConditions).toMatch(/Confirm Conditions[\s\S]*$/);
    expect(noConditions).toContain('disabled=""');

    // A registered document is itself a configured condition.
    expect(render("legal")).not.toContain('class="btn btn-primary btn-lg" disabled=""');
  });

  // ── Clio intake ────────────────────────────────────────────────────────────

  const clioProps = { artifact: null, intakeSource: "clio" as const, clioMatter: CLIO_MATTER };

  it("lets a confirmed Clio matter satisfy the proceed gate", () => {
    // `artifact` is null on this path by construction. Without the Clio branch
    // the officer could only proceed by setting a release date or raising an
    // envelope they did not want.
    const html = render("legal", { ...clioProps, eSignEnvelopes: [] });
    expect(html).not.toContain('class="btn btn-primary btn-lg" disabled=""');
  });

  it("still blocks a Clio session with no matter fetched", () => {
    const html = render("legal", {
      artifact: null,
      intakeSource: "clio",
      clioMatter: null,
      eSignEnvelopes: [],
    });
    expect(html).toContain('disabled=""');
  });

  it("describes the baseline as not applicable rather than pending", () => {
    const html = render("legal", clioProps);
    expect(html).toContain("➖ Not applicable");
    expect(html).toContain("document registration not applicable");
    expect(html).toContain("00001-Anderson");
    // The document-path copy would contradict the enabled button beside it.
    expect(html).not.toContain("No document has been registered");
    expect(html).not.toContain("⏳ Pending");
  });

  it("leaves the document path's gate and card untouched", () => {
    // Explicit intake source, same as the default — the artifact path must not
    // pick up any Clio wording or a changed badge.
    const html = render("legal", { intakeSource: "artifact", clioMatter: null });
    expect(html).toContain("✅ Registered");
    expect(html).toContain("agreement.pdf");
    expect(html).not.toContain("Not applicable");
    expect(html).not.toContain("Clio");
  });

  it("does not offer to send a Clio session for signature", () => {
    // There is no document to send — `onSendForSignature` would dispatch a
    // placeholder filename. The proceed gate is the only thing a Clio matter
    // satisfies.
    const html = render("legal", clioProps);
    // Pinned to the send button's own class, not a bare `disabled=""` anywhere
    // on the page — the proceed button below it is deliberately enabled.
    expect(html).toContain('class="btn btn-primary mt-4" disabled=""');
    expect(html).toContain("Send for Signature");
  });
});
