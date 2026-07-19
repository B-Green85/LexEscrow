/**
 * LexEscrow session store (Zustand).
 *
 * Owns the whole workflow: trust anchors → hashing → attorney verification →
 * AI parse (provider resolved from the credential vault) → LexGuard
 * co-validation with the nudge loop → forced review acknowledgment → final
 * blocking re-verify → CRE execution → client notification. Every consequential
 * step is written to the append-only, hash-chained audit trail.
 */

import { create } from "zustand";
import * as backend from "../lib/backend";
import { resolveProvider, ProviderUnavailableError, type AIParserProvider } from "../lib/ai/providers";
import { schemaFor } from "../lib/ai/assetSchemas";
import { type AssetClass } from "../lib/assetClasses";
import {
  runLexGuardPipeline,
  type EscalationDiscrepancy,
  type LexGuardCorrection,
  type Escalation,
} from "../lexguard/pipeline";
import { auditValueFor, constraintFor, escalationFindings } from "../lib/corrections";
import { ExecutionPath, type ParsedRetainerPayload, type TrustAnchors } from "../lexguard/types";
import { primeVDB, type VDBStore } from "../lexguard/vdb";
import { toPayloadCents } from "../lexguard/payload-diff";
import { runCannaVerify as runCannaVerifyAdapters } from "../lib/cannaverify";
import type { CannaVerifyConditions } from "../lib/cannaverify/types";
import { verifyBar, CALBAR_DEFAULT_BASE_URL, type BarVerifyResult } from "../lib/adapters";
import { resolveESignProvider, isTerminal, embeddedClientUserId } from "../lib/esign";
import type {
  EmbeddedSigningTarget,
  ESignEnvelope,
  ESignSigner,
  ESignStatus,
} from "../lib/esign";
import { normalizeName } from "../lexguard/anchor-matcher";
import * as releasePaths from "../lib/releasePaths";
import { downloadReceipt, issueReceipt, type AnchorReceipt } from "../lib/anchor-receipt";
import { fireIntegrationWebhooks } from "../lib/integrations";
import { setExplorerChain } from "../lib/explorer";
import type { BlockchainPublic } from "../lib/vaultTypes";
import { downloadAuditReport as downloadAuditReportPdf } from "../lib/export/audit-pdf-export";
import {
  buildConditions,
  evaluateSummary,
  type Condition,
  type ConditionSummary,
} from "../lib/conditions";
import type {
  ArbitrationSigner,
  ArbitrationState,
  MilestoneInput,
  StagedReleaseState,
} from "../lib/releasePaths";

export type { LexGuardCorrection, Escalation, EscalationDiscrepancy } from "../lexguard/pipeline";

/** One field resolved in the escalation dialog. Value is in payload-native units. */
export interface HumanCorrectionInput {
  field: string;
  value: number | string;
}

/** One Stage 4 override of a LexGuard correction (spec §30). */
export interface HumanOverrideInput {
  field: string;
  overrideValue: number | string;
  reason: string;
}

export type Screen =
  | "load"
  | "processing"
  | "review"
  | "conditions"
  | "escrow-monitor"
  | "execution"
  | "escalation"
  | "config"
  | "batch"
  | "anchor-receipt"
  | "recent";
export type StepStatus = "pending" | "active" | "done" | "error";
export type EntryMode = "ai" | "manual";
export type ProcPhase = "choose" | "running" | "manual";

export interface ProcessingStep {
  key: string;
  label: string;
  status: StepStatus;
}

export interface NotificationStatus {
  channel: "email" | "sms";
  target: string;
  status: "sent" | "delivered" | "skipped" | "failed";
}

export interface ExecutionState {
  phase: "idle" | "verifying" | "converting" | "settling" | "notifying" | "done" | "error";
  path: ExecutionPath | null;
  txHash: string | null;
  clientCents: bigint;
  firmCents: bigint;
  notifications: NotificationStatus[];
}

/** Values a human types in Manual Entry mode. Money fields are dollars. */
export interface ManualEntryFields {
  clientId: string;
  lawFirmWallet: string;
  clientWallet: string;
  totalHeld: number;
  earnedFees: number;
  unearnedBalance: number;
  disputedHours: number;
  disputedAmount: number;
  signaturesVerified: boolean;
  recommendedPath: ExecutionPath;
  anomaliesFlagged: string[];
}

/** What the batch screen hands to loadBatchItem (kept structural to avoid a store cycle). */
export interface BatchHydration {
  itemId: string;
  sessionId: string;
  file: File;
  artifact: backend.LoadedArtifact;
  vdb: VDBStore;
  payload: ParsedRetainerPayload;
  corrections: LexGuardCorrection[];
  escalation: Escalation | null;
  anchors: TrustAnchors;
  providerLabel: string;
  /** The item's own AnchorReceipt, issued when the batch hashed it. */
  anchorReceipt: AnchorReceipt | null;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Provider stand-in for manually entered payloads. LexGuard cannot ask a human
 * to "re-extract" one field mid-pipeline, so `correct` returns null — any
 * discrepancy surfaces to the reviewer as an escalation instead of being
 * auto-corrected. The system does not trust humans blindly either.
 */
const manualProvider: AIParserProvider = {
  label: "Manual entry",
  parse: async () => {
    throw new Error("manual entry has no parse step");
  },
  correct: async () => null,
};

const OPERATOR_DEFAULT = "paralegal@lawfirm.com";

/**
 * Demo build flag (spec Task 11).
 *
 * Switches the *externally-facing* seams to their mock counterparts — eSign
 * provider, adapter URLs, on-chain tx format — and nothing else. Everything
 * between: ArtifactGuard hashing, the LexGuard pipeline, the audit chain, the
 * condition engine, the release paths, runs exactly the production code. A demo
 * that took a different path through the workflow would not be demonstrating
 * the product.
 */
export const DEMO_MODE =
  import.meta.env?.VITE_DEMO_MODE === "true" || import.meta.env?.MODE === "demo";

const emptyAnchors: TrustAnchors = {
  attorneyBarNumber: "",
  state: "California",
  clientFullLegalName: "",
  clientEmail: "",
  clientPhone: "",
};

// Spec §12 Screen 3 — "Hashing → Registering → Parsing → Validating". The
// AnchorReceipt registration is its own visible stage, not a silent step
// folded into hashing: it is the moment the document acquires a provenance
// claim, and the officer needs to see it happen.
function stepsFor(mode: EntryMode): ProcessingStep[] {
  return [
    { key: "hash", label: "Hashing artifacts", status: "pending" },
    { key: "anchor", label: "Registering with AnchorReceipt", status: "pending" },
    { key: "bar", label: "Verifying attorney", status: "pending" },
    { key: "ai", label: mode === "manual" ? "Manual entry" : "AI parsing", status: "pending" },
    { key: "lexguard", label: "LexGuard validating", status: "pending" },
  ];
}

function initialSteps(): ProcessingStep[] {
  return stepsFor("ai");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Spec §16 — human-timescale events make a 30s poll indistinguishable from real-time. */
export const ESIGN_POLL_INTERVAL_MS = 30_000;

/** Escrow Monitor condition sweep. Same cadence, same reasoning. */
export const CONDITION_POLL_INTERVAL_MS = 30_000;

/** An empty checklist — nothing verified, so nothing may settle. */
export function emptyConditionSummary(): ConditionSummary {
  return { total: 0, met: 0, pending: 0, failed: 0, allMet: false };
}

/**
 * Carry human decisions across a re-derivation of the checklist.
 *
 * `buildConditions` is a pure projection of *machine-observable* state, so on
 * its own it cannot know that an officer waived a condition or manually
 * confirmed one — it would hand back `pending` and the poll loop would silently
 * undo the human's decision thirty seconds after they made it. This merge is
 * what makes the 30-second sweep safe to run against a screen a human is
 * actively working on.
 *
 * Machine-derived statuses are otherwise taken from the fresh build: that is
 * the whole point of polling.
 */
export function mergeConditions(previous: Condition[], next: Condition[]): Condition[] {
  const prior = new Map(previous.map((c) => [c.id, c]));
  return next.map((fresh) => {
    const old = prior.get(fresh.id);
    if (!old) return fresh;

    // A waiver is a human judgment. Automated re-derivation never revokes it.
    if (old.status === "waived") {
      return { ...fresh, status: "waived", metAt: old.metAt, failureReason: old.failureReason };
    }
    // Manual conditions have no machine signal at all — only a human moves them.
    if (fresh.type === "manual") {
      return { ...fresh, status: old.status, metAt: old.metAt };
    }
    // Otherwise trust the fresh status, but never lose an earlier timestamp.
    return {
      ...fresh,
      metAt: fresh.metAt ?? old.metAt,
      failedAt: fresh.failedAt ?? old.failedAt,
    };
  });
}

/**
 * The type-specific half of a condition, as stored in `metadata_json`.
 *
 * Listed explicitly rather than derived by omission: the identity, status and
 * timestamp fields have their own columns, and a spread-minus-known-keys would
 * silently start duplicating any field added to `Condition` later.
 */
/**
 * Fold the BarVerify verdict into the condition the builder produced.
 *
 * `buildConditions` knows only the boolean — it takes `barVerified` and has no
 * vocabulary for *why*. That is the right shape for a builder shared across
 * seven asset classes, but it loses exactly what an officer staring at a failed
 * bar condition needs to know: whether the attorney is suspended, the adapter
 * was unreachable, or the state simply is not implemented yet. Those call for
 * three different responses and only one of them concerns the attorney.
 *
 * So the reason is attached here, on the way out of the builder, rather than
 * pushed down into it.
 */
function withBarVerifyDetail(
  conditions: Condition[],
  result: BarVerifyResult | null,
): Condition[] {
  if (!result) return conditions;

  const attribution = [result.attorneyName, result.firmName].filter(Boolean).join(" · ");
  return conditions.map((c) =>
    c.type === "bar_verify"
      ? {
          ...c,
          description: attribution ? `${result.detail} (${attribution})` : result.detail,
          eventDescription: result.detail,
          creAdapterUrl: CALBAR_DEFAULT_BASE_URL,
          ...(c.status === "failed" && { failureReason: result.detail }),
        }
      : c,
  );
}

function conditionMetadata(c: Condition, barVerify: BarVerifyResult | null = null): string {
  return JSON.stringify({
    assetClass: c.assetClass,
    // The whole adapter verdict, not just the boolean — the persisted
    // condition row is what an audit reads back, and "active" without the
    // registry that said so proves nothing.
    ...(c.type === "bar_verify" && barVerify && { barVerify }),
    ...(c.documentHash !== undefined && { documentHash: c.documentHash }),
    ...(c.documentLabel !== undefined && { documentLabel: c.documentLabel }),
    ...(c.releaseDate !== undefined && { releaseDate: c.releaseDate }),
    ...(c.envelopeId !== undefined && { envelopeId: c.envelopeId }),
    ...(c.signers !== undefined && { signers: c.signers }),
    ...(c.signerStatuses !== undefined && { signerStatuses: c.signerStatuses }),
    ...(c.cannaVerifyResult !== undefined && { cannaVerifyResult: c.cannaVerifyResult }),
    ...(c.barNumber !== undefined && { barNumber: c.barNumber }),
    ...(c.barVerified !== undefined && { barVerified: c.barVerified }),
    ...(c.eventDescription !== undefined && { eventDescription: c.eventDescription }),
    ...(c.creAdapterUrl !== undefined && { creAdapterUrl: c.creAdapterUrl }),
  });
}

/**
 * Whole-word containment: does `needle` appear in `haystack` as a contiguous
 * run of complete words?
 *
 * Deliberately *not* a plain substring test. This gates condition fulfillment,
 * so a false positive is the dangerous direction — raw `includes` would let a
 * signer named "Cal" match the anchor "California", or "Jo" match "Jones".
 * Word-boundary matching still accepts the case that matters: "Jane Anderson"
 * against the anchor "Jane Anderson LLC".
 */
function containsAsWords(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  const h = haystack.split(" ");
  const n = needle.split(" ");
  if (n.length === 0 || n.length > h.length) return false;
  for (let i = 0; i + n.length <= h.length; i++) {
    if (n.every((word, j) => h[i + j] === word)) return true;
  }
  return false;
}

/**
 * AnchorMatcher for signer identities (spec §23).
 *
 * Every signer on the envelope must be traceable to a trust anchor collected at
 * Stage 1 — an unrecognized signer means the completed document was signed by
 * someone the escrow officer never named, which must not auto-fulfill a
 * condition. Matching is case- and whitespace-insensitive and word-bounded.
 */
export function signersMatchAnchors(
  signers: ESignSigner[],
  anchors: TrustAnchors,
  rawAnchors: Record<string, string>,
): boolean {
  const candidates = [...Object.values(anchors), ...Object.values(rawAnchors)]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map(normalizeName);
  if (candidates.length === 0 || signers.length === 0) return false;

  return signers.every((s) => {
    const name = normalizeName(s.name);
    if (!name) return false;
    return candidates.some((c) => containsAsWords(c, name) || containsAsWords(name, c));
  });
}

// A deterministic UUID-ish id without Math.random dependence at module load.
function newId(prefix: string): string {
  const rand = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${performance.now()}`;
  return `${prefix}-${rand}`;
}

export interface SessionState {
  screen: Screen;
  prevScreen: Screen;
  operator: string;
  providerLabel: string | null;
  configHint: "locked" | "unconfigured" | null;
  entryMode: EntryMode;
  procPhase: ProcPhase;
  assetClass: AssetClass;
  activeBatchItemId: string | null;
  fromBatch: boolean;
  anchors: TrustAnchors;
  /**
   * Per-class anchor record exactly as typed on Document Load, before it is
   * projected onto the legal-shaped `TrustAnchors`. Cannabis needs the fields
   * that projection drops — Metrc facility ID, license type, state.
   */
  rawAnchors: Record<string, string>;
  sessionId: string | null;
  file: File | null;
  artifact: backend.LoadedArtifact | null;
  vdb: VDBStore | null;
  payload: ParsedRetainerPayload | null;
  corrections: LexGuardCorrection[];
  escalation: Escalation | null;
  barActive: boolean | null;
  /**
   * The full adapter verdict behind `barActive`. Kept alongside the boolean
   * rather than replacing it because the condition metadata and the audit
   * trail need the reason, while the settlement gate only needs the answer.
   */
  barVerifyResult: BarVerifyResult | null;
  steps: ProcessingStep[];
  execution: ExecutionState;
  error: string | null;
  reviewOpenedAt: number | null;
  scrollCompleted: boolean;
  acknowledged: boolean;
  busy: boolean;
  cannaVerifyConditions: CannaVerifyConditions | null;
  cannaVerifyRunning: boolean;
  eSignEnvelopes: ESignEnvelope[];
  eSignPolling: boolean;
  /** Interval handle, held so `reset()` and terminal states can clear it. */
  eSignPollTimer: ReturnType<typeof setInterval> | null;

  // ── Release paths (spec §6) ──────────────────────────────────────────────
  /** Path B tally. Non-null once the escrow is locked into arbitration. */
  arbitrationState: ArbitrationState | null;
  /** Path C schedule. Null until the officer has defined the milestones. */
  stagedReleaseState: StagedReleaseState | null;
  /** True once `proceedToExecution` has routed to a release path. */
  releasePathChosen: boolean;

  // ── AnchorReceipt (spec §8) ──────────────────────────────────────────────
  /** Portable receipt for this session's document. Issued during processing. */
  anchorReceipt: AnchorReceipt | null;
  anchorReceiptIssuing: boolean;

  // ── Conditions + fund custody (spec §6 Stages 6–7) ───────────────────────
  /** The live checklist. Built on arrival at Condition Definition. */
  conditions: Condition[];
  conditionSummary: ConditionSummary;
  /** True once the officer has recorded the counterparty's deposit. */
  fundsDeposited: boolean;
  depositTxHash: string | null;
  /** Amount held, in integer cents — same discipline as every other money value. */
  escrowBalance: bigint;
  conditionPolling: boolean;
  /** Interval handle, held so `reset()` and `allMet` can clear it. */
  conditionPollTimer: ReturnType<typeof setInterval> | null;
  /** When the checklist was last re-evaluated (ISO). Drives the refresh line. */
  conditionsUpdatedAt: string | null;

  // ── Blockchain settlement config (vault-held) ────────────────────────────
  /**
   * Public view of the vault's blockchain entry. Null until first read, and on
   * a locked vault — the settle gate treats both as "not configured".
   */
  blockchain: BlockchainPublic | null;
  /**
   * Can this install actually settle on-chain? Distinct from
   * `blockchain.hasConfig`: this also requires a signing key. The settle button
   * gates on this; every other step of the workflow ignores it.
   */
  blockchainReady: boolean;

  // ── First-run setup wizard ───────────────────────────────────────────────
  /**
   * Is the guided onboarding flow on screen?
   *
   * Set by `checkWizard` at mount when no vault exists, and by `openWizard`
   * when an operator asks to re-run the flow from Configuration or the File
   * menu. Deliberately absent from `reset()` — starting a new transaction is
   * not a reason to be onboarded again.
   */
  showWizard: boolean;
  /** True once onboarding has been finished, or found to be unnecessary. */
  wizardComplete: boolean;

  // actions
  setAnchor: (patch: Partial<TrustAnchors>) => void;
  setRawAnchors: (raw: Record<string, string>) => void;
  runCannaVerify: () => Promise<void>;
  setFile: (file: File | null) => void;
  setEntryMode: (mode: EntryMode) => void;
  setAssetClass: (cls: AssetClass) => void;
  openConfig: () => void;
  closeConfig: () => void;
  openBatch: () => void;
  openAnchorReceiptConsole: () => void;
  openRecent: () => void;
  /** Decide, from the vault's existence, whether to onboard. Runs at mount. */
  checkWizard: () => Promise<void>;
  /** Re-run onboarding — Configuration's footer link and the File menu. */
  openWizard: () => void;
  completeWizard: () => void;
  downloadAnchorReceipt: () => void;
  returnToBatch: () => void;
  loadBatchItem: (h: BatchHydration) => void;
  reset: () => void;
  goToProcessing: () => void;
  beginProcessing: () => Promise<void>;
  submitManualEntry: (fields: ManualEntryFields) => Promise<void>;
  markScrollCompleted: () => void;
  setAcknowledged: (v: boolean) => Promise<void>;
  navigateToConditions: () => void;
  navigateToEscrowMonitor: () => void;
  // ── Condition tracking (spec §6 Stage 7) ────────────────────────────────
  initConditions: () => void;
  updateConditions: () => void;
  confirmFundsDeposited: (txHash: string) => void;
  startConditionPolling: () => void;
  stopConditionPolling: () => void;
  waiveCondition: (conditionId: string, reason: string) => void;
  markConditionMet: (conditionId: string) => void;
  proceedToSettlement: () => Promise<void>;
  /** Re-read the vault's blockchain config. Safe to call on a locked vault. */
  refreshBlockchainConfig: () => Promise<void>;
  sendForSignature: (
    documentLabel: string,
    signers: ESignSigner[],
    subject: string,
    message: string,
  ) => Promise<void>;
  /** Raise an embedded envelope for one internal signer (spec §22). */
  signInApp: (documentLabel: string, signer: ESignSigner) => Promise<EmbeddedSigningTarget | null>;
  completeEmbeddedSigning: (envelopeId: string, event: string) => Promise<void>;
  cancelEmbeddedSigning: (envelopeId: string) => Promise<void>;
  startESignPolling: () => void;
  stopESignPolling: () => void;
  pollAllEnvelopes: () => Promise<void>;
  handleESignCompletion: (envelopeId: string) => Promise<void>;
  proceedToExecution: () => Promise<void>;
  // Path B
  signArbitration: (signer: ArbitrationSigner, notes?: string) => Promise<void>;
  // Path C
  initStagedRelease: (milestones: MilestoneInput[]) => Promise<void>;
  submitEvidence: (milestoneId: string, file: File) => Promise<void>;
  approveMilestone: (milestoneId: string) => Promise<void>;
  releaseMilestone: (milestoneId: string, recipientAddress?: string) => Promise<void>;
  resolveEscalation: (choice: "review" | "ai" | "lexguard") => Promise<void>;
  resolveEscalationWithCorrections: (corrections: HumanCorrectionInput[]) => Promise<void>;
  applyHumanCorrections: (corrections: HumanCorrectionInput[]) => Promise<void>;
  applyHumanOverride: (override: HumanOverrideInput) => Promise<void>;
  buildAuditReport: () => Promise<string>;
  /** Printable audit report (spec §14 V1) — opens the browser print dialog. */
  downloadAuditReport: () => Promise<void>;
}

function stepStatus(steps: ProcessingStep[], key: string, status: StepStatus): ProcessingStep[] {
  return steps.map((s) => (s.key === key ? { ...s, status } : s));
}

export const useSession = create<SessionState>((set, get) => {
  // Sequential audit logger — preserves hash-chain order.
  const log = async (event: string, payload: Record<string, unknown>) => {
    const { sessionId, operator } = get();
    if (!sessionId) return;
    try {
      await backend.logEvent(sessionId, event, operator, JSON.stringify(payload));
    } catch (e) {
      console.error("audit log failed", event, e);
    }
  };

  const setStep = (key: string, status: StepStatus) =>
    set((s) => ({ steps: stepStatus(s.steps, key, status) }));

  /**
   * Report a lifecycle event to whichever practice-management systems are
   * configured (spec §14 V1).
   *
   * Fire-and-forget by contract. Every call site awaits this — so ordering
   * stays deterministic and tests are not racing background work — but nothing
   * downstream branches on the outcome, and no failure propagates. The escrow
   * event being reported has already happened and is already on the audit
   * chain; a practice-management server that is down cannot retract it.
   *
   * Under Tauri the configs come back without their API keys and delivery is
   * delegated to the Rust backend, which holds the credential. That is why the
   * transport is swapped in here rather than the key being fetched: the vault's
   * invariant is that secrets do not cross IPC, and webhooks are not an
   * exception to it.
   */
  const notifyIntegrations = async (event: string) => {
    try {
      const configs = await backend.getIntegrationConfigs();
      if (!configs.clio && !configs.practicePanther) return;
      await fireIntegrationWebhooks(event, get(), {
        ...configs,
        ...(backend.isTauri() && { transport: backend.sendIntegrationWebhook }),
      });
    } catch (e) {
      console.error("integration webhooks failed", event, e);
    }
  };

  /**
   * HUMAN_CORRECTION (spec §32) — the officer restated a value the nudge loop
   * could not resolve. Records all three AI attempts alongside the officer's
   * value and identity: this is the liability-transfer moment, so the record has
   * to show what the machine offered and what the human chose instead.
   *
   * Money is written to the trail as integer cents per the spec payload example,
   * even though the in-memory payload carries dollars.
   */
  const logHumanCorrection = async (
    finding: EscalationDiscrepancy & { constraint: string },
    officerValue: number | string,
  ) => {
    await log("HUMAN_CORRECTION", {
      field: finding.field,
      lexguard_module: finding.module,
      constraint: finding.constraint,
      document_extracted_value: auditValueFor(finding.field, finding.observedValue),
      ai_attempt_1: auditValueFor(finding.field, finding.aiAttempt1),
      ai_attempt_2: auditValueFor(finding.field, finding.aiAttempt2),
      ai_attempt_3: auditValueFor(finding.field, finding.aiAttempt3),
      officer_corrected_value: auditValueFor(finding.field, officerValue),
      officer_identity: get().operator,
      attestation: true,
      block_timestamp: new Date().toISOString(),
    });
  };

  /**
   * HUMAN_OVERRIDE (spec §32) — distinct from HUMAN_CORRECTION because it
   * signals the officer consciously chose a value *different from* what
   * automated validation produced. The reason text is the whole point of the
   * record and is never optional at the call site.
   */
  const logHumanOverride = async (
    field: string,
    module: string,
    lexGuardValue: number | string,
    overrideValue: number | string,
    reason: string,
  ) => {
    await log("HUMAN_OVERRIDE", {
      field,
      lexguard_module: module,
      lexguard_corrected_value: auditValueFor(field, lexGuardValue),
      officer_override_value: auditValueFor(field, overrideValue),
      override_reason: reason,
      officer_identity: get().operator,
      block_timestamp: new Date().toISOString(),
    });
  };

  // Shared tail: run the LexGuard pipeline on a payload (from AI or manual
  // entry), persist integer cents, and route to review or escalation.
  const runPipelineAndRoute = async (
    payload: ParsedRetainerPayload,
    vdb: VDBStore,
    sessionId: string,
    anchors: TrustAnchors,
    provider: AIParserProvider,
    entryMode: EntryMode,
  ) => {
    setStep("lexguard", "active");
    const result = await runLexGuardPipeline({
      payload,
      vdb,
      anchors,
      chainlinkVerifiedBar: anchors.attorneyBarNumber,
      provider,
    });
    set({ payload: result.payload, corrections: result.corrections, escalation: result.escalation });

    for (const c of result.corrections) {
      await log("LEXGUARD_CORRECTION", {
        module: c.module,
        field: c.field,
        aiValue: c.aiValue,
        observedValue: c.observedValue,
        nudgeCount: c.nudgeCount,
        resolved: c.resolved,
      });
    }

    const cents = toPayloadCents(result.payload);
    await backend.savePayload({
      payloadId: newId("pl"),
      sessionId,
      totalHeldCents: Number(cents.totalHeldCents),
      earnedFeesCents: Number(cents.earnedFeesCents),
      unearnedBalanceCents: Number(cents.unearnedBalanceCents),
      disputedHours: cents.disputedHours,
      disputedAmountCents: Number(cents.disputedAmountCents),
      assetClass: get().assetClass,
      entryMode,
    });
    setStep("lexguard", "done");

    if (result.escalation) {
      await backend.updateSessionState(sessionId, "ESCALATED");
      set({ screen: "escalation", busy: false });
    } else {
      set({
        screen: "review",
        reviewOpenedAt: Date.now(),
        scrollCompleted: false,
        acknowledged: false,
        busy: false,
      });
      await log("review_screen_opened", { entry_mode: entryMode });
    }
  };

  return {
    screen: "load",
    prevScreen: "load",
    operator: OPERATOR_DEFAULT,
    providerLabel: null,
    configHint: null,
    entryMode: "ai",
    procPhase: "choose",
    assetClass: "legal",
    activeBatchItemId: null,
    fromBatch: false,
    anchors: emptyAnchors,
    rawAnchors: {},
    sessionId: null,
    file: null,
    artifact: null,
    vdb: null,
    payload: null,
    corrections: [],
    escalation: null,
    barActive: null,
    barVerifyResult: null,
    steps: initialSteps(),
    execution: {
      phase: "idle",
      path: null,
      txHash: null,
      clientCents: 0n,
      firmCents: 0n,
      notifications: [],
    },
    error: null,
    reviewOpenedAt: null,
    scrollCompleted: false,
    acknowledged: false,
    busy: false,
    cannaVerifyConditions: null,
    cannaVerifyRunning: false,
    eSignEnvelopes: [],
    eSignPolling: false,
    eSignPollTimer: null,
    arbitrationState: null,
    stagedReleaseState: null,
    releasePathChosen: false,
    anchorReceipt: null,
    anchorReceiptIssuing: false,
    conditions: [],
    conditionSummary: emptyConditionSummary(),
    fundsDeposited: false,
    depositTxHash: null,
    escrowBalance: 0n,
    conditionPolling: false,
    conditionPollTimer: null,
    conditionsUpdatedAt: null,
    blockchain: null,
    blockchainReady: false,
    showWizard: false,
    wizardComplete: false,

    setAnchor: (patch) => set((s) => ({ anchors: { ...s.anchors, ...patch } })),
    setRawAnchors: (raw) => set({ rawAnchors: raw }),
    setFile: (file) => set({ file }),
    setEntryMode: (mode) => set({ entryMode: mode }),
    setAssetClass: (cls) => set({ assetClass: cls }),
    openConfig: () =>
      set((s) =>
        s.screen === "config" ? { screen: s.prevScreen } : { prevScreen: s.screen, screen: "config" },
      ),
    closeConfig: () => set((s) => ({ screen: s.prevScreen })),
    openBatch: () =>
      set((s) =>
        s.screen === "batch" ? { screen: s.prevScreen } : { prevScreen: s.screen, screen: "batch" },
      ),

    /** Screen 8 — standalone fingerprinting, outside any escrow workflow.
     *  Remembers where the officer came from so closing returns them there. */
    openAnchorReceiptConsole: () =>
      set((s) =>
        s.screen === "anchor-receipt"
          ? { screen: s.prevScreen }
          : { prevScreen: s.screen, screen: "anchor-receipt" },
      ),

    /** Screen 9 — the session history, reached from the File menu (Cmd+R).
     *  Toggles, so the same menu item that opens it closes it again. */
    openRecent: () =>
      set((s) =>
        s.screen === "recent" ? { screen: s.prevScreen } : { prevScreen: s.screen, screen: "recent" },
      ),

    /**
     * First-run detection (spec §12 Screen 0).
     *
     * The vault's existence *is* the answer. Every credential the wizard
     * collects lives in the vault, so "no vault" and "this install has never
     * been set up" are the same condition — and unlike a stored flag, it
     * survives a cleared browser profile and cannot claim an install is
     * configured when its credentials are gone.
     *
     * A failure here is not fatal: an unreadable vault status is a reason to
     * leave the operator in the app, not to trap them behind an onboarding
     * flow whose first step would fail for the same reason.
     */
    checkWizard: async () => {
      try {
        const status = await backend.vaultStatus();
        if (status.exists) {
          set({ showWizard: false, wizardComplete: true });
        } else {
          set({ showWizard: true });
        }
      } catch (e) {
        console.error("vault status check failed", e);
      }
    },

    openWizard: () => set({ showWizard: true }),

    completeWizard: () => {
      set({ showWizard: false, wizardComplete: true });
      // Belt and suspenders. `checkWizard` never reads this back — the vault is
      // the real check — but it leaves a trace of a completed onboarding for a
      // future migration that needs one.
      try {
        localStorage.setItem("lexescrow_wizard_complete", "true");
      } catch {
        // Private-mode or storage-disabled browsers. Nothing depends on it.
      }
    },

    downloadAnchorReceipt: () => {
      const { anchorReceipt } = get();
      if (!anchorReceipt) return;
      downloadReceipt(anchorReceipt);
    },

    returnToBatch: () => set({ screen: "batch", activeBatchItemId: null, fromBatch: false }),

    loadBatchItem: (h) =>
      set({
        activeBatchItemId: h.itemId,
        fromBatch: true,
        sessionId: h.sessionId,
        file: h.file,
        artifact: h.artifact,
        vdb: h.vdb,
        payload: h.payload,
        corrections: h.corrections,
        escalation: h.escalation,
        anchors: h.anchors,
        providerLabel: h.providerLabel,
        anchorReceipt: h.anchorReceipt,
        anchorReceiptIssuing: false,
        barActive: true,
        error: null,
        configHint: null,
        procPhase: "running",
        execution: { phase: "idle", path: null, txHash: null, clientCents: 0n, firmCents: 0n, notifications: [] },
        reviewOpenedAt: h.escalation ? null : Date.now(),
        scrollCompleted: false,
        acknowledged: false,
        screen: h.escalation ? "escalation" : "review",
      }),

    reset: () => {
      // A dangling interval would keep polling a session that no longer exists.
      const { eSignPollTimer, conditionPollTimer } = get();
      if (eSignPollTimer) clearInterval(eSignPollTimer);
      if (conditionPollTimer) clearInterval(conditionPollTimer);
      set({
        screen: "load",
        providerLabel: null,
        configHint: null,
        entryMode: "ai",
        procPhase: "choose",
        assetClass: "legal",
        activeBatchItemId: null,
        fromBatch: false,
        anchors: emptyAnchors,
        rawAnchors: {},
        sessionId: null,
        file: null,
        artifact: null,
        vdb: null,
        payload: null,
        corrections: [],
        escalation: null,
        barActive: null,
        barVerifyResult: null,
        steps: initialSteps(),
        execution: { phase: "idle", path: null, txHash: null, clientCents: 0n, firmCents: 0n, notifications: [] },
        error: null,
        reviewOpenedAt: null,
        scrollCompleted: false,
        acknowledged: false,
        busy: false,
        cannaVerifyConditions: null,
        cannaVerifyRunning: false,
        eSignEnvelopes: [],
        eSignPolling: false,
        eSignPollTimer: null,
        arbitrationState: null,
        stagedReleaseState: null,
        releasePathChosen: false,
        anchorReceipt: null,
        anchorReceiptIssuing: false,
        conditions: [],
        conditionSummary: emptyConditionSummary(),
        fundsDeposited: false,
        depositTxHash: null,
        escrowBalance: 0n,
        conditionPolling: false,
        conditionPollTimer: null,
        conditionsUpdatedAt: null,
      });
    },

    // DocumentLoad → Processing screen, showing the entry-mode toggle before
    // anything runs.
    goToProcessing: () => {
      const { file } = get();
      if (!file) {
        set({ error: "Please add a retainer document before continuing." });
        return;
      }
      set({
        screen: "processing",
        procPhase: "choose",
        steps: initialSteps(),
        error: null,
        configHint: null,
        payload: null,
        corrections: [],
        escalation: null,
        reviewOpenedAt: null,
        scrollCompleted: false,
        acknowledged: false,
        execution: { phase: "idle", path: null, txHash: null, clientCents: 0n, firmCents: 0n, notifications: [] },
        // A new document invalidates any prior regulatory verification.
        cannaVerifyConditions: null,
        cannaVerifyRunning: false,
      });
    },

    // Start button on the Processing screen. Hashes + verifies the attorney,
    // then either runs AI parsing or shows the manual-entry form.
    beginProcessing: async () => {
      const { file, anchors, entryMode, assetClass } = get();
      if (!file) {
        set({ error: "Please add a retainer document before continuing." });
        return;
      }
      const sessionId = newId("wf");
      set({
        sessionId,
        procPhase: "running",
        steps: stepsFor(entryMode),
        error: null,
        configHint: null,
        busy: true,
      });

      try {
        // 1) Hash + normalize in the backend.
        setStep("hash", "active");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const artifact = await backend.loadArtifact(file.name, bytes);
        set({ artifact });
        await backend.createSession({
          sessionId,
          // The anchored party, not the parsed `clientId`. Trust anchors are
          // authoritative and known now, whereas the payload's client id
          // arrives several steps later — and Recent Workflows lists sessions
          // that never got that far, which used to leave every row reading
          // "pending" in the one column an officer scans by.
          clientId: anchors.clientFullLegalName.trim() || "Unidentified party",
          attorneyBarNumber: anchors.attorneyBarNumber,
          documentHash: artifact.hash,
          assetClass,
        });
        await log("document_loaded", { filename: artifact.filename, hash: artifact.hash, size: artifact.size });
        await log("trust_anchors_provided", {
          bar_last4: anchors.attorneyBarNumber.slice(-4),
          state: anchors.state,
          client_name: anchors.clientFullLegalName,
        });
        setStep("hash", "done");
        await notifyIntegrations("session.created");

        // 1b) AnchorReceipt — seal the fingerprint, anchor it on-chain, issue
        // the portable receipt (spec §8). Runs after `createSession` because
        // the fingerprint registry row is foreign-keyed to the session.
        //
        // Registration failure does not halt processing: the document is
        // already hashed and the workflow's integrity guarantees (ArtifactGuard
        // baseline, final blocking re-verify) do not depend on the receipt. The
        // step is marked `error` so the officer can see the provenance claim is
        // missing rather than assuming a receipt exists.
        setStep("anchor", "active");
        set({ anchorReceiptIssuing: true });
        try {
          const receipt = await issueReceipt({
            sessionId,
            assetClass,
            items: [{ label: artifact.filename, hash: artifact.hash, size: artifact.size }],
          });
          set({ anchorReceipt: receipt, anchorReceiptIssuing: false });
          await log("anchor_receipt_issued", {
            receipt_id: receipt.receiptId,
            on_chain_tx: receipt.items[0]?.onChainTx ?? null,
            hmac: receipt.items[0]?.hmac ?? null,
            receipt_hash: receipt.receiptHash,
            overall_status: receipt.summary.overallStatus,
          });
          setStep("anchor", "done");
          await notifyIntegrations("receipt.issued");
        } catch (e) {
          // The commonest cause is a locked vault — the seal key is per-install
          // and lives there, so a locked vault means this install cannot
          // currently attest anything. Surface the backend's reason on the step
          // itself rather than the fatal-error banner: processing genuinely
          // continues, and the officer needs to know *what to do*, not just
          // that a light went red.
          const message = e instanceof Error ? e.message : String(e);
          set((s) => ({
            anchorReceiptIssuing: false,
            steps: s.steps.map((step) =>
              step.key === "anchor"
                ? { ...step, status: "error", label: `Registration unavailable — ${message}` }
                : step,
            ),
          }));
          await log("anchor_receipt_failed", { error: message });
        }

        // 2) Verify attorney standing via the BarVerify adapter — both modes.
        //
        // Replaces the format check this step used to do. A regex over the bar
        // number proves the number is *shaped* like a bar number; it cannot
        // tell an active attorney from a suspended one, which is the only
        // question that matters before releasing a retainer.
        setStep("bar", "active");
        const barResult = await verifyBar(
          anchors.attorneyBarNumber,
          anchors.state,
          CALBAR_DEFAULT_BASE_URL,
        );
        const active = barResult.status === "active";
        set({ barActive: active, barVerifyResult: barResult });
        await log("bar_verification_result", {
          active,
          status: barResult.status,
          state: barResult.state,
          source: `BarVerify adapter — ${barResult.state}`,
          detail: barResult.detail,
          attorney_name: barResult.attorneyName ?? null,
          admission_date: barResult.admissionDate ?? null,
          firm_name: barResult.firmName ?? null,
          // The number itself stays out of the audit payload — the last four
          // are enough to correlate an entry without recording the identifier.
          bar_last4: anchors.attorneyBarNumber.slice(-4),
        });
        if (!active) {
          setStep("bar", "error");
          set({
            // The adapter's own detail, not a generic message: "scaffold",
            // "unreachable" and "suspended" call for three different actions
            // from the officer, and only one of them is the attorney's problem.
            // Trailing punctuation is normalized because `detail` comes from
            // fifty different adapters and cannot be assumed to end cleanly.
            error: `Attorney bar verification did not pass — ${barResult.detail.replace(
              /[.\s]*$/,
              "",
            )}. Processing halted.`,
            busy: false,
          });
          await backend.updateSessionState(sessionId, "FAILED");
          return;
        }
        setStep("bar", "done");

        // 3) Prime the VDB from the artifact (both modes validate against it).
        await backend.updateSessionState(sessionId, "PARSING");
        const vdb = await primeVDB(artifact.normalizedText, artifact.hash, sessionId);
        set({ vdb });

        // Manual entry: stop here and let the human fill the form.
        if (entryMode === "manual") {
          set({ procPhase: "manual", busy: false });
          return;
        }

        // 4) AI parse — provider resolved from the vault.
        setStep("ai", "active");
        let provider;
        try {
          provider = await resolveProvider();
        } catch (e) {
          if (e instanceof ProviderUnavailableError) {
            setStep("ai", "error");
            set({
              error: e.message,
              configHint: e.code === "VAULT_LOCKED" ? "locked" : "unconfigured",
              busy: false,
            });
            await backend.updateSessionState(sessionId, "FAILED");
            return;
          }
          throw e;
        }

        let parsed: ParsedRetainerPayload;
        try {
          parsed = await provider.parse(artifact.normalizedText, schemaFor(assetClass));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          setStep("ai", "error");
          set({ error: `AI parsing failed: ${message}`, busy: false });
          await backend.updateSessionState(sessionId, "FAILED");
          return;
        }

        // Trust anchors are authoritative — apply them over the doc extraction.
        const payload: ParsedRetainerPayload = {
          ...parsed,
          barNumber: anchors.attorneyBarNumber,
          clientName: parsed.clientName ?? anchors.clientFullLegalName,
        };
        set({ payload, providerLabel: provider.label });
        await log("parse", { entry_mode: "ai", provider: provider.label });
        setStep("ai", "done");

        // 5) LexGuard co-validation + route.
        await runPipelineAndRoute(payload, vdb, sessionId, anchors, provider, "ai");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Processing failed: ${message}`, busy: false });
        setStep("lexguard", "error");
      }
    },

    // Manual-entry form submit — LexGuard runs on the human's payload exactly as
    // it would against AI output. The system does not trust humans blindly.
    submitManualEntry: async (f) => {
      const { artifact, vdb, sessionId, anchors } = get();
      if (!artifact || !vdb || !sessionId) {
        set({ error: "Manual entry is not ready — reload the document." });
        return;
      }
      set({ procPhase: "running", busy: true, error: null });
      setStep("ai", "done");

      try {
        const payload: ParsedRetainerPayload = {
          clientId: f.clientId || "C-UNKNOWN",
          lawFirmWallet: f.lawFirmWallet || ZERO_ADDR,
          clientWallet: f.clientWallet || ZERO_ADDR,
          totalHeld: f.totalHeld,
          earnedFees: f.earnedFees,
          unearnedBalance: f.unearnedBalance,
          disputedHours: f.disputedHours,
          disputedAmount: f.disputedAmount,
          signaturesVerified: f.signaturesVerified,
          recommendedPath: f.recommendedPath,
          anomaliesFlagged: f.anomaliesFlagged,
          anomaliesSuppressed: false,
          barNumber: anchors.attorneyBarNumber,
          clientName: anchors.clientFullLegalName,
          extractedBarNumber: null,
        };
        set({ payload, providerLabel: "Manual entry" });
        await log("parse", { entry_mode: "manual", provider: "manual" });
        await runPipelineAndRoute(payload, vdb, sessionId, anchors, manualProvider, "manual");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Manual entry failed: ${message}`, busy: false });
        setStep("lexguard", "error");
      }
    },

    markScrollCompleted: () => {
      if (get().scrollCompleted) return;
      set({ scrollCompleted: true });
      void log("review_scroll_completed", {});
    },

    setAcknowledged: async (v) => {
      set({ acknowledged: v });
      if (v) {
        await log("acknowledgment_checked", { user: get().operator });
      }
    },

    /**
     * CannaVerify condition run (spec §5). Cannabis IND only — every cannabis
     * transaction requires verified state licensure before funds move, so this
     * gates settlement on the Parsed Output Review screen.
     */
    runCannaVerify: async () => {
      const { assetClass, sessionId, anchors, rawAnchors, payload } = get();
      if (assetClass !== "cannabis_ind" || !sessionId) return;

      set({ cannaVerifyRunning: true, error: null });
      try {
        // The raw anchor record carries the cannabis-specific fields; the
        // legal-shaped TrustAnchors projection keeps only the identifier.
        const stateLicenseNum = rawAnchors.stateLicenseNumber || anchors.attorneyBarNumber;
        const conditions = await runCannaVerifyAdapters({
          sessionId,
          stateLicenseNum,
          metrcFacilityId: rawAnchors.metrcFacilityId ?? "",
          licenseType: rawAnchors.licenseType ?? "",
          // Cannabis anchors carry no state field of their own; the license
          // number is state-scoped, so fall back to the CA demo default.
          state: rawAnchors.state || anchors.state || "CA",
          // Temporary bridge: the cannabis payload stows batch numbers in
          // anomaliesFlagged. V2 gets proper cannabis-specific payload fields.
          inventorySchedule: payload?.anomaliesFlagged ?? [],
        });
        set({ cannaVerifyConditions: conditions, cannaVerifyRunning: false });
        await log("cannaverify_completed", {
          overall_result: conditions.overallResult,
          state_license_num: stateLicenseNum,
          metrc_facility_id: conditions.metrcFacilityId,
          checks: conditions.checks.map((c) => ({ type: c.checkType, result: c.result })),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ cannaVerifyRunning: false, error: `CannaVerify failed: ${message}` });
      }
    },

    /**
     * Stage 4. Building the checklist on arrival — rather than on the monitor —
     * means the officer confirms conditions that already exist as tracked
     * objects, so nothing they see on Stage 4 is invented again later.
     */
    navigateToConditions: () => {
      set({ screen: "conditions" });
      get().initConditions();
    },

    navigateToEscrowMonitor: () => set({ screen: "escrow-monitor" }),

    // ── Condition tracking (spec §6 Stage 7) ────────────────────────────────

    /**
     * Build (or rebuild) the checklist from current session state and persist
     * it. Safe to call repeatedly: ids are deterministic and `mergeConditions`
     * carries human decisions forward, so re-entering Stage 4 does not discard
     * a waiver granted on the monitor.
     */
    initConditions: () => {
      const {
        sessionId,
        assetClass,
        payload,
        rawAnchors,
        anchorReceipt,
        eSignEnvelopes,
        cannaVerifyConditions,
        barActive,
        barVerifyResult,
        conditions: previous,
      } = get();
      if (!sessionId || !payload) return;

      const built = withBarVerifyDetail(
        buildConditions({
          sessionId,
          assetClass,
          payload,
          rawAnchors,
          anchorReceipt,
          eSignEnvelopes,
          cannaVerifyConditions,
          barVerified: barActive,
        }),
        barVerifyResult,
      );
      const conditions = mergeConditions(previous, built);

      set({
        conditions,
        conditionSummary: evaluateSummary(conditions),
        conditionsUpdatedAt: new Date().toISOString(),
      });

      // Persistence is sequential and fire-and-forget: the checklist is already
      // in the store, and a failed write must not block the officer's screen.
      void (async () => {
        for (const c of conditions) {
          try {
            await backend.saveCondition({
              sessionId,
              conditionId: c.id,
              conditionType: c.type,
              label: c.label,
              description: c.description,
              status: c.status,
              metadataJson: conditionMetadata(c, barVerifyResult),
            });
          } catch (e) {
            console.error("condition save failed", c.id, e);
          }
        }
      })();
    },

    /**
     * Re-evaluate every condition against current session state and persist
     * only what actually moved. Called by the 30-second sweep and by the
     * monitor's manual Refresh.
     */
    updateConditions: () => {
      const {
        sessionId,
        assetClass,
        payload,
        rawAnchors,
        anchorReceipt,
        eSignEnvelopes,
        cannaVerifyConditions,
        barActive,
        barVerifyResult,
        conditions: previous,
      } = get();
      if (!sessionId || !payload || previous.length === 0) return;

      const built = withBarVerifyDetail(
        buildConditions({
          sessionId,
          assetClass,
          payload,
          rawAnchors,
          anchorReceipt,
          eSignEnvelopes,
          cannaVerifyConditions,
          barVerified: barActive,
        }),
        barVerifyResult,
      );
      const conditions = mergeConditions(previous, built);

      const priorStatus = new Map(previous.map((c) => [c.id, c.status]));
      const changed = conditions.filter((c) => priorStatus.get(c.id) !== c.status);

      const wasAllMet = get().conditionSummary.allMet;
      const summary = evaluateSummary(conditions);

      set({
        conditions,
        conditionSummary: summary,
        conditionsUpdatedAt: new Date().toISOString(),
      });

      // Only on the *transition*. The sweep runs every thirty seconds and this
      // stays true once reached, so an unguarded call would re-notify the
      // firm's practice-management system twice a minute until settlement.
      if (summary.allMet && !wasAllMet) {
        void notifyIntegrations("conditions.met");
      }

      if (changed.length === 0) return;

      void (async () => {
        for (const c of changed) {
          try {
            await backend.updateConditionStatus({
              conditionId: c.id,
              status: c.status,
              metAt: c.metAt ?? null,
              failedAt: c.failedAt ?? null,
              failureReason: c.failureReason ?? null,
              onChainTx: c.onChainTx ?? null,
            });
          } catch (e) {
            console.error("condition status write failed", c.id, e);
          }
          // A condition changing state is what moves an escrow toward release,
          // so each transition is part of the legal record, not just telemetry.
          await log("condition_status_changed", {
            condition_id: c.id,
            condition_type: c.type,
            label: c.label,
            from: priorStatus.get(c.id) ?? null,
            to: c.status,
            on_chain_tx: c.onChainTx ?? null,
          });
        }
      })();
    },

    /**
     * Stage 6 — record the counterparty's deposit into escrow.
     *
     * The officer supplies the transaction hash rather than the app watching a
     * wallet: this build has no chain connection, and inventing a confirmation
     * the system did not observe would be the one lie the audit trail cannot
     * afford. The escrow balance is the payload's total held.
     */
    confirmFundsDeposited: (txHash) => {
      const { sessionId, payload } = get();
      if (!sessionId || !payload) return;
      const trimmed = txHash.trim();
      if (!trimmed) {
        set({ error: "Enter the deposit transaction hash before confirming." });
        return;
      }

      const escrowBalance = toPayloadCents(payload).totalHeldCents;
      set({
        fundsDeposited: true,
        depositTxHash: trimmed,
        escrowBalance,
        error: null,
      });

      void (async () => {
        try {
          await backend.updateSessionState(sessionId, "FUNDED");
        } catch (e) {
          console.error("session state FUNDED failed", e);
        }
        await log("funds_deposited", {
          workflow_id: sessionId,
          tx_hash: trimmed,
          amount_usdc: Number(escrowBalance) / 100,
          officer_identity: get().operator,
          block_timestamp: new Date().toISOString(),
        });
        await notifyIntegrations("funds.deposited");
      })();

      get().startConditionPolling();
    },

    /**
     * Begin the 30-second condition sweep. Idempotent, and a no-op once every
     * condition is met — there is nothing left to watch.
     */
    startConditionPolling: () => {
      if (get().conditionPollTimer) return;
      if (get().conditionSummary.allMet) return;

      const timer = setInterval(() => {
        void (async () => {
          const state = get();
          // Signature status is the commonest thing to move, and it is the one
          // signal that lives behind an external API rather than in the store.
          if (state.eSignEnvelopes.some((e) => !isTerminal(e.status))) {
            try {
              await state.pollAllEnvelopes();
            } catch (e) {
              console.error("envelope poll failed during condition sweep", e);
            }
          }
          get().updateConditions();
          if (get().conditionSummary.allMet) get().stopConditionPolling();
        })();
      }, CONDITION_POLL_INTERVAL_MS);

      set({ conditionPolling: true, conditionPollTimer: timer });
    },

    stopConditionPolling: () => {
      const timer = get().conditionPollTimer;
      if (timer) clearInterval(timer);
      set({ conditionPolling: false, conditionPollTimer: null });
    },

    /**
     * Proceed without a condition being satisfied.
     *
     * The reason text is the entire point of the record — a waiver is the
     * officer accepting personal liability for an unmet gate, and the audit
     * entry is what makes that transfer legible later.
     */
    waiveCondition: (conditionId, reason) => {
      const { conditions } = get();
      const target = conditions.find((c) => c.id === conditionId);
      if (!target || target.status === "waived") return;

      const next = conditions.map((c) =>
        c.id === conditionId ? { ...c, status: "waived" as const, failureReason: reason } : c,
      );
      set({
        conditions: next,
        conditionSummary: evaluateSummary(next),
        conditionsUpdatedAt: new Date().toISOString(),
      });

      void (async () => {
        try {
          await backend.updateConditionStatus({
            conditionId,
            status: "waived",
            failureReason: reason,
          });
        } catch (e) {
          console.error("condition waiver write failed", conditionId, e);
        }
        await log("condition_waived", {
          condition_id: conditionId,
          condition_type: target.type,
          label: target.label,
          previous_status: target.status,
          waiver_reason: reason,
          officer_identity: get().operator,
          block_timestamp: new Date().toISOString(),
        });
      })();
    },

    /**
     * Human confirmation of a `manual` condition. Restricted to that type on
     * purpose: everything else has a machine signal, and letting an officer
     * hand-mark a CannaVerify or signature condition as met would turn a
     * verified gate into an unverified assertion with no trace of the swap.
     * Overriding one of those is a *waiver*, and it is recorded as one.
     */
    markConditionMet: (conditionId) => {
      const { conditions } = get();
      const target = conditions.find((c) => c.id === conditionId);
      if (!target || target.type !== "manual" || target.status === "met") return;

      const metAt = new Date().toISOString();
      const next = conditions.map((c) =>
        c.id === conditionId ? { ...c, status: "met" as const, metAt } : c,
      );
      set({
        conditions: next,
        conditionSummary: evaluateSummary(next),
        conditionsUpdatedAt: metAt,
      });

      void (async () => {
        try {
          await backend.updateConditionStatus({ conditionId, status: "met", metAt });
        } catch (e) {
          console.error("manual condition write failed", conditionId, e);
        }
        await log("condition_manually_confirmed", {
          condition_id: conditionId,
          condition_type: target.type,
          label: target.label,
          officer_identity: get().operator,
          attestation: true,
          block_timestamp: metAt,
        });
      })();
    },

    /**
     * The settlement gate. A guard wrapper around `proceedToExecution` —
     * `allMet` is true only when every condition is met or explicitly waived,
     * so this is the single place the checklist actually blocks money moving.
     */
    /**
     * Re-read the vault's blockchain config into the store.
     *
     * Never throws. A locked vault, a browser build with no backend, or an
     * absent entry all resolve to "not configured" — because the only thing
     * this gates is settlement, and every other step of the workflow
     * (parsing, LexGuard, conditions, eSign) must keep working regardless.
     * Turning a locked vault into a thrown error here would take the whole
     * screen down over a credential the officer may not need for another hour.
     */
    refreshBlockchainConfig: async () => {
      try {
        const [pub, ready] = await Promise.all([
          backend.getBlockchainPublic(),
          backend.hasBlockchain(),
        ]);
        // Explorer links follow the configured chain — see lib/explorer.ts.
        setExplorerChain(pub.chainId);
        set({ blockchain: pub, blockchainReady: ready });
      } catch {
        set({ blockchain: null, blockchainReady: false });
      }
    },

    proceedToSettlement: async () => {
      const { conditionSummary, fundsDeposited } = get();

      if (!fundsDeposited) {
        set({ error: "Record the escrow deposit before settling." });
        return;
      }

      if (!conditionSummary.allMet) {
        set({
          error:
            conditionSummary.total === 0
              ? "No conditions have been defined for this escrow — nothing has been verified."
              : `${conditionSummary.pending + conditionSummary.failed} condition(s) are still unmet. Satisfy or waive them before settling.`,
        });
        return;
      }

      get().stopConditionPolling();
      await log("conditions_all_met", {
        workflow_id: get().sessionId,
        total: conditionSummary.total,
        met: conditionSummary.met,
        waived: conditionSummary.total - conditionSummary.met,
        officer_identity: get().operator,
      });

      // The blockchain gate, checked last and deliberately so.
      //
      // Ordering: the checks above are about *this escrow* — is it funded, are
      // its conditions satisfied. This one is about *this install* — can it
      // reach a chain and sign at all. An officer who has an unmet condition
      // should hear about the condition, not about a credential; the missing
      // chain config is already surfaced as a persistent banner on this screen
      // from the moment the escrow is funded, so it is never a surprise here.
      //
      // Re-read rather than trusting the cached flag: the vault can lock
      // between the screen rendering and the officer clicking, and a disabled
      // button is a hint, not a control. This is the control.
      await get().refreshBlockchainConfig();
      if (!get().blockchainReady) {
        set({
          error:
            "Blockchain is not configured — set the network, contract and deployer key in Configuration before settling.",
        });
        return;
      }

      await get().proceedToExecution();
    },

    // ── eSign lifecycle (spec §22 Stage 4, §23) ─────────────────────────────

    /**
     * Send the loaded document for signature. Persists the envelope, records
     * `esign_sent` on the audit chain, and starts the poll loop.
     */
    sendForSignature: async (documentLabel, signers, subject, message) => {
      const { file, sessionId } = get();
      if (!sessionId) {
        set({ error: "No active session — load a document first." });
        return;
      }
      if (!file) {
        set({ error: "No document loaded to send for signature." });
        return;
      }
      if (signers.length === 0) {
        set({ error: "Add at least one signer before sending for signature." });
        return;
      }

      set({ busy: true, error: null });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const provider = await resolveESignProvider();
        const envelopeId = await provider.sendEnvelope(
          sessionId,
          bytes,
          documentLabel,
          signers,
          subject,
          message,
        );

        await backend.saveDocusignEnvelope({
          envelopeId,
          sessionId,
          documentLabel,
          signersJson: JSON.stringify(signers),
        });

        const envelope: ESignEnvelope = {
          envelopeId,
          sessionId,
          documentLabel,
          signers,
          status: "sent",
          sentAt: new Date().toISOString(),
        };
        set((s) => ({ eSignEnvelopes: [...s.eSignEnvelopes, envelope], busy: false }));

        await log("esign_sent", {
          envelope_id: envelopeId,
          provider: provider.providerName(),
          document_label: documentLabel,
          signers: signers.map((sg) => ({ name: sg.name, email: sg.email, role: sg.role })),
        });

        get().startESignPolling();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Send for signature failed: ${message}`, busy: false });
      }
    },

    /**
     * Raise an envelope for in-app signing by one internal party (spec §22).
     *
     * Differs from `sendForSignature` in exactly one respect that matters: the
     * signer carries a `clientUserId`, which makes them embedded. DocuSign then
     * sends no email and the ceremony is reachable only through a recipient
     * view URL — which is what the returned target lets the panel request.
     *
     * The envelope is otherwise ordinary. It is persisted, polled and completed
     * by the same code as an email envelope, so an in-app signature ends up
     * with the same certificate, the same AnchorReceipt registration and the
     * same AnchorMatcher verdict. Nothing downstream needs to know which route
     * collected it.
     */
    signInApp: async (documentLabel, signer) => {
      const { file, sessionId, operator } = get();
      if (!sessionId) {
        set({ error: "No active session — load a document first." });
        return null;
      }
      if (!file) {
        set({ error: "No document loaded to sign." });
        return null;
      }

      set({ busy: true, error: null });
      try {
        const clientUserId = embeddedClientUserId(operator, signer.email);
        const embeddedSigner: ESignSigner = { ...signer, clientUserId };
        const bytes = new Uint8Array(await file.arrayBuffer());
        const provider = await resolveESignProvider();

        // Subject and message are still sent: DocuSign requires a subject on
        // every envelope, and this one surfaces in the account's envelope list
        // and audit history even though no email is dispatched.
        const envelopeId = await provider.sendEnvelope(
          sessionId,
          bytes,
          documentLabel,
          [embeddedSigner],
          `Signature required — ${documentLabel}`,
          `In-app signature by ${signer.name} (${signer.role}).`,
        );

        await backend.saveDocusignEnvelope({
          envelopeId,
          sessionId,
          documentLabel,
          signersJson: JSON.stringify([embeddedSigner]),
        });

        const envelope: ESignEnvelope = {
          envelopeId,
          sessionId,
          documentLabel,
          signers: [embeddedSigner],
          status: "sent",
          sentAt: new Date().toISOString(),
          embeddedSigning: true,
          embeddedSignerName: signer.name,
        };
        set((s) => ({ eSignEnvelopes: [...s.eSignEnvelopes, envelope], busy: false }));

        await log("esign_embedded_opened", {
          envelope_id: envelopeId,
          provider: provider.providerName(),
          document_label: documentLabel,
          signer: { name: signer.name, email: signer.email, role: signer.role },
          client_user_id: clientUserId,
          officer_identity: operator,
        });

        // Polling continues alongside the callback. The redirect is the fast
        // path, not the only one: if the signer closes the window before it
        // fires, the 30-second poll still catches the completion.
        get().startESignPolling();

        return { envelopeId, clientUserId, signer: embeddedSigner };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `In-app signing failed: ${message}`, busy: false });
        return null;
      }
    },

    /**
     * The in-app ceremony reported a signature. Runs the identical completion
     * pipeline as an email signature — certificate → ArtifactGuard hash →
     * AnchorReceipt registration → AnchorMatcher.
     */
    completeEmbeddedSigning: async (envelopeId, event) => {
      await log("esign_embedded_completed", { envelope_id: envelopeId, event });
      await get().handleESignCompletion(envelopeId);
    },

    /**
     * The ceremony ended without a signature. The envelope is deliberately left
     * in flight rather than voided: a cancelled ceremony is an abandoned
     * attempt, not a refusal to sign, and the officer can reopen it or send the
     * document by email instead. Polling keeps tracking it either way.
     */
    cancelEmbeddedSigning: async (envelopeId) => {
      await log("esign_embedded_cancelled", {
        envelope_id: envelopeId,
        officer_identity: get().operator,
      });
    },

    /** Begin (or continue) the 30-second poll. Idempotent. */
    startESignPolling: () => {
      if (get().eSignPollTimer) return;
      const timer = setInterval(() => {
        void get().pollAllEnvelopes();
      }, ESIGN_POLL_INTERVAL_MS);
      set({ eSignPolling: true, eSignPollTimer: timer });
    },

    stopESignPolling: () => {
      const timer = get().eSignPollTimer;
      if (timer) clearInterval(timer);
      set({ eSignPolling: false, eSignPollTimer: null });
    },

    /**
     * One poll round across every non-terminal envelope. Status changes are
     * audited; a transition to `completed` runs the completion pipeline. When
     * nothing is left in flight the interval stops — there is nothing to watch.
     */
    pollAllEnvelopes: async () => {
      const pending = get().eSignEnvelopes.filter((e) => !isTerminal(e.status));
      if (pending.length === 0) {
        get().stopESignPolling();
        return;
      }

      const provider = await resolveESignProvider();
      for (const envelope of pending) {
        let status: ESignStatus;
        try {
          status = await provider.pollStatus(envelope.envelopeId);
        } catch (e) {
          // A transient poll failure is not a status change — keep watching.
          console.error("esign poll failed", envelope.envelopeId, e);
          continue;
        }
        if (status === envelope.status) continue;

        set((s) => ({
          eSignEnvelopes: s.eSignEnvelopes.map((e) =>
            e.envelopeId === envelope.envelopeId ? { ...e, status } : e,
          ),
        }));
        await log("esign_status_update", {
          envelope_id: envelope.envelopeId,
          from: envelope.status,
          to: status,
        });

        if (status === "completed") {
          // Persists COMPLETED itself, along with the certificate hash and tx.
          await get().handleESignCompletion(envelope.envelopeId);
        } else {
          await backend.updateDocusignEnvelope({
            envelopeId: envelope.envelopeId,
            status: status.toUpperCase(),
          });
        }
      }

      if (get().eSignEnvelopes.every((e) => isTerminal(e.status))) {
        get().stopESignPolling();
      }
    },

    /**
     * Completion pipeline (spec §23). The certificate of completion is hashed
     * by ArtifactGuard, that hash is registered on-chain by AnchorReceipt, and
     * AnchorMatcher checks the signer identities against the Stage 1 trust
     * anchors. A failed anchor match does **not** block the record — it is
     * persisted as `anchorMatch: false` and surfaced for human review, which is
     * the spec's escalation posture.
     */
    handleESignCompletion: async (envelopeId) => {
      const { eSignEnvelopes, anchors, rawAnchors } = get();
      const envelope = eSignEnvelopes.find((e) => e.envelopeId === envelopeId);
      if (!envelope) return;

      try {
        const provider = await resolveESignProvider();
        const certificate = await provider.getCertificate(envelopeId);
        const certificateHash = await backend.hashBytes(
          certificate,
          `esign-certificate-${envelopeId}.pdf`,
        );

        // AnchorReceipt on-chain registration — mocked in this build, real CRE
        // Functions call in V2 (same stand-in as CannaVerify's tx hashes).
        const onChainTx = `0xanchor-esign-${envelopeId.slice(-8)}`;
        const anchorMatch = signersMatchAnchors(envelope.signers, anchors, rawAnchors);
        const completedAt = new Date().toISOString();

        set((s) => ({
          eSignEnvelopes: s.eSignEnvelopes.map((e) =>
            e.envelopeId === envelopeId
              ? { ...e, status: "completed", certificateHash, onChainTx, anchorMatch, completedAt }
              : e,
          ),
        }));

        await backend.updateDocusignEnvelope({
          envelopeId,
          status: "COMPLETED",
          completedAt,
          certificateHash,
          onChainTx,
          anchorMatch: anchorMatch ? 1 : 0,
        });

        await log("esign_completed", {
          envelope_id: envelopeId,
          certificate_hash: certificateHash,
          on_chain_tx: onChainTx,
          anchor_match: anchorMatch,
          signers: envelope.signers.map((s) => s.name),
        });

        // Condition engine: the signature condition is fulfilled only when every
        // envelope has completed *and* every anchor match passed.
        const all = get().eSignEnvelopes;
        const fulfilled =
          all.length > 0 && all.every((e) => e.status === "completed" && e.anchorMatch === true);
        await log("esign_conditions_evaluated", {
          envelopes: all.length,
          completed: all.filter((e) => e.status === "completed").length,
          signature_condition_fulfilled: fulfilled,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Signature completion pipeline failed: ${message}` });
        await log("esign_completion_failed", { envelope_id: envelopeId, error: message });
      }
    },

    proceedToExecution: async () => {
      const { file, artifact, payload, sessionId, reviewOpenedAt, anchors } = get();
      if (!file || !artifact || !payload || !sessionId) return;
      set({ busy: true, error: null });

      // Final blocking re-verify — the race-condition fix.
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await backend.finalVerifyBeforeExecution(artifact.filename, bytes);
      } catch (e) {
        const reason =
          typeof e === "object" && e && "reason" in e ? String((e as { reason: unknown }).reason) : String(e);
        set({
          error: `${reason}. The document changed since it was reviewed — reload and re-acknowledge before proceeding.`,
          busy: false,
          acknowledged: false,
        });
        return;
      }

      if (reviewOpenedAt) {
        await log("review_time_on_screen", { duration_ms: Date.now() - reviewOpenedAt, scroll_completed: true });
      }

      const path = payload.recommendedPath;
      await backend.setExecutionPath(sessionId, path);
      await backend.updateSessionState(sessionId, "APPROVED");
      // The human authorization moment — the officer has re-acknowledged and
      // the artifact re-verified, so this is where liability transfers.
      await notifyIntegrations("review.approved");

      // ── Path B — ArbitrationEscrow (spec §6) ─────────────────────────────
      // Lock the escrow and stop. Nothing settles until the multi-sig
      // threshold is met, so there is no phase progression to run here.
      if (path === ExecutionPath.ArbitrationEscrow) {
        set({
          screen: "execution",
          releasePathChosen: true,
          execution: { ...get().execution, phase: "idle", path },
        });
        const arbitrationState = await releasePaths.initArbitration(sessionId, payload);
        set({
          arbitrationState,
          execution: { ...get().execution, path, txHash: arbitrationState.lockTxHash ?? null },
          busy: false,
        });
        return;
      }

      // ── Path C — StagedRelease (spec §6) ─────────────────────────────────
      // The milestone schedule does not exist yet; the officer defines it on
      // the execution screen and `initStagedRelease` takes over from there.
      if (path === ExecutionPath.StagedRelease) {
        set({
          screen: "execution",
          releasePathChosen: true,
          stagedReleaseState: null,
          execution: { ...get().execution, phase: "idle", path },
        });
        await log("staged_release_awaiting_definition", {
          workflow_id: sessionId,
          execution_path: path,
        });
        set({ busy: false });
        return;
      }

      // ── Path A — DirectSettlement (unchanged) ────────────────────────────
      set({
        screen: "execution",
        releasePathChosen: true,
        execution: { ...get().execution, phase: "verifying", path },
      });
      await log("cre_execution_started", { workflow_id: sessionId, execution_path: path });
      await sleep(700);

      // CRE execution (simulated end-to-end for a self-contained build).
      const cents = toPayloadCents(payload);
      const clientCents = path === ExecutionPath.DirectSettlement ? cents.unearnedBalanceCents : cents.totalHeldCents;
      const firmCents = path === ExecutionPath.DirectSettlement ? cents.earnedFeesCents : 0n;
      const txHash = ("0x" + artifact.hash.replace("sha256:", "").slice(0, 64)) as string;

      set({ execution: { ...get().execution, phase: "converting", clientCents, firmCents, txHash, path } });
      await sleep(700);
      set({ execution: { ...get().execution, phase: "settling", clientCents, firmCents, txHash, path } });
      await sleep(900);

      await backend.updateSessionState(sessionId, "EXECUTED");
      await log("cre_execution_completed", {
        workflow_id: sessionId,
        execution_path: path,
        client_amount_usdc: Number(clientCents) / 100,
        firm_amount_usdc: Number(firmCents) / 100,
        tx_hash: txHash,
        client_wallet: payload.clientWallet,
        firm_wallet: payload.lawFirmWallet,
      });
      await log("settlement_on_chain", { document_hash: artifact.hash, tx_hash: txHash });

      // Client notification (post-settlement only).
      set({ execution: { ...get().execution, phase: "notifying", clientCents, firmCents, txHash, path } });
      const notifications = await sendNotifications(anchors, clientCents, txHash, log);

      set({ execution: { phase: "done", path, txHash, clientCents, firmCents, notifications } });
      set({ busy: false });
      await notifyIntegrations("settlement.complete");
    },

    // ── Path B — Arbitration signatures (spec §6) ───────────────────────────

    /**
     * Cast one party's signature. When the threshold is reached the escrow
     * releases and the client notification fires — the same post-settlement
     * treatment Path A gets, because from the client's side the money moved.
     */
    signArbitration: async (signer, notes) => {
      const { sessionId, payload, anchors } = get();
      if (!sessionId || !payload) return;

      set({ busy: true, error: null });
      try {
        const { resolved, txHash } = await releasePaths.signArbitrationRelease(sessionId, signer, notes);
        const arbitrationState = await releasePaths.getArbitrationState(sessionId);
        set({ arbitrationState, busy: false });

        if (!resolved) return;

        // Threshold met — the full locked balance is released.
        const clientCents = toPayloadCents(payload).totalHeldCents;
        set({
          execution: { ...get().execution, phase: "notifying", txHash: txHash ?? null, clientCents },
        });
        const notifications = await sendNotifications(anchors, clientCents, txHash ?? "", log);
        set({
          execution: { ...get().execution, phase: "done", txHash: txHash ?? null, clientCents, notifications },
          busy: false,
        });
        // Path B settles too — from the client's side the money moved, so the
        // same event fires as for Path A rather than the integration silently
        // seeing nothing for two of the three release paths.
        await notifyIntegrations("settlement.complete");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Arbitration signature failed: ${message}`, busy: false });
      }
    },

    // ── Path C — Staged release (spec §6) ───────────────────────────────────

    /**
     * Commit the milestone schedule. `staged.ts` rejects a schedule whose
     * amounts do not exactly exhaust the escrow total, so the error surfaces
     * here rather than stranding funds.
     */
    initStagedRelease: async (milestones) => {
      const { sessionId, payload } = get();
      if (!sessionId || !payload) return;

      set({ busy: true, error: null });
      try {
        const totalCents = toPayloadCents(payload).totalHeldCents;
        const stagedReleaseState = await releasePaths.initStagedRelease(sessionId, milestones, totalCents);
        set({
          stagedReleaseState,
          execution: { ...get().execution, txHash: releasePaths.stagedDepositTx(sessionId) },
          busy: false,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: message, busy: false });
      }
    },

    submitEvidence: async (milestoneId, file) => {
      const { sessionId } = get();
      if (!sessionId) return;
      set({ busy: true, error: null });
      try {
        await releasePaths.submitMilestoneEvidence(sessionId, milestoneId, file);
        set({ stagedReleaseState: await releasePaths.getStagedReleaseState(sessionId), busy: false });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Evidence submission failed: ${message}`, busy: false });
      }
    },

    approveMilestone: async (milestoneId) => {
      const { sessionId, operator } = get();
      if (!sessionId) return;
      set({ busy: true, error: null });
      try {
        await releasePaths.approveMilestone(sessionId, milestoneId, operator);
        set({ stagedReleaseState: await releasePaths.getStagedReleaseState(sessionId), busy: false });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Milestone approval failed: ${message}`, busy: false });
      }
    },

    /**
     * Release one milestone's funds. `recipientAddress` defaults to the
     * client wallet on the payload — the officer can override it per stage.
     * The client notification fires only on the final release, when the whole
     * escrow has been paid out.
     */
    releaseMilestone: async (milestoneId, recipientAddress) => {
      const { sessionId, payload, operator, anchors } = get();
      if (!sessionId || !payload) return;

      set({ busy: true, error: null });
      try {
        const recipient = recipientAddress?.trim() || payload.clientWallet;
        const milestone = await releasePaths.releaseMilestone(sessionId, milestoneId, recipient, operator);
        const stagedReleaseState = await releasePaths.getStagedReleaseState(sessionId);
        set({ stagedReleaseState, busy: false });

        const complete = stagedReleaseState !== null && stagedReleaseState.remainingCents === 0n;
        if (!complete) return;

        const txHash = milestone.txHash ?? null;
        const clientCents = stagedReleaseState.releasedCents;
        set({ execution: { ...get().execution, phase: "notifying", txHash, clientCents } });
        const notifications = await sendNotifications(anchors, clientCents, txHash ?? "", log);
        set({
          execution: { ...get().execution, phase: "done", txHash, clientCents, notifications },
          busy: false,
        });
        // Fires on the final release only — `complete` above gates this — so a
        // three-stage schedule notifies once, not once per milestone.
        await notifyIntegrations("settlement.complete");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Milestone release failed: ${message}`, busy: false });
      }
    },

    resolveEscalation: async (choice) => {
      const { escalation, payload, sessionId } = get();
      if (!escalation || !payload || !sessionId) return;
      await log("lexguard_escalation", {
        module: escalation.module,
        field: escalation.field,
        aiValue: escalation.aiValue,
        observedValue: escalation.observedValue,
        user_decision: choice,
        user: get().operator,
      });

      if (choice === "review") {
        set({ screen: "load" });
        return;
      }

      // Adopt the chosen value for a numeric escalation, then proceed to review.
      const next = { ...payload };
      if (escalation.field === "unearnedBalance") {
        const raw = choice === "lexguard" ? escalation.observedValue : escalation.aiValue;
        const parsed = parseFloat(String(raw).replace(/[$,\s]/g, ""));
        if (Number.isFinite(parsed)) next.unearnedBalance = parsed;
      }
      set({ payload: next, escalation: null, screen: "review", reviewOpenedAt: Date.now(), scrollCompleted: false, acknowledged: false });
      await backend.updateSessionState(sessionId, "PARSING");
      await log("review_screen_opened", { after_escalation: true });
    },

    /**
     * Escalation-dialog entry point (spec §29). The officer has restated every
     * discrepant field and attested to it; `applyHumanCorrections` carries out
     * the write, the audit records and the re-validation.
     *
     * `resolveEscalation` above is deliberately left intact — the batch store
     * still routes its flagged items through the original three-choice flow.
     */
    resolveEscalationWithCorrections: async (corrections) => {
      await get().applyHumanCorrections(corrections);
    },

    /**
     * Write the officer's corrections into the payload, log HUMAN_CORRECTION
     * per field, then re-run the full pipeline against the corrected payload.
     *
     * Re-validation uses `manualProvider`, not the AI provider: the officer's
     * value is authoritative, so LexGuard must not nudge it back to the model
     * that just failed three times on the same field. A discrepancy that
     * survives the corrected payload therefore escalates again rather than
     * being auto-corrected — spec §29's "if new discrepancy, new escalation
     * dialog fires; original correction preserved".
     */
    applyHumanCorrections: async (corrections) => {
      const { escalation, payload, vdb, sessionId, anchors, entryMode } = get();
      if (!payload || !sessionId) return;

      set({ busy: true, error: null });
      const findings = escalation ? escalationFindings(escalation) : [];
      const next: ParsedRetainerPayload = { ...payload };
      const writable = next as unknown as Record<string, number | string>;

      for (const correction of corrections) {
        const finding = findings.find((f) => f.field === correction.field);
        // `correctionField` names the payload field a finding writes to —
        // absent for findings that are attested to rather than restated (a
        // scope violation, a suppressed anomaly), which are logged but never
        // written back.
        const target = finding?.correctionField;
        if (target) {
          writable[target] = correction.value;
        } else if (correction.field in writable) {
          writable[correction.field] = correction.value;
        }

        await logHumanCorrection(
          {
            field: correction.field,
            module: finding?.module ?? "payload-diff",
            aiValue: finding?.aiValue ?? "—",
            observedValue: finding?.observedValue ?? "—",
            aiAttempt1: finding?.aiAttempt1,
            aiAttempt2: finding?.aiAttempt2,
            aiAttempt3: finding?.aiAttempt3,
            constraint: constraintFor(finding?.module ?? "payload-diff", correction.field),
          },
          correction.value,
        );
      }

      set({ payload: next, escalation: null });
      await backend.updateSessionState(sessionId, "PARSING");

      if (!vdb) {
        // No VDB to re-validate against (a hydrated batch item, say) — the
        // corrections still stand; send the officer to review.
        set({
          screen: "review",
          reviewOpenedAt: Date.now(),
          scrollCompleted: false,
          acknowledged: false,
          busy: false,
        });
        await log("review_screen_opened", { after_human_correction: true });
        return;
      }

      await runPipelineAndRoute(next, vdb, sessionId, anchors, manualProvider, entryMode);
    },

    /**
     * Stage 4 override of a LexGuard correction (spec §30).
     *
     * The scroll/acknowledge gate resets so the officer re-reviews the payload
     * they just changed, and LexGuard re-runs on the overridden value — an
     * override does not disable validation, it just replaces one input to it.
     */
    applyHumanOverride: async ({ field, overrideValue, reason }) => {
      const { payload, corrections, vdb, sessionId, anchors, entryMode } = get();
      if (!payload || !sessionId) return;

      // The value LexGuard landed on is the last resolved correction for the
      // field; if none is recorded, the current payload value is what the
      // officer is overriding.
      const applied = [...corrections].reverse().find((c) => c.field === field && c.resolved);
      const current = (payload as unknown as Record<string, number | string>)[field];
      const lexGuardValue = applied?.observedValue ?? current;

      const next: ParsedRetainerPayload = { ...payload };
      const writable = next as unknown as Record<string, number | string>;
      if (field in writable) writable[field] = overrideValue;

      set({ payload: next, scrollCompleted: false, acknowledged: false, error: null });
      await logHumanOverride(field, applied?.module ?? "payload-diff", lexGuardValue, overrideValue, reason);

      if (!vdb) return;
      await runPipelineAndRoute(next, vdb, sessionId, anchors, manualProvider, entryMode);
    },

    buildAuditReport: async () => {
      const { sessionId, anchors, artifact, payload, providerLabel } = get();
      if (!sessionId) return "{}";
      const trail = await backend.getAuditTrail(sessionId);
      const chain = await backend.verifyAuditChain();
      return JSON.stringify(
        {
          session_id: sessionId,
          generated_at: new Date().toISOString(),
          client: anchors.clientFullLegalName,
          attorney_bar_number: anchors.attorneyBarNumber,
          document_hash: artifact?.hash ?? null,
          ai_provider: providerLabel,
          recommended_path: payload?.recommendedPath ?? null,
          chain_verification: chain,
          audit_trail: trail,
        },
        null,
        2,
      );
    },

    /**
     * Printable audit report (spec §14 V1).
     *
     * Sits alongside `buildAuditReport`, which produces the machine-readable
     * JSON, rather than replacing it: the JSON is for systems that re-verify
     * the chain, the PDF is for the humans and counterparties who need to read
     * what happened. Neither substitutes for the other.
     */
    downloadAuditReport: async () => {
      const { sessionId } = get();
      if (!sessionId) return;
      try {
        await downloadAuditReportPdf(sessionId, useSession);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Audit report export failed: ${message}` });
      }
    },
  };
});

// ── Notifications (Rust SMTP/Twilio backend, or browser simulation) ──────────

async function sendNotifications(
  anchors: TrustAnchors,
  clientCents: bigint,
  txHash: string,
  log: (event: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<NotificationStatus[]> {
  const out: NotificationStatus[] = [];

  const email = await backend.sendClientNotification({
    channel: "email",
    to: anchors.clientEmail,
    clientName: anchors.clientFullLegalName,
    amountCents: Number(clientCents),
    reference: txHash,
  });
  out.push(email);
  await log("client_notification_sent", {
    channel: "email",
    delivery_status: email.status,
    amount_usdc: Number(clientCents) / 100,
    ref: txHash,
  });

  if (anchors.clientPhone && anchors.clientPhone.trim()) {
    const sms = await backend.sendClientNotification({
      channel: "sms",
      to: anchors.clientPhone,
      clientName: anchors.clientFullLegalName,
      amountCents: Number(clientCents),
      reference: txHash,
    });
    out.push(sms);
    await log("client_notification_sent", {
      channel: "sms",
      delivery_status: sms.status,
      amount_usdc: Number(clientCents) / 100,
      ref: txHash,
    });
  }

  return out;
}

/**
 * Bind the native File-menu items to session actions (spec §12 Screen 9).
 *
 * The menu lives in Rust and cannot reach the store directly, so each custom
 * item emits an event that is translated into an action here. Returns a
 * disposer rather than binding for the process lifetime: React StrictMode runs
 * effects twice in development, and a second live listener would toggle
 * `openRecent` straight back to where it started — the menu item would appear
 * to do nothing at all.
 *
 * Outside Tauri there is no menu to listen to. `npm run dev` in a plain browser
 * and the test runner both take that path, and the event API is imported
 * dynamically behind that guard so neither pulls it into the bundle they load
 * (the same reason `EmbeddedSigningPanel` imports it this way).
 */
export async function initMenuListeners(): Promise<() => void> {
  if (!backend.isTauri()) return () => {};

  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await Promise.all([
    listen("menu:new_transaction", () => useSession.getState().reset()),
    listen("menu:recent_workflows", () => useSession.getState().openRecent()),
    listen("menu:setup_wizard", () => useSession.getState().openWizard()),
  ]);
  return () => unlisten.forEach((off) => off());
}
