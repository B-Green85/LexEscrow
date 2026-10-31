// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Condition builder — projects session state onto the condition checklist.
 *
 * The escrow officer's session accumulates evidence in four unrelated shapes:
 * AnchorReceipt items, DocuSign envelopes, CannaVerify check sets, and a bar
 * verification boolean. Stage 7 needs one list the officer can read top to
 * bottom and one boolean ("may this settle?"), so this module is the single
 * place that flattening happens.
 *
 * **Condition ids are deterministic**, derived from the session id plus a
 * stable discriminator (the receipt item's index, the envelope id, the type
 * name). That is load-bearing rather than cosmetic: `updateConditions` in the
 * store re-runs `buildConditions` on every poll tick and diffs the result
 * against what is already persisted. Random ids would make every tick look like
 * a fresh set of conditions, duplicating rows and resetting the officer's
 * waivers thirty seconds after they were granted.
 */

import type { AssetClass } from "../assetClasses";
import type { ParsedRetainerPayload } from "../../lexguard/types";
import { formatUsd, toPayloadCents } from "../../lexguard/payload-diff";
import type { AnchorReceipt } from "../anchor-receipt";
import type { ESignEnvelope, ESignStatus } from "../esign";
import type { CannaVerifyConditions } from "../cannaverify/types";
import type { IntakeSource } from "../clio";
import type { Condition, ConditionStatus, ConditionSummary } from "./types";

/** Asset classes whose closing turns on human diligence rather than an adapter. */
const MANUAL_DILIGENCE_CLASSES: AssetClass[] = ["business", "ip", "real_estate"];

/**
 * Why the document condition is waived on a Clio-sourced session.
 *
 * Exported because it is an audit-visible string: it lands in the condition's
 * `failureReason`, is persisted to SQLite by `initConditions`, and is what an
 * auditor reading the checklist months later sees in place of a fingerprint.
 */
export const CLIO_DOC_WAIVER_REASON =
  "Clio matter intake — document registration not applicable.";

// ── Status mappers ───────────────────────────────────────────────────────────

/**
 * DocuSign envelope status → condition status.
 *
 * `declined` and `voided` both map to `failed` rather than back to `pending`:
 * a party actively refusing to sign is a decision, not an absence of one, and
 * the officer has to see it as a blocker they must resolve or waive.
 *
 * Anything unrecognized falls to `pending`, never to `met` — an unexpected
 * provider status must not be able to unlock funds.
 */
export function statusFromESign(status: ESignStatus | null | undefined): ConditionStatus {
  switch (status) {
    case "completed":
      return "met";
    case "declined":
    case "voided":
      return "failed";
    case "sent":
    case "delivered":
      return "in_progress";
    default:
      return "pending";
  }
}

/**
 * CannaVerify overall result → condition status.
 *
 * `ERROR` is `in_progress`, not `failed`: an adapter that could not reach Metrc
 * has established nothing either way, and treating an outage as a compliance
 * failure would train officers to waive real failures.
 */
export function statusFromCannaVerify(result: string | null | undefined): ConditionStatus {
  switch (result) {
    case "PASS":
      return "met";
    case "FAIL":
      return "failed";
    case "ERROR":
      return "in_progress";
    default:
      return "pending";
  }
}

/**
 * Per-signer status map for an envelope.
 *
 * DocuSign's envelope-level status is the only granularity this build has, so
 * every signer reports the envelope's state. Real per-recipient tracking needs
 * the Recipients API (V2); until then the monitor shows an honest approximation
 * rather than inventing individual signature times.
 */
function signerStatusesFor(envelope: ESignEnvelope): Record<string, string> {
  const out: Record<string, string> = {};
  for (const signer of envelope.signers) out[signer.name] = envelope.status;
  return out;
}

// ── Builder ──────────────────────────────────────────────────────────────────

export interface BuildConditionsParams {
  sessionId: string;
  assetClass: AssetClass;
  payload: ParsedRetainerPayload;
  rawAnchors: Record<string, string>;
  anchorReceipt: AnchorReceipt | null;
  eSignEnvelopes: ESignEnvelope[];
  cannaVerifyConditions: CannaVerifyConditions | null;
  barVerified: boolean | null;
  /** Which intake produced the session. Defaults to the document path. */
  intakeSource?: IntakeSource;
}

/**
 * Build the full condition list for a session.
 *
 * Order is deliberate and stable — documents, signatures, regulatory checks,
 * then time — so the checklist does not reshuffle under the officer as
 * statuses change during polling.
 */
export function buildConditions(params: BuildConditionsParams): Condition[] {
  const {
    sessionId,
    assetClass,
    payload,
    rawAnchors,
    anchorReceipt,
    eSignEnvelopes,
    cannaVerifyConditions,
    barVerified,
    intakeSource = "artifact",
  } = params;

  const conditions: Condition[] = [];
  const now = new Date().toISOString();

  // 1 — Document conditions.
  //
  // On the Clio path there is no document and never will be: the matter record
  // is the intake, `beginProcessing` derives a `clio:` identifier rather than
  // hashing bytes, and it skips AnchorReceipt entirely because a provenance
  // claim needs bytes to be about. So the ArtifactGuard integrity baseline is
  // not *unsatisfied* here — it is inapplicable, and the two are different
  // facts that must not be shown to an officer as the same one.
  //
  // Emitting it waived rather than omitting it is the deliberate choice. An
  // absent row reads as an oversight ("why is there no document condition?");
  // a waived row with a reason states, in the checklist and in the persisted
  // audit record, that this session was never going to have one. `waived`
  // already means exactly that in this vocabulary — never satisfied, proceeding
  // anyway — and `evaluateSummary` counts it toward `allMet`, so it does not
  // hold the settlement gate closed.
  if (intakeSource === "clio") {
    conditions.push({
      id: `${sessionId}-doc-clio`,
      type: "document",
      label: "Document registration — not applicable",
      description:
        "Clio matter intake carries no document artifact; the session is identified by its " +
        "deterministic Clio intake identifier rather than an ArtifactGuard fingerprint.",
      status: "waived",
      assetClass,
      failureReason: CLIO_DOC_WAIVER_REASON,
    });
  } else {
    // One per registered AnchorReceipt item. An item without an on-chain tx was
    // sealed but never anchored, so its provenance claim is incomplete and the
    // condition stays pending.
    anchorReceipt?.items.forEach((item, i) => {
      const registered = Boolean(item.onChainTx);
      conditions.push({
        id: `${sessionId}-doc-${i}`,
        type: "document",
        label: `Document registered — ${item.label}`,
        description:
          "The document fingerprint is sealed and anchored in the AnchorReceipt integrity ledger.",
        status: registered ? "met" : "pending",
        assetClass,
        documentHash: item.hash,
        documentLabel: item.label,
        ...(item.onChainTx && { onChainTx: item.onChainTx }),
        ...(registered && { metAt: item.registeredAt ?? now }),
      });
    });
  }

  // 2 — eSign conditions: one per envelope in flight.
  for (const envelope of eSignEnvelopes) {
    const status = statusFromESign(envelope.status);
    conditions.push({
      id: `${sessionId}-esign-${envelope.envelopeId}`,
      type: "esign",
      label: `All parties signed — ${envelope.documentLabel}`,
      description: `Signature collection via DocuSign for ${envelope.signers.length} required signer${
        envelope.signers.length === 1 ? "" : "s"
      }.`,
      status,
      assetClass,
      envelopeId: envelope.envelopeId,
      signers: envelope.signers.map((s) => s.name),
      signerStatuses: signerStatusesFor(envelope),
      ...(envelope.onChainTx && { onChainTx: envelope.onChainTx }),
      ...(status === "met" && { metAt: envelope.completedAt ?? now }),
      ...(status === "failed" && {
        failedAt: envelope.completedAt ?? now,
        failureReason: `Envelope ${envelope.status} — signature not collected.`,
      }),
    });
  }

  // 3 — Legal: attorney standing with the state bar.
  if (assetClass === "legal") {
    const status: ConditionStatus =
      barVerified === true ? "met" : barVerified === false ? "failed" : "pending";
    conditions.push({
      id: `${sessionId}-bar`,
      type: "bar_verify",
      label: "Attorney bar verification",
      description: "The attorney of record is verified active and in good standing with the state bar.",
      status,
      assetClass,
      barNumber: payload.barNumber ?? rawAnchors.attorneyBarNumber ?? "",
      ...(barVerified !== null && { barVerified }),
      ...(status === "met" && { metAt: now }),
      ...(status === "failed" && {
        failedAt: now,
        failureReason: "Attorney is not verified active with the state bar.",
      }),
    });
  }

  // 4 — Cannabis IND: live Metrc / state regulatory verification.
  if (assetClass === "cannabis_ind") {
    const result = cannaVerifyConditions?.overallResult ?? null;
    const status = statusFromCannaVerify(result);
    conditions.push({
      id: `${sessionId}-cannaverify`,
      type: "cannaverify",
      label: "CannaVerify regulatory conditions",
      description:
        "License status, compliance holds, inventory and transfer manifest verified against live Metrc data.",
      status,
      assetClass,
      ...(result && { cannaVerifyResult: result }),
      ...(status === "met" && { metAt: cannaVerifyConditions?.completedAt ?? now }),
      ...(status === "failed" && {
        failedAt: cannaVerifyConditions?.completedAt ?? now,
        failureReason: "One or more CannaVerify regulatory checks did not pass.",
      }),
    });
  }

  // 5 — Business / IP / Real Estate: the human diligence sign-off. Always
  // starts pending; only an explicit officer confirmation moves it.
  if (MANUAL_DILIGENCE_CLASSES.includes(assetClass)) {
    conditions.push({
      id: `${sessionId}-manual-diligence`,
      type: "manual",
      label: "Due diligence / closing conditions confirmed",
      description: `Escrow officer confirms all closing and due-diligence conditions for the ${formatUsd(
        toPayloadCents(payload).totalHeldCents,
      )} escrow have been satisfied.`,
      status: "pending",
      assetClass,
    });
  }

  // 6 — Time-based: an earliest-permitted release date, if one was anchored.
  const releaseDate = rawAnchors.releaseDate?.trim();
  if (releaseDate) {
    const reached = isDateReached(releaseDate);
    conditions.push({
      id: `${sessionId}-time`,
      type: "time",
      label: "Release date reached",
      description: `Funds may not be released before ${releaseDate}.`,
      status: reached ? "met" : "pending",
      assetClass,
      releaseDate,
      ...(reached && { metAt: now }),
    });
  }

  return conditions;
}

/**
 * Has the release date arrived?
 *
 * An unparseable date returns `false` — the safe direction. A malformed
 * `releaseDate` must leave the condition pending for a human to sort out, never
 * silently satisfy a time lock.
 */
export function isDateReached(releaseDate: string, now: number = Date.now()): boolean {
  const target = new Date(releaseDate).getTime();
  if (!Number.isFinite(target)) return false;
  return now >= target;
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * Tally the checklist and decide whether settlement may proceed.
 *
 * `allMet` requires at least one condition. An empty checklist means nothing
 * was ever verified, and an escrow monitor that green-lights settlement because
 * it has no conditions to check is precisely the failure this screen exists to
 * prevent.
 */
export function evaluateSummary(conditions: Condition[]): ConditionSummary {
  let met = 0;
  let pending = 0;
  let failed = 0;

  for (const c of conditions) {
    if (c.status === "met") met++;
    else if (c.status === "pending" || c.status === "in_progress") pending++;
    else if (c.status === "failed") failed++;
    // 'waived' is intentionally in none of the buckets — see ConditionSummary.
  }

  return {
    total: conditions.length,
    met,
    pending,
    failed,
    allMet: conditions.length > 0 && conditions.every((c) => c.status === "met" || c.status === "waived"),
  };
}

// ── Incremental updates ──────────────────────────────────────────────────────

/**
 * Re-derive one eSign condition from its envelope's current status.
 *
 * A waived condition is returned untouched: the officer's waiver is a human
 * decision that a subsequent poll must not quietly revoke.
 */
export function updateConditionFromESign(condition: Condition, envelope: ESignEnvelope): Condition {
  if (condition.status === "waived") return condition;

  const status = statusFromESign(envelope.status);
  const now = new Date().toISOString();
  return {
    ...condition,
    status,
    signers: envelope.signers.map((s) => s.name),
    signerStatuses: signerStatusesFor(envelope),
    ...(envelope.onChainTx && { onChainTx: envelope.onChainTx }),
    ...(status === "met" && { metAt: condition.metAt ?? envelope.completedAt ?? now }),
    ...(status === "failed" && {
      failedAt: condition.failedAt ?? envelope.completedAt ?? now,
      failureReason: `Envelope ${envelope.status} — signature not collected.`,
    }),
  };
}

/** Re-derive one CannaVerify condition from a fresh adapter run. */
export function updateConditionFromCannaVerify(
  condition: Condition,
  result: CannaVerifyConditions,
): Condition {
  if (condition.status === "waived") return condition;

  const status = statusFromCannaVerify(result.overallResult);
  const now = new Date().toISOString();
  return {
    ...condition,
    status,
    cannaVerifyResult: result.overallResult,
    ...(status === "met" && { metAt: condition.metAt ?? result.completedAt ?? now }),
    ...(status === "failed" && {
      failedAt: condition.failedAt ?? result.completedAt ?? now,
      failureReason: "One or more CannaVerify regulatory checks did not pass.",
    }),
  };
}
