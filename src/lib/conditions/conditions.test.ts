// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Condition engine tests (spec §6 Stage 7).
 *
 * The builder is the thing that decides which gates an escrow has to pass, and
 * `evaluateSummary` is the thing that decides whether money may move. Both are
 * pure functions of session state, so they are tested directly — no store, no
 * DOM, no clock beyond the one that is injected.
 */

import { describe, expect, it } from "vitest";
import {
  buildConditions,
  CLIO_DOC_WAIVER_REASON,
  evaluateSummary,
  isDateReached,
  updateConditionFromCannaVerify,
  updateConditionFromESign,
  type BuildConditionsParams,
  type Condition,
  type ConditionStatus,
} from "./index";
import { ExecutionPath, type ParsedRetainerPayload } from "../../lexguard/types";
import type { AssetClass } from "../assetClasses";
import type { AnchorReceipt } from "../anchor-receipt";
import type { ESignEnvelope, ESignStatus } from "../esign";
import type { CannaVerifyConditions, CannaVerifyResult } from "../cannaverify/types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SESSION = "wf-test-1";

function payload(): ParsedRetainerPayload {
  return {
    clientId: "C-001",
    lawFirmWallet: "0xfirm",
    clientWallet: "0xclient",
    totalHeld: 18_500,
    earnedFees: 6_000,
    unearnedBalance: 12_500,
    disputedHours: 0,
    disputedAmount: 0,
    signaturesVerified: true,
    recommendedPath: ExecutionPath.DirectSettlement,
    anomaliesFlagged: [],
    anomaliesSuppressed: false,
    barNumber: "123456",
    clientName: "Jane Anderson",
    extractedBarNumber: "123456",
  };
}

// `null` means "sealed but never anchored". Not `undefined` — that would hit
// the default parameter and quietly test the anchored case twice.
function receipt(onChainTx: string | null = "0xanchor-abc"): AnchorReceipt {
  return {
    receiptId: "r-1",
    issuedAt: "2026-07-18T10:00:00Z",
    assertionType: "escrow_document_registration",
    transactionId: SESSION,
    assetClass: "legal",
    summary: { overallStatus: "verified_all", verifiedCount: 1, totalCount: 1 },
    items: [
      {
        label: "retainer.pdf",
        hmac: "seal-1",
        hash: "sha256:" + "a".repeat(64),
        size: 2048,
        registered: true,
        registeredAt: "2026-07-18T10:00:00Z",
        ...(onChainTx && { onChainTx }),
      },
    ],
    assertionText: "…",
    receiptHash: "b".repeat(64),
  };
}

function envelope(status: ESignStatus = "sent"): ESignEnvelope {
  return {
    envelopeId: "env-1",
    sessionId: SESSION,
    documentLabel: "retainer.pdf",
    signers: [
      { name: "Jane Anderson", email: "jane@example.com", role: "Client", routingOrder: 1 },
      { name: "Marcus Webb", email: "marcus@firm.com", role: "Attorney", routingOrder: 1 },
    ],
    status,
    sentAt: "2026-07-18T10:00:00Z",
  };
}

function cannaVerify(overallResult: CannaVerifyResult): CannaVerifyConditions {
  return {
    sessionId: SESSION,
    stateLicenseNum: "C11-0000123-LIC",
    metrcFacilityId: "FAC-1",
    licenseType: "Distributor",
    state: "CA",
    checks: [],
    overallResult,
    completedAt: "2026-07-18T11:00:00Z",
  };
}

function params(
  assetClass: AssetClass,
  extra: Partial<BuildConditionsParams> = {},
): BuildConditionsParams {
  return {
    sessionId: SESSION,
    assetClass,
    payload: payload(),
    rawAnchors: {},
    anchorReceipt: null,
    eSignEnvelopes: [],
    cannaVerifyConditions: null,
    barVerified: null,
    ...extra,
  };
}

const typesOf = (conditions: Condition[]) => conditions.map((c) => c.type);

function condition(status: ConditionStatus, id = "c1"): Condition {
  return {
    id,
    type: "esign",
    label: "All parties signed",
    description: "…",
    status,
    assetClass: "legal",
  };
}

// ── buildConditions ──────────────────────────────────────────────────────────

describe("buildConditions", () => {
  it("adds a bar_verify condition for the legal asset class", () => {
    const conditions = buildConditions(params("legal", { barVerified: true }));
    const bar = conditions.find((c) => c.type === "bar_verify");
    expect(bar).toBeDefined();
    expect(bar!.status).toBe("met");
    expect(bar!.barNumber).toBe("123456");
  });

  it("marks bar_verify failed when verification returned false", () => {
    const conditions = buildConditions(params("legal", { barVerified: false }));
    const bar = conditions.find((c) => c.type === "bar_verify")!;
    expect(bar.status).toBe("failed");
    expect(bar.failureReason).toBeTruthy();
  });

  it("leaves bar_verify pending when verification has not run", () => {
    const conditions = buildConditions(params("legal", { barVerified: null }));
    expect(conditions.find((c) => c.type === "bar_verify")!.status).toBe("pending");
  });

  it("adds a cannaverify condition for Cannabis IND", () => {
    const conditions = buildConditions(
      params("cannabis_ind", { cannaVerifyConditions: cannaVerify("PASS") }),
    );
    const canna = conditions.find((c) => c.type === "cannaverify");
    expect(canna).toBeDefined();
    expect(canna!.status).toBe("met");
    expect(canna!.cannaVerifyResult).toBe("PASS");
  });

  it("leaves cannaverify pending until the adapters have run", () => {
    const conditions = buildConditions(params("cannabis_ind", { cannaVerifyConditions: null }));
    expect(conditions.find((c) => c.type === "cannaverify")!.status).toBe("pending");
  });

  it("does not add a bar_verify condition to non-legal classes", () => {
    for (const cls of ["business", "ip", "real_estate", "cannabis_ind"] as AssetClass[]) {
      expect(typesOf(buildConditions(params(cls)))).not.toContain("bar_verify");
    }
  });

  it("adds one document condition per registered receipt item", () => {
    const conditions = buildConditions(params("legal", { anchorReceipt: receipt() }));
    const docs = conditions.filter((c) => c.type === "document");
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("met");
    expect(docs[0].documentLabel).toBe("retainer.pdf");
    expect(docs[0].onChainTx).toBe("0xanchor-abc");
  });

  it("leaves a document condition pending when the item was never anchored", () => {
    const conditions = buildConditions(params("legal", { anchorReceipt: receipt(null) }));
    expect(conditions.find((c) => c.type === "document")!.status).toBe("pending");
  });

  it("produces no document conditions without a receipt", () => {
    const conditions = buildConditions(params("legal", { anchorReceipt: null }));
    expect(typesOf(conditions)).not.toContain("document");
  });

  // ── Clio intake ────────────────────────────────────────────────────────────

  it("waives the document condition on a Clio-sourced session", () => {
    const conditions = buildConditions(params("legal", { intakeSource: "clio" }));

    const docs = conditions.filter((c) => c.type === "document");
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("waived");
    expect(docs[0].failureReason).toBe("Clio matter intake — document registration not applicable.");
    expect(docs[0].failureReason).toBe(CLIO_DOC_WAIVER_REASON);
  });

  it("does not let the waived document condition hold the settlement gate", () => {
    // The point of waiving rather than leaving it pending: `allMet` is what
    // opens the settlement gate, and a Clio session has no way to ever satisfy
    // a document condition.
    const conditions = buildConditions(
      params("legal", { intakeSource: "clio", barVerified: true }),
    );

    const summary = evaluateSummary(conditions);
    expect(summary.allMet).toBe(true);
    // Waived sits in none of the three buckets — see ConditionSummary.
    expect(summary.met + summary.pending + summary.failed).toBe(summary.total - 1);
  });

  it("gives the waived condition a deterministic id so a poll cannot duplicate it", () => {
    const first = buildConditions(params("legal", { intakeSource: "clio" }));
    const second = buildConditions(params("legal", { intakeSource: "clio" }));

    const idOf = (cs: Condition[]) => cs.find((c) => c.type === "document")!.id;
    expect(idOf(first)).toBe(`${SESSION}-doc-clio`);
    expect(idOf(second)).toBe(idOf(first));
  });

  it("touches no other condition type", () => {
    const artifact = buildConditions(params("legal", { barVerified: true }));
    const clio = buildConditions(params("legal", { barVerified: true, intakeSource: "clio" }));

    // Everything that is not the document row is identical, status included.
    const nonDoc = (cs: Condition[]) => cs.filter((c) => c.type !== "document");
    expect(nonDoc(clio)).toEqual(nonDoc(artifact));
    expect(nonDoc(clio).find((c) => c.type === "bar_verify")!.status).toBe("met");
  });

  it("emits no receipt-derived document rows on the Clio path", () => {
    // A Clio session should never have an AnchorReceipt — `beginProcessing`
    // skips it. If one ever appeared, the waived row must still be the only
    // document condition rather than sitting beside a fingerprint claim.
    const conditions = buildConditions(
      params("legal", { intakeSource: "clio", anchorReceipt: receipt() }),
    );

    const docs = conditions.filter((c) => c.type === "document");
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("waived");
    expect(docs[0].documentHash).toBeUndefined();
  });

  it("leaves the document path untouched when the intake source is not given", () => {
    // The parameter is optional and defaults to the artifact path — every
    // existing caller predates it.
    const conditions = buildConditions(params("legal", { anchorReceipt: receipt() }));
    const docs = conditions.filter((c) => c.type === "document");
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("met");
  });

  it("adds one esign condition per envelope", () => {
    const conditions = buildConditions(params("legal", { eSignEnvelopes: [envelope("sent")] }));
    const esign = conditions.find((c) => c.type === "esign")!;
    expect(esign.status).toBe("in_progress");
    expect(esign.envelopeId).toBe("env-1");
    expect(esign.signers).toEqual(["Jane Anderson", "Marcus Webb"]);
  });

  it("produces no esign conditions when nothing was sent", () => {
    expect(typesOf(buildConditions(params("legal")))).not.toContain("esign");
  });

  it("adds a manual diligence condition for business, IP and real estate", () => {
    for (const cls of ["business", "ip", "real_estate"] as AssetClass[]) {
      const manual = buildConditions(params(cls)).find((c) => c.type === "manual");
      expect(manual, `${cls} should have a manual condition`).toBeDefined();
      // Always starts unsatisfied — only a human moves it.
      expect(manual!.status).toBe("pending");
    }
  });

  it("adds a time condition when a release date is anchored", () => {
    const conditions = buildConditions(
      params("legal", { rawAnchors: { releaseDate: "2030-01-01" } }),
    );
    const time = conditions.find((c) => c.type === "time")!;
    expect(time.releaseDate).toBe("2030-01-01");
  });

  it("marks a past release date as met", () => {
    const conditions = buildConditions(
      params("legal", { rawAnchors: { releaseDate: "2020-01-01" } }),
    );
    expect(conditions.find((c) => c.type === "time")!.status).toBe("met");
  });

  it("leaves a future release date pending", () => {
    const conditions = buildConditions(
      params("legal", { rawAnchors: { releaseDate: "2099-12-31" } }),
    );
    expect(conditions.find((c) => c.type === "time")!.status).toBe("pending");
  });

  it("adds no time condition without a release date anchor", () => {
    expect(typesOf(buildConditions(params("legal")))).not.toContain("time");
  });

  it("derives stable ids so a rebuild does not duplicate the checklist", () => {
    const build = () =>
      buildConditions(
        params("legal", {
          anchorReceipt: receipt(),
          eSignEnvelopes: [envelope("delivered")],
          barVerified: true,
          rawAnchors: { releaseDate: "2099-12-31" },
        }),
      );
    expect(build().map((c) => c.id)).toEqual(build().map((c) => c.id));
  });
});

describe("isDateReached", () => {
  it("is false for a date that has not arrived", () => {
    expect(isDateReached("2030-01-01", Date.parse("2026-07-18"))).toBe(false);
  });

  it("is true once the date has passed", () => {
    expect(isDateReached("2020-01-01", Date.parse("2026-07-18"))).toBe(true);
  });

  it("refuses to satisfy a time lock it cannot parse", () => {
    expect(isDateReached("not-a-date")).toBe(false);
  });
});

// ── evaluateSummary ──────────────────────────────────────────────────────────

describe("evaluateSummary", () => {
  it("reports allMet when every condition is met", () => {
    const summary = evaluateSummary([condition("met", "a"), condition("met", "b")]);
    expect(summary.allMet).toBe(true);
    expect(summary.met).toBe(2);
    expect(summary.total).toBe(2);
  });

  it("reports allMet false while anything is pending", () => {
    const summary = evaluateSummary([condition("met", "a"), condition("pending", "b")]);
    expect(summary.allMet).toBe(false);
    expect(summary.pending).toBe(1);
  });

  it("counts in_progress as pending", () => {
    const summary = evaluateSummary([condition("in_progress", "a")]);
    expect(summary.pending).toBe(1);
    expect(summary.allMet).toBe(false);
  });

  it("reports allMet when the remainder is waived rather than met", () => {
    const summary = evaluateSummary([condition("met", "a"), condition("waived", "b")]);
    expect(summary.allMet).toBe(true);
    // A waiver is not a verification — it is in none of the three buckets.
    expect(summary.met).toBe(1);
    expect(summary.pending).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.total).toBe(2);
  });

  it("blocks on a failed condition", () => {
    const summary = evaluateSummary([condition("met", "a"), condition("failed", "b")]);
    expect(summary.allMet).toBe(false);
    expect(summary.failed).toBe(1);
  });

  it("counts every bucket correctly", () => {
    const summary = evaluateSummary([
      condition("met", "a"),
      condition("met", "b"),
      condition("pending", "c"),
      condition("in_progress", "d"),
      condition("failed", "e"),
      condition("waived", "f"),
    ]);
    expect(summary).toEqual({ total: 6, met: 2, pending: 2, failed: 1, allMet: false });
  });

  it("does not green-light an empty checklist", () => {
    // Nothing was verified, so nothing may settle.
    expect(evaluateSummary([])).toEqual({
      total: 0,
      met: 0,
      pending: 0,
      failed: 0,
      allMet: false,
    });
  });
});

// ── Incremental updates ──────────────────────────────────────────────────────

describe("updateConditionFromESign", () => {
  it("maps a completed envelope to met", () => {
    const next = updateConditionFromESign(condition("in_progress"), envelope("completed"));
    expect(next.status).toBe("met");
    expect(next.metAt).toBeTruthy();
  });

  it("maps a declined envelope to failed", () => {
    const next = updateConditionFromESign(condition("in_progress"), envelope("declined"));
    expect(next.status).toBe("failed");
    expect(next.failureReason).toContain("declined");
  });

  it("maps a voided envelope to failed", () => {
    expect(updateConditionFromESign(condition("in_progress"), envelope("voided")).status).toBe(
      "failed",
    );
  });

  it("maps a sent envelope to in_progress", () => {
    expect(updateConditionFromESign(condition("pending"), envelope("sent")).status).toBe(
      "in_progress",
    );
  });

  it("maps a delivered envelope to in_progress", () => {
    expect(updateConditionFromESign(condition("pending"), envelope("delivered")).status).toBe(
      "in_progress",
    );
  });

  it("records per-signer status from the envelope", () => {
    const next = updateConditionFromESign(condition("pending"), envelope("delivered"));
    expect(next.signerStatuses).toEqual({
      "Jane Anderson": "delivered",
      "Marcus Webb": "delivered",
    });
  });

  it("never revokes a human waiver", () => {
    const waived = { ...condition("waived"), failureReason: "counterparty unreachable" };
    const next = updateConditionFromESign(waived, envelope("declined"));
    expect(next.status).toBe("waived");
    expect(next.failureReason).toBe("counterparty unreachable");
  });
});

describe("updateConditionFromCannaVerify", () => {
  const canna = (): Condition => ({ ...condition("pending"), type: "cannaverify" });

  it("maps PASS to met", () => {
    const next = updateConditionFromCannaVerify(canna(), cannaVerify("PASS"));
    expect(next.status).toBe("met");
    expect(next.cannaVerifyResult).toBe("PASS");
    expect(next.metAt).toBe("2026-07-18T11:00:00Z");
  });

  it("maps FAIL to failed", () => {
    const next = updateConditionFromCannaVerify(canna(), cannaVerify("FAIL"));
    expect(next.status).toBe("failed");
    expect(next.failureReason).toBeTruthy();
  });

  it("maps ERROR to in_progress rather than failed", () => {
    // An adapter that could not reach Metrc has established nothing either way.
    expect(updateConditionFromCannaVerify(canna(), cannaVerify("ERROR")).status).toBe("in_progress");
  });

  it("never revokes a human waiver", () => {
    const waived: Condition = { ...canna(), status: "waived" };
    expect(updateConditionFromCannaVerify(waived, cannaVerify("FAIL")).status).toBe("waived");
  });
});
