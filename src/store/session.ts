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
import { auditValueFor, constraintFor, escalationFindings, type AnomalyDisposition } from "../lib/corrections";
import { ExecutionPath, type ParsedRetainerPayload, type TrustAnchors } from "../lexguard/types";
import { primeVDB, setNumericAnchor, type VDBStore } from "../lexguard/vdb";
import { toPayloadCents } from "../lexguard/payload-diff";
import { runCannaVerify as runCannaVerifyAdapters } from "../lib/cannaverify";
import type { CannaVerifyConditions } from "../lib/cannaverify/types";
import { verifyBar, BAR_VERIFY_SOURCE, type BarVerifyResult } from "../lib/adapters";
import {
  resolveESignProvider,
  isTerminal,
  embeddedClientUserId,
  describeRecipientViewError,
  isEmbeddedSigner,
} from "../lib/esign";
import type {
  EmbeddedSigningTarget,
  ESignEnvelope,
  ESignRecipientStatus,
  ESignSigner,
  ESignStatus,
} from "../lib/esign";
import { normalizeName } from "../lexguard/anchor-matcher";
import * as releasePaths from "../lib/releasePaths";
import { downloadReceipt, issueReceipt, type AnchorReceipt } from "../lib/anchor-receipt";
import { fireIntegrationWebhooks } from "../lib/integrations";
import { setExplorerChain } from "../lib/explorer";
import {
  clioIntakeIdentifier,
  clioUserMessage,
  clioVdbText,
  type ClioMatterPayload,
  type IntakeSource,
} from "../lib/clio";
// Toast owns its own tiny store and imports nothing from here, so this is a
// leaf dependency rather than a cycle back into the session.
import { toast } from "../components/Toast";
import type { BlockchainPublic, StoreBackend, UnlockResult } from "../lib/vaultTypes";
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
  /**
   * `anomaliesSuppressed` only: the officer's per-anomaly dispositions. Each is
   * logged as its own HUMAN_CORRECTION entry, and reaching `applyHumanCorrections`
   * with these means every anomaly was Acknowledged (a Blocking disposition
   * routes through `escalateAnomaliesFurther` instead).
   */
  dispositions?: AnomalyDisposition[];
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
/**
 * LexTrace panel position. One click — or Cmd/Ctrl+Shift+D — advances it, and
 * 2 wraps back to 0.
 *
 *  * `0` closed
 *  * `1` docked bottom, 280px (the VSCode terminal position)
 *  * `2` split right, 420px (the VSCode side-panel position)
 *
 * A number rather than a string union because the cycle *is* arithmetic: the
 * three states are ordered, and `(n + 1) % 3` is the whole transition table.
 */
export type DebugPanelState = 0 | 1 | 2;

/**
 * Three ways a step can fail to be green, and they are not interchangeable.
 *
 *   * `error`    — something the officer submitted did not hold up. Red, and
 *                  it halts the run.
 *   * `warning`  — a check that should have run did not get an answer. Amber:
 *                  the run continues, but someone has to finish the check by
 *                  hand.
 *   * `advisory` — a check this install cannot run at all, because it is not
 *                  configured or nothing covers this jurisdiction. Neutral
 *                  grey: nothing is wrong with the transaction, and painting
 *                  a blank config field red says that something is.
 *
 * All three leave the underlying condition unmet, so none of them lets a
 * release through. They differ only in what the officer is told.
 */
export type StepStatus = "pending" | "active" | "done" | "error" | "warning" | "advisory";
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
 * DEMO FALLBACK — replace with real party wallet input in V2.
 *
 * Extraction defaults an absent wallet to the zero address (`ZERO_ADDR` above,
 * and the same default on `parsedRetainerSchema`), and Clio intake carries no
 * wallet at all — so a document that never spelled one out reaches settlement
 * with `address(0)` for a recipient. `RetainerRelease.directSettle` rejects
 * that with `ZeroAddress()` before it transfers any USDC, which surfaces as a
 * revert at the last step of the run. Until the officer can enter the real
 * party wallets (see V2 note at the settlement call site), an unset recipient
 * falls back to the deployer wallet so the demo settles end to end.
 */
const DEMO_FALLBACK_WALLET = "0x0b370090317443afFa8124Af45b7C2FeB5a01810";

/** The wallet as extracted, or the demo fallback when nothing usable is set. */
function settlementRecipient(wallet: string | null | undefined): string {
  const w = wallet?.trim();
  if (!w || w.toLowerCase() === ZERO_ADDR) return DEMO_FALLBACK_WALLET;
  return w;
}

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
//
// The first two labels change with the intake source, because on the Clio path
// the two steps genuinely do something else. Nothing is hashed — there are no
// bytes — so step one derives the deterministic `clio:` identifier instead, and
// step two records which matter the session names rather than sealing an
// AnchorReceipt over a document (`beginProcessing` skips the receipt entirely).
// A progress list that said "Hashing artifacts" over a Clio matter would be
// telling the officer something untrue about what the session holds.
function stepsFor(mode: EntryMode, source: IntakeSource = "artifact"): ProcessingStep[] {
  const fromClio = source === "clio";
  return [
    {
      key: "hash",
      label: fromClio ? "Generating session identifier" : "Hashing artifacts",
      status: "pending",
    },
    {
      key: "anchor",
      label: fromClio ? "Registering matter reference" : "Registering with AnchorReceipt",
      status: "pending",
    },
    { key: "bar", label: "Verifying attorney", status: "pending" },
    { key: "ai", label: mode === "manual" ? "Manual entry" : "AI parsing", status: "pending" },
    { key: "lexguard", label: "LexGuard validating", status: "pending" },
  ];
}

function initialSteps(source: IntakeSource = "artifact"): ProcessingStep[] {
  return stepsFor("ai", source);
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
          creAdapterUrl: BAR_VERIFY_SOURCE,
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
  /**
   * Which intake path this session came in through.
   *
   * `artifact` is the Artifact Loader — a file, hashed and fingerprinted.
   * `clio` is a matter pulled read-only from Clio Manage. Everything after the
   * parse is identical; the branch exists because one has a document to hash
   * and the other does not.
   */
  intakeSource: IntakeSource;
  /**
   * The matter this session was built from, on the Clio path.
   *
   * **Held in memory only.** Clio's ToS §10(e) forbids persisting matter data
   * beyond session scope, so this lives here for the length of one escrow
   * transaction and is written to nothing — not SQLite, not the audit trail,
   * not the AnchorReceipt. `reset()` drops it with the rest of the session.
   */
  clioMatter: ClioMatterPayload | null;
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
  /**
   * In-app signing targets from the envelope that carries them, keyed by
   * lowercased signer email.
   *
   * Populated by `sendForSignature`, which is now the only thing that raises an
   * envelope. `signInApp` reads it rather than creating a second envelope —
   * that separation is what puts both parties on one document.
   */
  embeddedTargets: Map<string, EmbeddedSigningTarget>;
  /** Per-recipient routing state per envelope id, refreshed by the poll. */
  recipientStatuses: Record<string, ESignRecipientStatus[]>;

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

  // ── CRE Confidential Workflow (spec §13) ─────────────────────────────────
  /**
   * The DON's execution ID for this session's enclave run, once the gateway
   * has accepted one. Null when the trigger has not fired or was rejected —
   * the trigger is not a gate, so null is an ordinary state that says nothing
   * about whether settlement succeeded.
   */
  creExecutionId: string | null;

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

  // ── Credential store ─────────────────────────────────────────────────────
  /**
   * Which backend holds this install's credentials, or null on first launch.
   *
   * Null gates `CredentialStoreSelector`. It is deliberately not defaulted to a
   * backend: the whole point of the selector is that the choice is the
   * operator's, and guessing would silently commit them to one.
   */
  storeBackend: StoreBackend | null;
  /** Has the backend been read yet? Distinguishes "not configured" from "not
   *  asked yet", so the selector cannot flash before the answer arrives. */
  storeBackendChecked: boolean;

  // ── Vault lock (App Vault backend only) ──────────────────────────────────
  /**
   * Is a configured vault sitting sealed?
   *
   * No longer a launch gate. The app opens straight into the workflow and the
   * password is asked for at the moment a credential is actually needed —
   * which is how every password manager behaves, and which means an operator
   * who only wants to fingerprint a document never sees a prompt at all.
   *
   * Under the OS-keychain backend this is permanently false: the login session
   * already unlocked the store, so there is nothing to ask for.
   */
  vaultLocked: boolean;
  /** Is the lazy unlock prompt on screen? Raised by `ensureCredentials`. */
  credentialPromptOpen: boolean;

  // ── LexTrace debug console ───────────────────────────────────────────────
  /** Where the debug panel is, if anywhere. */
  debugPanel: DebugPanelState;
  /**
   * Has the operator passed the debug password gate this app session?
   *
   * Session-scoped rather than persisted, and deliberately: the gate exists so
   * that opening the panel is a decision somebody made, and a remembered answer
   * on the next launch would make it a decision nobody made.
   */
  debugAuthenticated: boolean;
  /** Is the debug password prompt on screen? */
  debugPromptOpen: boolean;
  /** The IT operator's name, for the panel header. Empty until authenticated. */
  debugOperatorId: string;

  // actions
  setAnchor: (patch: Partial<TrustAnchors>) => void;
  setRawAnchors: (raw: Record<string, string>) => void;
  runCannaVerify: () => Promise<void>;
  setFile: (file: File | null) => void;
  setEntryMode: (mode: EntryMode) => void;
  /** Switch intake paths. Clears whichever input the other path was holding. */
  setIntakeSource: (source: IntakeSource) => void;
  /** Hold a fetched Clio matter, or drop it when the officer picks another. */
  setClioMatter: (payload: ClioMatterPayload | null) => void;
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
  /** Read which credential backend is active. Runs at mount, ahead of the
   *  selector gate. */
  checkStoreBackend: () => Promise<void>;
  /** Record a backend selection made by the selector or by Configuration. */
  setStoreBackendLocal: (backend: StoreBackend) => void;
  /**
   * Ensure credentials are readable, prompting for the vault password if not.
   *
   * The lazy gate. Resolves true when the active store can be read and false
   * when the operator dismissed the prompt. Every credential-consuming action
   * awaits this first, so the password is asked for once, at the moment it is
   * needed, rather than at launch.
   */
  ensureCredentials: () => Promise<boolean>;
  /** Close the lazy unlock prompt, resolving whatever is awaiting it. */
  resolveCredentialPrompt: (ok: boolean) => void;
  /** Open the vault. Returns the backend's verdict verbatim so the caller can
   *  show *why* an unlock failed. */
  unlockVault: (password: string) => Promise<UnlockResult>;
  /** Seal the vault. */
  lockVault: () => Promise<void>;
  /**
   * Advance the debug panel one position: closed → bottom → right → closed.
   *
   * Opening from closed is the only transition with anything in front of it —
   * the vault has to be readable, the console has to be configured, and the
   * password has to have been given once this session. The two later
   * transitions are pure repositioning and are never gated again.
   */
  cycleDebugPanel: () => Promise<void>;
  /** Close the panel outright, whichever position it is in. */
  closeDebugPanel: () => void;
  /** Answer the debug password prompt. Resolves false on a wrong password. */
  submitDebugPassword: (password: string) => Promise<boolean>;
  /** Dismiss the debug password prompt without opening the panel. */
  cancelDebugPrompt: () => void;
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
  /**
   * Raise the one envelope carrying every signer, and return the in-app
   * signing targets it created, keyed by lowercased signer email. Email
   * signers produce no entry.
   */
  sendForSignature: (
    documentLabel: string,
    signers: ESignSigner[],
    subject: string,
    message: string,
  ) => Promise<Map<string, EmbeddedSigningTarget>>;
  /** Open the in-app ceremony for a signer already on the envelope (spec §22). */
  signInApp: (signer: ESignSigner) => Promise<EmbeddedSigningTarget | null>;
  /** Refresh per-recipient routing state for every envelope still in flight. */
  refreshRecipientStatuses: () => Promise<void>;
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
  /** Route a blocking-anomaly escalation to arbitration instead of settling. */
  escalateAnomaliesFurther: (dispositions: AnomalyDisposition[]) => Promise<void>;
  applyHumanOverride: (override: HumanOverrideInput) => Promise<void>;
  buildAuditReport: () => Promise<string>;
  /** Printable audit report (spec §14 V1) — opens the browser print dialog. */
  downloadAuditReport: () => Promise<void>;
}

function stepStatus(steps: ProcessingStep[], key: string, status: StepStatus): ProcessingStep[] {
  return steps.map((s) => (s.key === key ? { ...s, status } : s));
}

/**
 * Resolver for the in-flight `ensureCredentials` promise.
 *
 * Module-level rather than store state: it is a continuation, not something
 * anything renders from, and putting a function in the store would make every
 * subscriber re-render when a prompt opens.
 */
let pendingUnlock: ((ok: boolean) => void) | null = null;

/**
 * Trim, drop blanks, de-duplicate — the shape the CRE enclave's anchor check
 * wants. It compares extracted parties and identifiers against these sets, so
 * an empty string or a repeat is noise that can only widen what matches.
 */
function uniqueNonEmpty(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
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
      if (!configs.practicePanther) return;
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
   * HUMAN_CORRECTION for one anomaly disposition (spec §32).
   *
   * The `anomaliesSuppressed` finding is not a value the officer restates — each
   * flagged anomaly is dispositioned Acknowledged or Blocking, and each
   * disposition is its own audit entry carrying the anomaly's description and the
   * officer's choice. The description stands in for a field value, so the
   * money-in-cents conversion the field logger applies does not apply here.
   */
  const logAnomalyDisposition = async (description: string, disposition: string) => {
    await log("HUMAN_CORRECTION", {
      field: "anomaliesSuppressed",
      lexguard_module: "anomaly-watcher",
      constraint: constraintFor("anomaly-watcher", "anomaliesSuppressed"),
      anomaly_description: description,
      officer_corrected_value: disposition,
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
    intakeSource: "artifact",
    clioMatter: null,
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
    embeddedTargets: new Map(),
    recipientStatuses: {},
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
    creExecutionId: null,
    blockchain: null,
    blockchainReady: false,
    showWizard: false,
    wizardComplete: false,
    storeBackend: null,
    storeBackendChecked: false,
    // Starts down. Under the lazy-unlock flow nothing gates on this at launch —
    // it is read at the moment a credential is needed, and `ensureCredentials`
    // re-reads the live status rather than trusting this flag.
    vaultLocked: false,
    credentialPromptOpen: false,
    debugPanel: 0,
    debugAuthenticated: false,
    debugPromptOpen: false,
    debugOperatorId: "",

    setAnchor: (patch) => set((s) => ({ anchors: { ...s.anchors, ...patch } })),
    setRawAnchors: (raw) => set({ rawAnchors: raw }),
    setFile: (file) => set({ file }),
    setEntryMode: (mode) => set({ entryMode: mode }),

    // Switching paths clears the other one's input. Leaving a stale file behind
    // a Clio selection — or the reverse — is how `beginProcessing` would end up
    // hashing a document the officer thought they had replaced.
    setIntakeSource: (source) =>
      set(source === "clio" ? { intakeSource: source, file: null } : { intakeSource: source, clioMatter: null }),
    setClioMatter: (payload) => set({ clioMatter: payload }),
    setAssetClass: (cls) => set({ assetClass: cls }),
    openConfig: () =>
      set((s) => {
        if (s.screen === "config") {
          // Navigate back — but if prevScreen is also "config" (a prior open
          // that never recorded a real origin), fall back to "load" so the
          // toggle can't loop or stall on the same screen.
          return { screen: s.prevScreen !== "config" ? s.prevScreen : "load" };
        }
        return { prevScreen: s.screen, screen: "config" };
      }),
    closeConfig: () => set((s) => ({ screen: s.prevScreen })),
    openBatch: () =>
      set((s) => {
        if (s.screen === "batch") {
          return { screen: s.prevScreen !== "batch" ? s.prevScreen : "load" };
        }
        return { prevScreen: s.screen, screen: "batch" };
      }),

    /** Screen 8 — standalone fingerprinting, outside any escrow workflow.
     *  Remembers where the officer came from so closing returns them there. */
    openAnchorReceiptConsole: () =>
      set((s) => {
        if (s.screen === "anchor-receipt") {
          return { screen: s.prevScreen !== "anchor-receipt" ? s.prevScreen : "load" };
        }
        return { prevScreen: s.screen, screen: "anchor-receipt" };
      }),

    /** Screen 9 — the session history, reached from the File menu (Cmd+R).
     *  Toggles, so the same menu item that opens it closes it again. */
    openRecent: () =>
      set((s) => {
        if (s.screen === "recent") {
          return { screen: s.prevScreen !== "recent" ? s.prevScreen : "load" };
        }
        return { prevScreen: s.screen, screen: "recent" };
      }),

    /**
     * First-run detection (spec §12 Screen 0) and the launch lock gate.
     *
     * One call because one vault status answers both, and asking twice invites
     * the two answers to disagree. The vault's existence *is* first-run: every
     * credential the wizard collects lives in the vault, so "no vault" and
     * "this install has never been set up" are the same condition — and unlike
     * a stored flag, it survives a cleared browser profile and cannot claim an
     * install is configured when its credentials are gone.
     *
     * Whether the vault is *open* no longer gates anything at launch. It is
     * recorded so the lazy prompt knows whether it will need to ask, but the
     * app renders either way — an operator who only wants to fingerprint a
     * document never touches a credential and is never asked for a password.
     *
     * A failure here is not fatal, and fails open in both directions: an
     * unreadable vault status is a reason to leave the operator in the app, not
     * to trap them behind an onboarding flow whose first step would fail for
     * the same reason, nor behind a password prompt for a vault we cannot
     * confirm exists. Every credential read stays independently guarded — a
     * locked vault yields nothing regardless of what this flag says.
     */
    checkWizard: async () => {
      try {
        // Under the OS-keychain backend the vault file is irrelevant to
        // first-run: credentials live in the keychain, so an install with no
        // vault may still be fully configured. Asking the store settles it.
        if (get().storeBackend === "os_keychain") {
          const pub = await backend.vaultGetPublic().catch(() => null);
          const configured = Boolean(pub?.ai ?? pub?.smtp ?? pub?.twilio);
          set({
            showWizard: !configured,
            wizardComplete: configured,
            vaultLocked: false,
          });
          return;
        }
        const status = await backend.vaultStatus();
        if (status.exists) {
          set({
            showWizard: false,
            wizardComplete: true,
            vaultLocked: !status.unlocked,
          });
        } else {
          set({ showWizard: true, vaultLocked: false });
        }
      } catch (e) {
        console.error("vault status check failed", e);
      }
    },

    openWizard: () => set({ showWizard: true }),

    checkStoreBackend: async () => {
      try {
        const active = await backend.getStoreBackend();
        set({ storeBackend: active, storeBackendChecked: true });
      } catch (e) {
        // A failed read is not a reason to re-run the selection flow — that
        // would risk an operator re-picking a backend while their credentials
        // sit in the other one. Mark it checked and leave the backend null;
        // every credential read stays independently guarded.
        console.error("credential store backend check failed", e);
        set({ storeBackendChecked: true });
      }
    },

    setStoreBackendLocal: (b) => set({ storeBackend: b, storeBackendChecked: true }),

    /**
     * The lazy gate.
     *
     * Re-reads the live vault status rather than trusting `vaultLocked`: the
     * vault can be sealed from Configuration between one action and the next,
     * and a stale flag here would let a workflow step run against credentials
     * that have just gone away.
     */
    ensureCredentials: async () => {
      if (get().storeBackend === "os_keychain") return true;
      try {
        const status = await backend.vaultStatus();
        if (status.unlocked) return true;
        // No vault file means there is nothing sealed to open. Prompting here
        // would ask an operator to invent a password for a vault that does not
        // exist yet — vault *creation* belongs to the setup wizard, and the
        // action they actually clicked should proceed and report whatever
        // credential it finds missing.
        if (!status.exists) return true;
      } catch {
        // Can't tell — ask. A prompt the operator can dismiss is a better
        // failure than a workflow step that silently resolves no credentials.
      }
      set({ credentialPromptOpen: true, vaultLocked: true });
      return new Promise<boolean>((resolve) => {
        pendingUnlock = resolve;
      });
    },

    resolveCredentialPrompt: (ok) => {
      set({ credentialPromptOpen: false });
      // Resolver cleared before calling, so a handler that synchronously
      // triggers another prompt cannot resolve this one twice.
      const resolve = pendingUnlock;
      pendingUnlock = null;
      resolve?.(ok);
    },

    unlockVault: async (password) => {
      const result = await backend.vaultUnlock(password);
      if (!result.ok) return result;

      set({ vaultLocked: false });
      // Release whatever action was waiting on the prompt.
      get().resolveCredentialPrompt(true);
      // The blockchain config read as "not configured" for as long as the vault
      // was sealed, and the settle gate reads it from the store rather than
      // asking the vault each time. Re-read now that there is something to
      // read, so unlocking does not leave a configured install looking unable
      // to settle until something else happens to refresh it.
      await get().refreshBlockchainConfig();
      return result;
    },

    lockVault: async () => {
      await backend.vaultLock();
      set({
        vaultLocked: true,
        // Sealing the vault takes the debug console with it. The credentials
        // the panel's gate checked, and the ones its polling reads on every
        // request, both live in the vault that has just closed — leaving an
        // authenticated panel open would poll a store it can no longer read and
        // fill the terminal with failures. The spec's "for the remainder of the
        // app session" is about not re-prompting on every cycle, not about
        // outliving an explicit lock.
        debugPanel: 0,
        debugAuthenticated: false,
        debugPromptOpen: false,
        debugOperatorId: "",
      });
      // Drops the cached public view with it — leaving settlement config on
      // screen after the vault that backs it is sealed would misreport what
      // this install can currently do.
      await get().refreshBlockchainConfig();
    },

    // ── LexTrace debug console ────────────────────────────────────────────

    cycleDebugPanel: async () => {
      const { debugPanel, debugAuthenticated } = get();

      // Already open: reposition, then close. Nothing is re-checked — the
      // operator has been through the gate and is now moving a window.
      if (debugPanel !== 0) {
        set({ debugPanel: debugPanel === 1 ? 2 : 0 });
        return;
      }

      // Opening. The credentials live in the vault, so a sealed vault has to be
      // opened first or `hasDebugConsole` would answer "not configured" for an
      // install that is configured — and send the operator to a Settings screen
      // where they would find the console already set up.
      if (!(await get().ensureCredentials())) return;

      if (!(await backend.hasDebugConsole())) {
        toast("Debug console requires IT setup. Configure in Settings.");
        return;
      }

      if (!debugAuthenticated) {
        set({ debugPromptOpen: true });
        return;
      }
      set({ debugPanel: 1 });
    },

    closeDebugPanel: () => set({ debugPanel: 0 }),

    submitDebugPassword: async (password) => {
      if (!(await backend.authenticateDebugConsole(password))) return false;
      // The operator name is read only now, on the far side of the gate. It is
      // not a secret, but the header has no business showing it to somebody who
      // has not been let in.
      let operatorId = "";
      try {
        operatorId = (await backend.getDebugConsolePublic()).operatorId;
      } catch {
        // A name the panel cannot read is a cosmetic loss, not a failed unlock.
      }
      set({
        debugAuthenticated: true,
        debugPromptOpen: false,
        debugPanel: 1,
        debugOperatorId: operatorId,
      });
      return true;
    },

    cancelDebugPrompt: () => set({ debugPromptOpen: false }),

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
        // Dropped with the rest of the session: ToS §10(e) scopes Clio matter
        // data to the transaction it was fetched for.
        clioMatter: null,
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
        embeddedTargets: new Map(),
        recipientStatuses: {},
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
        creExecutionId: null,
      });
    },

    // DocumentLoad → Processing screen, showing the entry-mode toggle before
    // anything runs.
    goToProcessing: () => {
      const { file, intakeSource, clioMatter } = get();
      // Two intakes, two different things to be missing. Clio intake has no
      // document by construction — the matter record *is* the intake, and the
      // session identifier is derived from it rather than from a file's bytes —
      // so demanding a retainer upload here asked the officer for something the
      // path never produces. The same fork `beginProcessing` makes one screen
      // later; this is the gate in front of it.
      const fromClio = intakeSource === "clio";
      if (fromClio ? !clioMatter : !file) {
        set({
          error: fromClio
            ? "Select a Clio matter before continuing."
            : "Please add a retainer document before continuing.",
        });
        return;
      }
      set({
        screen: "processing",
        procPhase: "choose",
        steps: initialSteps(intakeSource),
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
      const { file, anchors, entryMode, assetClass, intakeSource, clioMatter } = get();
      const fromClio = intakeSource === "clio";
      if (fromClio ? !clioMatter : !file) {
        set({
          error: fromClio
            ? "Select a Clio matter before continuing."
            : "Please add a retainer document before continuing.",
        });
        return;
      }
      // The lazy gate. Asked here rather than at launch because this is the
      // first step that actually needs a credential — the AI provider key —
      // and it is also where the AnchorReceipt seal key is first touched.
      if (!(await get().ensureCredentials())) {
        set({ error: "Credentials are locked — unlock to run the parse." });
        return;
      }
      const sessionId = newId("wf");
      set({
        sessionId,
        procPhase: "running",
        steps: stepsFor(entryMode, intakeSource),
        error: null,
        configHint: null,
        busy: true,
      });

      try {
        // 1) Establish the session's source-of-record identifier.
        //
        // Two paths, one column. The Artifact Loader hashes real bytes; Clio
        // intake has no artifact to hash — the input is a JSON record pulled
        // from an API, not a file anyone can hand over — so it derives a
        // deterministic identifier from the matter, the fetch time and the
        // OAuth client instead. It carries a `clio:` prefix rather than
        // `sha256:` precisely so nothing downstream mistakes it for evidence
        // about a document's contents.
        setStep("hash", "active");
        let sourceHash: string;
        let sourceText: string;
        let artifact: backend.LoadedArtifact | null = null;

        if (fromClio && clioMatter) {
          sourceHash = await clioIntakeIdentifier(
            clioMatter.matterId,
            clioMatter.fetchedAt,
            (await backend.getClioPublic()).clientId,
          );
          sourceText = clioVdbText(clioMatter);
        } else {
          const bytes = new Uint8Array(await file!.arrayBuffer());
          artifact = await backend.loadArtifact(file!.name, bytes);
          set({ artifact });
          sourceHash = artifact.hash;
          sourceText = artifact.normalizedText;
        }

        await backend.createSession({
          sessionId,
          // The anchored party, not the parsed `clientId`. Trust anchors are
          // authoritative and known now, whereas the payload's client id
          // arrives several steps later — and Recent Workflows lists sessions
          // that never got that far, which used to leave every row reading
          // "pending" in the one column an officer scans by.
          clientId: anchors.clientFullLegalName.trim() || "Unidentified party",
          attorneyBarNumber: anchors.attorneyBarNumber,
          documentHash: sourceHash,
          assetClass,
        });

        // The audit trail records *that* the session came from Clio and which
        // matter it names — LexEscrow's own derived data. It records none of
        // the matter's contents: no client details, no bills, no balances.
        // That distinction is ToS §10(e), and it is why this payload lists
        // fields rather than spreading the Clio record into it.
        if (fromClio && clioMatter) {
          await log("document_loaded", {
            intake_source: "clio",
            matter_id: clioMatter.matterId,
            matter_reference: clioMatter.displayNumber,
            source_hash: sourceHash,
          });
        } else if (artifact) {
          await log("document_loaded", {
            intake_source: "artifact",
            filename: artifact.filename,
            hash: artifact.hash,
            size: artifact.size,
          });
        }
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
        //
        // Skipped entirely on the Clio path. An AnchorReceipt is a provenance
        // claim about a *document* — "these exact bytes existed, sealed, at
        // this time" — and TrueTitle registration puts that fingerprint
        // on-chain. A Clio matter has no bytes to make that claim about, and
        // minting a receipt over a JSON snapshot would assert a provenance
        // nobody can later verify against anything.
        if (!fromClio && artifact) {
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
            // The commonest cause is a locked vault — the seal key is
            // per-install and lives there, so a locked vault means this install
            // cannot currently attest anything. Surface the backend's reason on
            // the step itself rather than the fatal-error banner: processing
            // genuinely continues, and the officer needs to know *what to do*,
            // not just that a light went red.
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
        } else {
          // Marked done rather than left pending: nothing is outstanding, and a
          // step stuck on "active" reads as a stall.
          setStep("anchor", "done");
        }

        // 2) Verify attorney standing via the BarVerify adapter — both modes.
        //
        // Replaces the format check this step used to do. A regex over the bar
        // number proves the number is *shaped* like a bar number; it cannot
        // tell an active attorney from a suspended one, which is the only
        // question that matters before releasing a retainer.
        setStep("bar", "active");
        const barResult = await verifyBar(anchors.attorneyBarNumber, anchors.state);
        const active = barResult.status === "active";
        // "unavailable" is not a verdict about the attorney — the registry was
        // never reached, so nothing about their standing is known either way.
        // `barActive` stays null rather than false for that reason: false is a
        // claim ("not in good standing") this session is in no position to
        // make, and it would put a `failureReason` saying so onto the
        // condition. Null leaves the bar condition `pending`, which blocks the
        // release just as hard — `allMet` counts only met and waived — while
        // saying the true thing, that the check still has to be done by hand.
        // Three more statuses join `unavailable` in saying nothing about the
        // attorney. `not_configured` and `unsupported_state` are facts about
        // this install and this jurisdiction; `not_found` is the registry
        // answering that it holds no such record, which is a finding but not a
        // standing verdict. All four leave `barActive` null rather than false:
        // false is a claim ("not in good standing") the session is in no
        // position to make, and it would write a `failureReason` saying so onto
        // the condition. Null leaves the bar condition `pending`, which blocks
        // the release just as hard — `allMet` counts only met and waived —
        // while saying the true thing.
        const inconclusive =
          barResult.status === "unavailable" ||
          barResult.status === "not_configured" ||
          barResult.status === "unsupported_state" ||
          barResult.status === "not_found";
        set({ barActive: inconclusive ? null : active, barVerifyResult: barResult });
        await log("bar_verification_result", {
          active,
          status: barResult.status,
          state: barResult.state,
          verified: active,
          license_status: barResult.detail,
          has_public_discipline: barResult.hasPublicDiscipline ?? false,
          source: BAR_VERIFY_SOURCE,
          detail: barResult.detail,
          attorney_name: barResult.attorneyName ?? null,
          admission_date: barResult.admissionDate ?? null,
          firm_name: barResult.firmName ?? null,
          // The number itself stays out of the audit payload — the last four
          // are enough to correlate an entry without recording the identifier.
          bar_last4: anchors.attorneyBarNumber.slice(-4),
        });
        if (!active && !inconclusive) {
          setStep("bar", "error");
          set({
            // The adapter's own detail, not a generic message: "scaffold",
            // "unrecognized status" and "suspended" call for three different
            // actions from the officer, and only one of them is the attorney's
            // problem. (An unreachable registry no longer lands here at all —
            // it is `unavailable`, handled below.)
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

        if (inconclusive) {
          // The AnchorReceipt shape from step 1b: the step goes red with the
          // reason on it, and processing continues. Halting here would cost the
          // officer the parse and every validation after it over a network
          // fault that says nothing about the transaction — and they would have
          // to re-run the whole session once the adapter answered again. What
          // the release actually depends on is the bar *condition*, which stays
          // unmet until someone verifies standing another way.
          // `advisory` rather than `error`: none of these three is the
          // attorney's problem, and painting a missing API token red on the
          // Processing screen tells the officer a transaction is wrong when the
          // only thing wrong is a blank field in Configuration. Red stays
          // reserved for configured-but-failed.
          // Grey for the two capability gaps, amber for the registry that did
          // not answer. Only the amber one is a check that should have run and
          // now needs a human; the other two are facts about configuration.
          const [status, label]: [StepStatus, string] =
            barResult.status === "not_configured"
              ? ["advisory", "Bar verification not configured — add Apify token in Configuration"]
              : barResult.status === "unsupported_state"
                ? ["advisory", barResult.detail]
                : barResult.status === "not_found"
                  // The router's own wording: "no record in the registry" and
                  // "no bar number was provided" both land here, and they are
                  // different things to hand an officer.
                  ? ["warning", barResult.detail]
                  : ["warning", "Attorney verification unavailable — manual review required"];
          set((s) => ({
            steps: s.steps.map((step) => (step.key === "bar" ? { ...step, status, label } : step)),
          }));
        } else {
          setStep("bar", "done");
        }

        // 3) Prime the VDB from the source (both modes validate against it).
        //
        // On the Clio path the source is a dollar-denominated projection of the
        // matter rather than the JSON the AI reads. The VDB scans for dollar
        // figures and their field labels; handing it raw JSON would feed it
        // `3000000` beside `trustBalanceCents` and make every co-validation
        // compare dollars against cents. See `clioVdbText`.
        await backend.updateSessionState(sessionId, "PARSING");
        const vdb = await primeVDB(sourceText, sourceHash, sessionId);
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
          // The one difference the intake source makes to the parser: which
          // system prompt is used, and whether the user message is document
          // text or the matter's JSON. The output contract and every downstream
          // validation are identical.
          parsed = await provider.parse(
            fromClio && clioMatter ? clioUserMessage(clioMatter) : sourceText,
            schemaFor(assetClass),
            intakeSource,
          );
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
          lawFirmName: parsed.lawFirmName ?? "",
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
      // Skips the AI provider but still seals an AnchorReceipt, and the seal
      // key lives in the same store.
      if (!(await get().ensureCredentials())) {
        set({ error: "Credentials are locked — unlock to record this entry." });
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
        intakeSource,
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
          intakeSource,
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
        intakeSource,
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
          intakeSource,
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

      // The deployer key is read Rust-side during settlement; a sealed vault
      // there fails mid-flight, after the operator has already confirmed.
      if (!(await get().ensureCredentials())) {
        set({ error: "Credentials are locked — unlock to settle." });
        return;
      }

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
     * Send the loaded document for signature — every signer, one envelope.
     *
     * Email and in-app parties ride the same envelope so that DocuSign can
     * sequence them: the email signers hold routing order 1, the in-app
     * signers order 2, and the certificate of completion at the end covers
     * every signature rather than one per party. The in-app parties are marked
     * embedded here, by minting their `clientUserId` *before* creation —
     * DocuSign matches a recipient view on that exact value, so it cannot be
     * decided later.
     *
     * Returns the in-app targets keyed by lowercased signer email, which is
     * what `signInApp` later opens the ceremony against.
     */
    sendForSignature: async (documentLabel, signers, subject, message) => {
      const empty = new Map<string, EmbeddedSigningTarget>();
      const { file, sessionId, operator } = get();
      if (!sessionId) {
        set({ error: "No active session — load a document first." });
        return empty;
      }
      if (!(await get().ensureCredentials())) {
        set({ error: "Credentials are locked — unlock to send for signature." });
        return empty;
      }
      if (!file) {
        set({ error: "No document loaded to send for signature." });
        return empty;
      }
      if (signers.length === 0) {
        set({ error: "Add at least one signer before sending for signature." });
        return empty;
      }

      set({ busy: true, error: null });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const provider = await resolveESignProvider();

        // An in-app party becomes an embedded recipient by carrying a
        // clientUserId; an email party must not have one, since its absence is
        // what makes DocuSign deliver their email. One envelope, both kinds.
        const recipients: ESignSigner[] = signers.map((sg) =>
          sg.mode === "in_app"
            ? { ...sg, clientUserId: embeddedClientUserId(operator, sg.email) }
            : sg,
        );

        // Diagnostic: confirm exactly what reaches DocuSign — the recipient
        // addresses actually being sent (not a stale parsed value or a synthetic
        // in-app id) and whether this is the real API or the demo/mock provider.
        const providerLabel = provider.providerName();
        console.log(
          `[esign] sendForSignature → provider: ${providerLabel} — ${
            providerLabel.includes("demo") ? "DEMO/MOCK (no real email is sent)" : "REAL DocuSign API"
          }`,
        );
        console.log(
          "[esign] recipients:",
          recipients.map((s) => ({
            name: s.name,
            email: s.email,
            routingOrder: s.routingOrder,
            clientUserId: s.clientUserId ?? null,
          })),
        );

        const envelopeId = await provider.sendEnvelope(
          sessionId,
          bytes,
          documentLabel,
          recipients,
          subject,
          message,
        );

        await backend.saveDocusignEnvelope({
          envelopeId,
          sessionId,
          documentLabel,
          signersJson: JSON.stringify(recipients),
        });

        const envelope: ESignEnvelope = {
          envelopeId,
          sessionId,
          documentLabel,
          signers: recipients,
          status: "sent",
          sentAt: new Date().toISOString(),
        };

        const targets = new Map<string, EmbeddedSigningTarget>();
        for (const sg of recipients) {
          if (!isEmbeddedSigner(sg)) continue;
          targets.set(sg.email.trim().toLowerCase(), {
            envelopeId,
            clientUserId: sg.clientUserId as string,
            signer: sg,
          });
        }

        set((s) => ({
          eSignEnvelopes: [...s.eSignEnvelopes, envelope],
          embeddedTargets: new Map([...s.embeddedTargets, ...targets]),
          busy: false,
        }));

        await log("esign_sent", {
          envelope_id: envelopeId,
          provider: provider.providerName(),
          document_label: documentLabel,
          signers: recipients.map((sg) => ({
            name: sg.name,
            email: sg.email,
            role: sg.role,
            routing_order: sg.routingOrder,
            embedded: isEmbeddedSigner(sg),
          })),
        });

        get().startESignPolling();
        // Seed the routing state so the in-app control is gated correctly from
        // the moment the envelope exists, rather than after the first tick.
        void get().refreshRecipientStatuses();
        return targets;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Send for signature failed: ${message}`, busy: false });
        return empty;
      }
    },

    /**
     * Open the in-app ceremony for a signer already on the envelope (spec §22).
     *
     * Raises nothing. The signer was placed on the single envelope by
     * `sendForSignature`, already carrying the `clientUserId` that makes them
     * embedded, so all that remains is to mint their recipient view — which is
     * also the check that they are actually reachable: DocuSign refuses one
     * for a signer whose routing turn has not arrived, and that refusal is the
     * authoritative answer regardless of what the polled status said a moment
     * ago.
     *
     * The minted URL is deliberately discarded. It is single-use and expires
     * in minutes, so the panel mints its own when the ceremony window opens;
     * this call exists to fail *before* the panel is shown rather than inside
     * it, where the officer would meet a raw DocuSign error mid-ceremony.
     */
    signInApp: async (signer) => {
      const key = signer.email.trim().toLowerCase();
      const target = get().embeddedTargets.get(key);
      if (!target) {
        set({
          error:
            "This party is not on a signature envelope yet — send the document for signature first.",
        });
        return null;
      }

      set({ busy: true, error: null });
      try {
        const provider = await resolveESignProvider();
        if (!provider.getEmbeddedSigningUrl) {
          set({
            error: `${provider.providerName()} does not support in-app signing — send this document by email instead.`,
            busy: false,
          });
          return null;
        }

        await provider.getEmbeddedSigningUrl(
          target.envelopeId,
          target.signer.email,
          target.signer.name,
          target.clientUserId,
        );

        await log("esign_embedded_opened", {
          envelope_id: target.envelopeId,
          provider: provider.providerName(),
          signer: { name: signer.name, email: signer.email, role: signer.role },
          client_user_id: target.clientUserId,
          officer_identity: get().operator,
        });

        set({ busy: false });
        return target;
      } catch (e) {
        // An out-of-sequence recipient is an expected state of a correctly
        // built envelope, not a fault — it is translated, not surfaced raw.
        set({ error: describeRecipientViewError(e), busy: false });
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

    /**
     * Refresh per-recipient routing state for every envelope still in flight.
     *
     * Separate from `pollAllEnvelopes` because it answers a different question:
     * the envelope-level status says the envelope is `sent`, which is equally
     * true when the client has it and when the firm's in-app signer has it.
     * Only this tells the two apart, and that difference is what enables or
     * disables "Sign Here".
     *
     * A provider that cannot sequence recipients simply records nothing, which
     * leaves in-app signing ungated — the same behaviour as before sequencing
     * existed, rather than a control stuck disabled forever.
     */
    refreshRecipientStatuses: async () => {
      const pending = get().eSignEnvelopes.filter((e) => !isTerminal(e.status));
      if (pending.length === 0) return;

      const provider = await resolveESignProvider();
      if (!provider.listRecipients) return;

      for (const envelope of pending) {
        try {
          const recipients = await provider.listRecipients(envelope.envelopeId);
          set((st) => ({
            recipientStatuses: { ...st.recipientStatuses, [envelope.envelopeId]: recipients },
          }));
        } catch (e) {
          // A transient read failure is not a routing change — keep the last
          // known state rather than falsely locking or unlocking the control.
          console.error("esign recipient list failed", envelope.envelopeId, e);
        }
      }
    },

    /** Begin (or continue) the 30-second poll. Idempotent. */
    startESignPolling: () => {
      if (get().eSignPollTimer) return;
      const timer = setInterval(() => {
        void get().pollAllEnvelopes();
        void get().refreshRecipientStatuses();
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

      // ── Path A — DirectSettlement ────────────────────────────────────────
      set({
        screen: "execution",
        releasePathChosen: true,
        execution: { ...get().execution, phase: "verifying", path },
      });
      await log("cre_execution_started", { workflow_id: sessionId, execution_path: path });
      await sleep(700);

      const cents = toPayloadCents(payload);
      const clientCents = path === ExecutionPath.DirectSettlement ? cents.unearnedBalanceCents : cents.totalHeldCents;
      const firmCents = path === ExecutionPath.DirectSettlement ? cents.earnedFeesCents : 0n;

      set({ execution: { ...get().execution, phase: "converting", clientCents, firmCents, txHash: null, path } });
      await sleep(700);
      set({ execution: { ...get().execution, phase: "settling", clientCents, firmCents, txHash: null, path } });

      // ── CRE Confidential Workflow — fire and observe ─────────────────────
      // The deployed workflow validates this escrow and computes an HMAC seal
      // inside a TEE enclave, then crosses the result to the DON. It settles
      // nothing and authorises nothing, which is exactly why it is not a gate:
      // making it one would hand an unreachable gateway a veto over money
      // movement it plays no part in. A rejection is logged and the settlement
      // below runs regardless.
      try {
        const cre = await backend.triggerCreWorkflow({
          session_id: sessionId,
          asset_class: get().assetClass,
          total_held_cents: Number(cents.totalHeldCents),
          release_path: path,
          // The enclave re-extracts the terms from the document itself and
          // reconciles them against the anchors the officer entered at
          // Document Load — that cross-check is the whole point of the run, so
          // a payload without these two fields is rejected by its schema
          // rather than validated leniently.
          document_text: artifact.normalizedText,
          trust_anchors: {
            parties: uniqueNonEmpty([
              anchors.clientFullLegalName,
              payload.clientName,
              payload.attorneyName,
            ]),
            identifiers: uniqueNonEmpty([
              anchors.attorneyBarNumber,
              payload.barNumber,
              payload.extractedBarNumber,
            ]),
          },
        });
        set({ creExecutionId: cre.executionId });
        await log("cre_workflow_triggered", {
          workflow_id: sessionId,
          execution_id: cre.executionId,
          cre_workflow_id: cre.workflowId,
          status: cre.status,
          execution_path: path,
        });
        // The enclave's actual verdict — `validated`, `lexguardScore`, and the
        // `hmacSeal` computed over them — is NOT read back here, and currently
        // cannot be. The trigger is async-accept: it returns a
        // `workflow_execution_id` immediately, before the ~30s run has produced
        // anything, so the handler's return value is never in the response.
        // Nothing exposes it afterwards either — `cre execution status` and
        // `events` carry run metadata only, and `logs` carries whatever
        // `runtime.log()` emitted, which is deliberately nothing now that the
        // enclave's debug line is gone.
        //
        // The seal in particular exists only inside the DON report's ABI
        // payload, which becomes readable once a receiver contract consumes it
        // via `writeReport`. RetainerRelease cannot be that receiver: its
        // `_processReport` decodes the older `cre/main.ts` tuple, not this
        // workflow's. Surfacing the verdict therefore needs a new receiver
        // contract and a deploy — a V2 item, and not something to approximate
        // here, because a fabricated verdict is worse than a missing one.
        //
        // What is recorded is that the enclave ran, keyed by execution ID, so
        // the run stays auditable and can be reconciled against the DON later.
        await log("cre_enclave_verdict_pending", { execution_id: cre.executionId });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await log("cre_workflow_trigger_failed", {
          workflow_id: sessionId,
          execution_path: path,
          error: message,
        });
      }

      // Real on-chain settlement: the backend signs a `directSettle` call with
      // the vault-held deployer key, broadcasts it, and waits for the receipt.
      // The hash below is real by construction — on any failure the workflow
      // stops here and says so. Nothing is ever fabricated to look settled.
      let txHash: string;
      // DEMO FALLBACK — replace with real party wallet input in V2. Resolved
      // once, above the try, so the completion log below records the wallets
      // the money actually moved to rather than the unset payload fields.
      const clientWallet = settlementRecipient(payload.clientWallet);
      const firmWallet = settlementRecipient(payload.lawFirmWallet);
      try {
        const settled = await backend.executeDirectSettle({
          clientWallet,
          firmWallet,
          // USD cents → USDC base units (6 decimals): 1¢ = 10,000 units.
          // Exact integer math in bigint; crosses IPC as a decimal string.
          clientAmountUsdc: (clientCents * 10_000n).toString(),
          firmAmountUsdc: (firmCents * 10_000n).toString(),
          documentHash: artifact.hash,
        });
        txHash = settled.txHash;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await log("cre_execution_failed", {
          workflow_id: sessionId,
          execution_path: path,
          error: message,
        });
        // Back to the Escrow Monitor, which owns persistent error display and
        // the retry affordance. The session state is NOT advanced to EXECUTED
        // and no notification fires — the money did not move.
        set({
          screen: "escrow-monitor",
          error: `On-chain settlement failed — nothing was released. ${message}`,
          busy: false,
          execution: { ...get().execution, phase: "idle", clientCents, firmCents, txHash: null, path },
        });
        return;
      }

      set({ execution: { ...get().execution, phase: "settling", clientCents, firmCents, txHash, path } });

      await backend.updateSessionState(sessionId, "EXECUTED");
      await log("cre_execution_completed", {
        workflow_id: sessionId,
        execution_path: path,
        client_amount_usdc: Number(clientCents) / 100,
        firm_amount_usdc: Number(firmCents) / 100,
        tx_hash: txHash,
        client_wallet: clientWallet,
        firm_wallet: firmWallet,
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
      // The officer's numeric values are written back to the VDB so re-validation
      // compares against the human-confirmed figure, not the original extraction.
      // Without this a poisoned anchor (e.g. "$14" pulled from "fourteen (14)
      // days") never matches the corrected value and the field re-escalates
      // forever.
      let nextVdb = vdb;

      // Acknowledging anomalies only *removes* a finding — unlike a restated
      // value, it cannot introduce a new discrepancy. So a submission that is
      // purely anomaly dispositions must navigate forward unconditionally rather
      // than re-run the pipeline: a re-run can re-escalate, which remounts the
      // escalation view and resets the attestation checkbox (spec §31 bug).
      // Value corrections still re-validate below, so a bad value re-escalates
      // (spec §29) — that path is unchanged.
      const onlyAnomalyDispositions =
        corrections.length > 0 && corrections.every((c) => c.dispositions !== undefined);

      for (const correction of corrections) {
        const finding = findings.find((f) => f.field === correction.field);

        // anomaliesSuppressed: log each disposition on its own, then clear the
        // flagged anomalies so the now-dispositioned finding does not re-trigger
        // anomaly-watcher on re-validation. Reaching here means every anomaly was
        // Acknowledged — a Blocking disposition goes through
        // `escalateAnomaliesFurther`, never this path.
        if (correction.dispositions) {
          for (const d of correction.dispositions) {
            await logAnomalyDisposition(d.description, d.disposition);
          }
          next.anomaliesFlagged = [];
          next.anomaliesSuppressed = false;
          continue;
        }

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

        // Write the human-confirmed value back to the VDB anchor for the field.
        const anchorField = target ?? correction.field;
        if (nextVdb && typeof correction.value === "number") {
          nextVdb = setNumericAnchor(nextVdb, anchorField, correction.value);
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

      set({ payload: next, escalation: null, ...(nextVdb !== vdb && { vdb: nextVdb }) });
      await backend.updateSessionState(sessionId, "PARSING");

      // Navigate forward without re-running the pipeline when either there is
      // nothing to re-validate against (a hydrated batch item with no VDB) or
      // the corrections were purely anomaly acknowledgments (which cannot create
      // a new discrepancy). This is the unconditional forward navigation that
      // keeps the escalation view from re-mounting and resetting attestation.
      if (onlyAnomalyDispositions || !nextVdb) {
        set({
          screen: "review",
          reviewOpenedAt: Date.now(),
          scrollCompleted: false,
          acknowledged: false,
          busy: false,
        });
        await log("review_screen_opened", {
          after_human_correction: true,
          anomaly_dispositioned: onlyAnomalyDispositions,
        });
        return;
      }

      await runPipelineAndRoute(next, nextVdb, sessionId, anchors, manualProvider, entryMode);
    },

    /**
     * Blocking-anomaly path (spec §31). At least one flagged anomaly was
     * dispositioned Blocking, so the escrow must not proceed to direct
     * settlement. Every disposition is logged, the payload is routed to
     * arbitration, and the session is held in an ESCALATED state — the dialog
     * surfaces the block rather than advancing to settlement review.
     */
    escalateAnomaliesFurther: async (dispositions) => {
      const { payload, sessionId } = get();
      if (!payload || !sessionId) return;

      set({ busy: true, error: null });
      for (const d of dispositions) {
        await logAnomalyDisposition(d.description, d.disposition);
      }
      const blockingCount = dispositions.filter((d) => d.disposition === "blocking").length;
      await log("lexguard_escalation", {
        module: "anomaly-watcher",
        field: "anomaliesSuppressed",
        user_decision: "blocking_escalation",
        blocking_count: blockingCount,
        total_anomalies: dispositions.length,
        user: get().operator,
      });

      // Route to arbitration and hold. The anomalies stay on the payload as the
      // record of what was flagged; the recommended path can no longer be direct
      // settlement, and the session state reflects the deepened escalation.
      set({
        payload: { ...payload, recommendedPath: ExecutionPath.ArbitrationEscrow, anomaliesSuppressed: false },
        busy: false,
      });
      await backend.updateSessionState(sessionId, "ESCALATED");
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
