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
import { resolveESignProvider, isTerminal } from "../lib/esign";
import type { ESignEnvelope, ESignSigner, ESignStatus } from "../lib/esign";
import { normalizeName } from "../lexguard/anchor-matcher";
import * as releasePaths from "../lib/releasePaths";
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
  | "execution"
  | "escalation"
  | "config"
  | "batch";
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

const emptyAnchors: TrustAnchors = {
  attorneyBarNumber: "",
  state: "California",
  clientFullLegalName: "",
  clientEmail: "",
  clientPhone: "",
};

function stepsFor(mode: EntryMode): ProcessingStep[] {
  return [
    { key: "hash", label: "Hashing artifacts", status: "pending" },
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

interface SessionState {
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
  returnToBatch: () => void;
  loadBatchItem: (h: BatchHydration) => void;
  reset: () => void;
  goToProcessing: () => void;
  beginProcessing: () => Promise<void>;
  submitManualEntry: (fields: ManualEntryFields) => Promise<void>;
  markScrollCompleted: () => void;
  setAcknowledged: (v: boolean) => Promise<void>;
  navigateToConditions: () => void;
  sendForSignature: (
    documentLabel: string,
    signers: ESignSigner[],
    subject: string,
    message: string,
  ) => Promise<void>;
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

    setAnchor: (patch) => set((s) => ({ anchors: { ...s.anchors, ...patch } })),
    setRawAnchors: (raw) => set({ rawAnchors: raw }),
    setFile: (file) => set({ file }),
    setEntryMode: (mode) => set({ entryMode: mode }),
    setAssetClass: (cls) => set({ assetClass: cls }),
    openConfig: () =>
      set((s) => ({ prevScreen: s.screen === "config" ? s.prevScreen : s.screen, screen: "config" })),
    closeConfig: () => set((s) => ({ screen: s.prevScreen })),
    openBatch: () => set({ screen: "batch" }),
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
      const timer = get().eSignPollTimer;
      if (timer) clearInterval(timer);
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
          clientId: "pending",
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

        // 2) Verify attorney (simulated CA State Bar check) — both modes.
        setStep("bar", "active");
        const active = /^\d{5,8}$/.test(anchors.attorneyBarNumber.trim()) && anchors.state === "California";
        set({ barActive: active });
        await log("bar_verification_result", {
          active,
          source: "ca-state-bar (simulated)",
          bar_last4: anchors.attorneyBarNumber.slice(-4),
        });
        if (!active) {
          setStep("bar", "error");
          set({
            error:
              "Attorney bar number could not be verified as active with the California State Bar. Processing halted.",
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

    navigateToConditions: () => set({ screen: "conditions" }),

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
