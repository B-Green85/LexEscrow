/**
 * Environment-aware backend bridge.
 *
 * Under Tauri, every call is a real IPC `invoke` into the Rust backend
 * (ArtifactGuard + SQLite audit trail). In a plain browser (`npm run dev`, or a
 * screenshot/preview context) the same API is served by faithful JavaScript
 * fallbacks — Web Crypto SHA-256, a port of the Rust normalizer, and an
 * in-memory hash-chained audit log using the identical hashing scheme — so the
 * UI is fully demoable without the desktop shell.
 */

import { invoke } from "@tauri-apps/api/core";
import * as browserVault from "./browserVault";
import type { ClioMatterPayload, ClioMatterSummary } from "./clio";
import type {
  AiInput,
  BlockchainInput,
  BlockchainPublic,
  ClioConfigInput,
  ClioConnectionStatus,
  ClioPublic,
  CreConfig,
  DebugConsoleInput,
  DebugConsolePublic,
  DocuSignInput,
  DocuSignPublic,
  PracticePantherConfigInput,
  PracticePantherPublic,
  SmtpInput,
  TwilioInput,
  ApifyInput,
  UnlockResult,
  VaultPublic,
  VaultStatus,
  StoreBackend,
  StoreBackendError,
  OsKeychainStatus,
  MigrateResult,
} from "./vaultTypes";

export interface LoadedArtifact {
  filename: string;
  hash: string;
  size: number;
  normalizedText: string;
}

export interface AuditEntry {
  logId: number;
  sessionId: string;
  eventType: string;
  userIdentity: string;
  payloadJson: string;
  blockTimestamp: string;
  previousHash: string | null;
  entryHash: string;
}

export interface ChainVerification {
  valid: boolean;
  entries: number;
  brokenAt: number | null;
}

export interface NewSession {
  sessionId: string;
  clientId: string;
  attorneyBarNumber: string;
  documentHash: string;
  assetClass?: string; // default 'legal'
  batchId?: string; // default null
}

/**
 * One row of the Recent Workflows list (spec §12 Screen 9).
 *
 * `totalHeldCents` is `number | null` — null until the session has a parsed
 * payload, and a `number` rather than `bigint` for the same reason as every
 * other value crossing IPC: Tauri's JSON transport cannot carry bigint. It is
 * only ever formatted for display, never used in arithmetic.
 */
export interface RecentSessionRow {
  sessionId: string;
  clientId: string;
  assetClass: string;
  executionPath: string | null;
  currentState: string;
  createdAt: string;
  updatedAt: string;
  totalHeldCents: number | null;
}

export interface PayloadCentsRow {
  payloadId: string;
  sessionId: string;
  totalHeldCents: number;
  earnedFeesCents: number;
  unearnedBalanceCents: number;
  disputedHours: number;
  disputedAmountCents: number;
  assetClass?: string; // default 'legal'
  entryMode?: string; // default 'ai'
  payloadJson?: string; // default null
}

export interface CannaverifyResultArgs {
  verifyId: string;
  sessionId: string;
  checkType: string;
  metrcFacilityId?: string | null;
  stateLicenseNum?: string | null;
  result: string; // 'PASS' | 'FAIL' | 'ERROR'
  onChainTx?: string | null;
}

export interface DocusignEnvelopeArgs {
  envelopeId: string;
  sessionId: string;
  documentLabel: string;
  signersJson: string;
  provider?: string; // default 'docusign'
}

export interface DocusignEnvelopeUpdateArgs {
  envelopeId: string;
  status: string; // SENT | DELIVERED | COMPLETED | DECLINED | VOIDED
  completedAt?: string | null;
  certificateHash?: string | null;
  onChainTx?: string | null;
  anchorMatch?: number | null; // 1 = pass, 0 = fail, null = pending
}

export interface RegisteredFingerprintArgs {
  hmac: string;
  sessionId: string;
  assetClass: string;
  onChainTx?: string | null;
}

/**
 * One Path C milestone as it crosses IPC (spec §6 Path C).
 *
 * `amountCents` is `number`, not `bigint` — Tauri's JSON transport cannot
 * serialize bigint. `lib/releasePaths` widens it back to `bigint` immediately
 * on the way in, so no arithmetic is ever performed on the `number` form.
 */
export interface MilestoneRow {
  milestoneId: string;
  sessionId: string;
  label: string;
  description: string;
  amountCents: number;
  conditionType: string;
  releaseDate: string | null;
  evidenceRequired: string | null;
  status: string;
  sortOrder: number;
  submittedAt: string | null;
  approvedAt: string | null;
  releasedAt: string | null;
  txHash: string | null;
  evidenceHash: string | null;
  createdAt: string;
}

export interface CreateMilestoneArgs {
  sessionId: string;
  milestoneId: string;
  label: string;
  description: string;
  amountCents: number;
  conditionType: string; // document | time | event | manual
  releaseDate?: string | null;
  evidenceRequired?: string | null;
  sortOrder: number;
}

/**
 * Milestone status advance. Every optional field is COALESCE'd in SQL, so
 * omitting one preserves the stored value instead of nulling it.
 */
export interface UpdateMilestoneStatusArgs {
  milestoneId: string;
  status: string; // pending | submitted | approved | released | disputed
  submittedAt?: string | null;
  approvedAt?: string | null;
  releasedAt?: string | null;
  txHash?: string | null;
  evidenceHash?: string | null;
}

/** Path B 2-of-3 multi-sig tally as it crosses IPC (spec §6 Path B). */
export interface ArbitrationRow {
  sessionId: string;
  lockedAt: string | null;
  arbiterAddress: string | null;
  party1Signed: number; // SQLite INTEGER boolean
  party2Signed: number;
  arbiterSigned: number;
  threshold: number;
  resolvedAt: string | null;
  resolutionTxHash: string | null;
  resolutionNotes: string | null;
}

export interface CreateArbitrationArgs {
  sessionId: string;
  arbiterAddress?: string | null;
  threshold: number;
}

export interface UpdateArbitrationArgs {
  sessionId: string;
  party1Signed?: boolean | null;
  party2Signed?: boolean | null;
  arbiterSigned?: boolean | null;
  resolvedAt?: string | null;
  resolutionTxHash?: string | null;
  resolutionNotes?: string | null;
}

// ── Environment detection ────────────────────────────────────────────────────

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ── Browser fallbacks ────────────────────────────────────────────────────────

// ASCII Unit Separator (0x1F) — mirrors the Rust audit-hash field delimiter.
const FIELD_SEP = String.fromCharCode(0x1f);

async function sha256Prefixed(input: ArrayBuffer | Uint8Array | string): Promise<string> {
  const data =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/** JS port of the Rust `normalize_artifact_text` — must match its behavior. */
export function normalizeTextJs(raw: string): string {
  let out = "";
  const chars = Array.from(raw);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const cp = c.codePointAt(0)!;
    if (c === "\r") {
      if (chars[i + 1] === "\n") i++;
      out += "\n";
    } else if (c === "\n" || c === "\t") {
      out += c;
    } else if (
      cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 ||
      cp === 0xfeff || cp === 0x00ad || cp === 0x180e || cp === 0x200e ||
      cp === 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
    ) {
      // hidden / zero-width / bidi controls -> drop
    } else if (
      cp === 0x00a0 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f ||
      cp === 0x205f || cp === 0x3000
    ) {
      out += " ";
    } else if (cp === 0x2028 || cp === 0x2029) {
      out += "\n";
    } else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
      // remaining control characters -> drop
    } else {
      out += c;
    }
  }
  return out;
}

// In-memory state for browser mode.
const memBaselines = new Map<string, string>();
const memAudit: AuditEntry[] = [];

// Serializes appends so concurrent (non-awaited) log calls cannot read the same
// chain head and fork it — the browser analogue of the Rust append mutex.
let memAppendLock: Promise<void> = Promise.resolve();

async function memAppendAudit(
  sessionId: string,
  eventType: string,
  userIdentity: string,
  payloadJson: string,
): Promise<AuditEntry> {
  const prior = memAppendLock;
  let release!: () => void;
  memAppendLock = new Promise((r) => (release = r));
  await prior.catch(() => {});
  try {
    const logId = memAudit.length + 1;
    const previousHash = memAudit.length ? memAudit[memAudit.length - 1].entryHash : null;
    const blockTimestamp = new Date().toISOString();
    const material =
      [String(logId), sessionId, eventType, userIdentity, payloadJson, blockTimestamp, previousHash ?? ""].join(
        FIELD_SEP,
      ) + FIELD_SEP;
    const entryHash = await sha256Prefixed(material);
    const entry: AuditEntry = {
      logId,
      sessionId,
      eventType,
      userIdentity,
      payloadJson,
      blockTimestamp,
      previousHash,
      entryHash,
    };
    memAudit.push(entry);
    return entry;
  } finally {
    release();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** The Rust command's verdict — see `src-tauri/src/bar_verify.rs`. */
export interface BarVerifyApiResult {
  verified: boolean;
  name: string | null;
  licenseStatus: string | null;
  hasPublicDiscipline: boolean;
  /** The resolved two-letter code that was actually queried. */
  state: string;
  error: string | null;
}

/**
 * Attorney bar verification against the official state registry.
 *
 * Issued by the Rust backend, which holds the Apify token: the lookup is
 * authenticated with a credential that must never reach the WebView, and it is
 * cross-origin besides. The backend never rejects — every failure comes back as
 * a result with `verified: false` and an `error`, because this sits on a
 * settlement gate and a thrown exception there is indistinguishable from a
 * crash.
 *
 * Outside Tauri (`npm run dev`, tests) there is no vault to hold a token and no
 * backend to spend it, so this reports itself unconfigured rather than calling
 * Apify from the page. A browser-issued call would have to embed the token in
 * the document to work at all.
 */
export async function verifyBarNumber(
  barNumber: string,
  state: string,
): Promise<BarVerifyApiResult> {
  if (isTauri()) {
    return invoke<BarVerifyApiResult>("verify_bar_number", { barNumber, state });
  }
  return {
    verified: false,
    name: null,
    licenseStatus: null,
    hasPublicDiscipline: false,
    state,
    error: BAR_VERIFY_NOT_CONFIGURED,
  };
}

/**
 * Spelled identically to `NOT_CONFIGURED` in `src-tauri/src/bar_verify.rs`.
 *
 * The router matches on this string to tell "no token" apart from "the registry
 * refused", and those render differently — grey versus amber — so the two
 * copies have to agree byte for byte.
 */
export const BAR_VERIFY_NOT_CONFIGURED =
  "Bar verification not configured — add Apify token in Configuration";

export async function loadArtifact(filename: string, bytes: Uint8Array): Promise<LoadedArtifact> {
  if (isTauri()) {
    return invoke<LoadedArtifact>("load_artifact", { filename, bytes: Array.from(bytes) });
  }
  const hash = await sha256Prefixed(bytes);
  memBaselines.set(filename, hash);
  return {
    filename,
    hash,
    size: bytes.length,
    normalizedText: normalizeTextJs(new TextDecoder().decode(bytes)),
  };
}

/**
 * Plain text of a document, for trust-anchor suggestion at Document Load.
 *
 * Never throws and never rejects. Suggestion is advisory — the officer confirms
 * every anchor before Continue, and LexGuard validates against the confirmed
 * values — so a format the backend cannot read must degrade to "no suggestions"
 * rather than an error the officer has to dismiss to get on with the workflow.
 *
 * In a plain browser there is no extractor, so only the formats the WebView can
 * decode itself are handled: `.txt` and `.md` are read directly, and everything
 * binary returns "". PDF/DOCX/XLSX suggestion is a desktop-only capability.
 */
export async function extractDocumentText(fileName: string, bytes: Uint8Array): Promise<string> {
  try {
    if (isTauri()) {
      return await invoke<string>("extract_document_text_bytes", {
        fileName,
        fileBytes: Array.from(bytes),
      });
    }
    return /\.(txt|md)$/i.test(fileName) ? new TextDecoder().decode(bytes) : "";
  } catch {
    return "";
  }
}

/**
 * Plain text of a document already on disk, addressed by absolute path.
 *
 * The byte-oriented call above is what the UI uses — browser `File` objects
 * expose no filesystem path. This variant serves callers that do hold one (a
 * future Tauri drag-drop payload or folder walk), and is the only entry point
 * that surfaces an error, since a caller supplying a path can act on the file
 * being missing.
 */
export async function extractDocumentTextAtPath(filePath: string): Promise<string> {
  try {
    if (isTauri()) return await invoke<string>("extract_document_text", { filePath });
    return "";
  } catch {
    return "";
  }
}

/**
 * Hash arbitrary bytes through ArtifactGuard, returning `sha256:<hex>`.
 *
 * A second call path into the same registry as `loadArtifact`, for artifacts
 * that arrive mid-workflow rather than being loaded by the user — currently the
 * DocuSign certificate of completion (spec §23). Registering rather than merely
 * hashing means the certificate gets an integrity baseline too, so later
 * tampering is detectable by the same `verifyArtifact` machinery as the source
 * document.
 */
export async function hashBytes(bytes: Uint8Array, label = "certificate.pdf"): Promise<string> {
  if (isTauri()) {
    return invoke<string>("register_artifact", { filename: label, bytes: Array.from(bytes) });
  }
  const hash = await sha256Prefixed(bytes);
  memBaselines.set(label, hash);
  return hash;
}

/** Blocking final re-verify. Resolves if unchanged, rejects with a reason. */
export async function finalVerifyBeforeExecution(filename: string, bytes: Uint8Array): Promise<void> {
  if (isTauri()) {
    return invoke<void>("final_verify_before_execution", { filename, bytes: Array.from(bytes) });
  }
  const baseline = memBaselines.get(filename);
  const current = await sha256Prefixed(bytes);
  if (baseline !== current) {
    throw { reason: "Artifact modified after parsing — re-review required" };
  }
}

// Browser-mode session store. Unlike the write-only tables, sessions are *read
// back* — the Recent Workflows list is a query over them — so a no-op fallback
// would leave that screen permanently empty under `npm run dev`. Insertion
// order stands in for the SQL `ORDER BY created_at, rowid`.
const memSessions = new Map<string, RecentSessionRow>();

export async function createSession(session: NewSession): Promise<void> {
  if (isTauri()) return invoke<void>("create_session", { session });
  const now = new Date().toISOString();
  memSessions.set(session.sessionId, {
    sessionId: session.sessionId,
    clientId: session.clientId,
    assetClass: session.assetClass ?? "legal",
    executionPath: null,
    currentState: "LOADED",
    createdAt: now,
    updatedAt: now,
    totalHeldCents: null,
  });
}

/** Mirrors the SQL `update_session_timestamp` trigger. */
function memTouchSession(sessionId: string, patch: Partial<RecentSessionRow>): void {
  const row = memSessions.get(sessionId);
  if (!row) return;
  memSessions.set(sessionId, { ...row, ...patch, updatedAt: new Date().toISOString() });
}

export async function updateSessionState(sessionId: string, newState: string): Promise<void> {
  if (isTauri()) return invoke<void>("update_session_state", { sessionId, newState });
  memTouchSession(sessionId, { currentState: newState });
}

export async function setExecutionPath(sessionId: string, path: string): Promise<void> {
  if (isTauri()) return invoke<void>("set_execution_path", { sessionId, path });
  memTouchSession(sessionId, { executionPath: path });
}

export async function savePayload(payload: PayloadCentsRow): Promise<void> {
  if (isTauri()) return invoke<void>("save_payload", { payload });
  memTouchSession(payload.sessionId, { totalHeldCents: payload.totalHeldCents });
}

/**
 * The `limit` most recently created sessions, newest first.
 *
 * The browser fallback reverses before sorting so that sessions sharing a
 * timestamp come back newest-first, matching the backend's
 * `ORDER BY created_at DESC, rowid DESC`.
 */
export async function getRecentSessions(limit = 20): Promise<RecentSessionRow[]> {
  if (isTauri()) return invoke<RecentSessionRow[]>("get_recent_sessions", { limit });
  return [...memSessions.values()]
    .reverse()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** Record a CannaVerify regulatory check result (cannabis asset class). */
export async function saveCannaverifyResult(args: CannaverifyResultArgs): Promise<void> {
  if (isTauri()) return invoke<void>("save_cannaverify_result", { ...args });
  // browser: nothing to persist
}

/** Persist a freshly-sent DocuSign envelope (status defaults to SENT). */
export async function saveDocusignEnvelope(args: DocusignEnvelopeArgs): Promise<void> {
  if (isTauri()) {
    return invoke<void>("save_docusign_envelope", { provider: "docusign", ...args });
  }
  // browser: nothing to persist
}

/** Update an existing DocuSign envelope on a status change / completion. */
export async function updateDocusignEnvelope(args: DocusignEnvelopeUpdateArgs): Promise<void> {
  if (isTauri()) return invoke<void>("update_docusign_envelope", { ...args });
  // browser: nothing to persist
}

/** Register an AnchorReceipt HMAC fingerprint on-chain anchor for a session. */
export async function saveRegisteredFingerprint(args: RegisteredFingerprintArgs): Promise<void> {
  if (isTauri()) return invoke<void>("save_registered_fingerprint", { ...args });
  // browser: nothing to persist
}

/**
 * Anchor a document fingerprint in the Sepolia AnchorRegistry (spec §8 step 3)
 * and resolve to the confirmed transaction hash.
 *
 * Desktop only, and no browser stand-in: a fabricated hash is exactly what this
 * replaced. Rejects on a locked vault, a missing `ANCHOR_REGISTRY_ADDRESS`, an
 * unreachable RPC or a revert; callers mark the item unregistered.
 */
export async function anchorDocument(hash: string): Promise<string> {
  if (!isTauri()) throw new Error("On-chain anchoring requires the desktop backend.");
  return invoke<string>("anchor_document", { hash });
}

/**
 * AnchorReceipt HMAC seal over `"{hash}|{size}"` (spec §8).
 *
 * Keyed sealing only happens in the Rust backend — the seal key must never
 * cross into the WebView, or the attestation it represents would be forgeable
 * by anything running in the page. The browser fallback is therefore an
 * explicitly-labelled `DEMO-HMAC-` stand-in rather than a JS HMAC: a demo build
 * has no seal key to keep, and a real-looking seal computed in the browser
 * would misrepresent what was actually attested.
 *
 * Under Tauri this **rejects when the credential vault is locked**: the seal
 * key is per-install and stored in the vault, so a locked vault means this
 * install cannot attest anything right now. Callers treat that as a failed
 * registration step, never as a reason to fall back to a weaker key.
 */
export async function computeHmacSeal(hash: string, size: number): Promise<string> {
  if (isTauri()) return invoke<string>("compute_hmac_seal", { hash, size });
  return `DEMO-HMAC-${hash.slice(0, 8)}`;
}

// ── Release paths — Path C milestones, Path B arbitration (spec §6) ──────────

// Browser-mode stores. Unlike the write-only tables above (CannaVerify results,
// fingerprints), release-path rows are *read back* to drive the execution UI —
// so a no-op fallback would leave Path B and Path C blank under `npm run dev`.
// These mirror the SQLite tables, including the COALESCE update semantics.
const memMilestones = new Map<string, MilestoneRow>();
const memArbitration = new Map<string, ArbitrationRow>();

/** COALESCE(?, col) — an omitted value preserves what is already stored. */
function coalesce<T>(next: T | null | undefined, current: T | null): T | null {
  return next === undefined || next === null ? current : next;
}

export async function createMilestone(args: CreateMilestoneArgs): Promise<void> {
  if (isTauri()) return invoke<void>("create_milestone", { ...args });
  memMilestones.set(args.milestoneId, {
    milestoneId: args.milestoneId,
    sessionId: args.sessionId,
    label: args.label,
    description: args.description,
    amountCents: args.amountCents,
    conditionType: args.conditionType,
    releaseDate: args.releaseDate ?? null,
    evidenceRequired: args.evidenceRequired ?? null,
    status: "pending",
    sortOrder: args.sortOrder,
    submittedAt: null,
    approvedAt: null,
    releasedAt: null,
    txHash: null,
    evidenceHash: null,
    createdAt: new Date().toISOString(),
  });
}

export async function updateMilestoneStatus(args: UpdateMilestoneStatusArgs): Promise<void> {
  if (isTauri()) return invoke<void>("update_milestone_status", { ...args });
  const row = memMilestones.get(args.milestoneId);
  if (!row) return;
  memMilestones.set(args.milestoneId, {
    ...row,
    status: args.status,
    submittedAt: coalesce(args.submittedAt, row.submittedAt),
    approvedAt: coalesce(args.approvedAt, row.approvedAt),
    releasedAt: coalesce(args.releasedAt, row.releasedAt),
    txHash: coalesce(args.txHash, row.txHash),
    evidenceHash: coalesce(args.evidenceHash, row.evidenceHash),
  });
}

export async function getMilestones(sessionId: string): Promise<MilestoneRow[]> {
  if (isTauri()) return invoke<MilestoneRow[]>("get_milestones", { sessionId });
  return [...memMilestones.values()]
    .filter((m) => m.sessionId === sessionId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

export async function createArbitration(args: CreateArbitrationArgs): Promise<void> {
  if (isTauri()) return invoke<void>("create_arbitration", { ...args });
  memArbitration.set(args.sessionId, {
    sessionId: args.sessionId,
    lockedAt: new Date().toISOString(),
    arbiterAddress: args.arbiterAddress ?? null,
    party1Signed: 0,
    party2Signed: 0,
    arbiterSigned: 0,
    threshold: args.threshold,
    resolvedAt: null,
    resolutionTxHash: null,
    resolutionNotes: null,
  });
}

export async function updateArbitration(args: UpdateArbitrationArgs): Promise<void> {
  if (isTauri()) return invoke<void>("update_arbitration", { ...args });
  const row = memArbitration.get(args.sessionId);
  if (!row) return;
  const flag = (next: boolean | null | undefined, current: number): number =>
    next === undefined || next === null ? current : next ? 1 : 0;
  memArbitration.set(args.sessionId, {
    ...row,
    party1Signed: flag(args.party1Signed, row.party1Signed),
    party2Signed: flag(args.party2Signed, row.party2Signed),
    arbiterSigned: flag(args.arbiterSigned, row.arbiterSigned),
    resolvedAt: coalesce(args.resolvedAt, row.resolvedAt),
    resolutionTxHash: coalesce(args.resolutionTxHash, row.resolutionTxHash),
    resolutionNotes: coalesce(args.resolutionNotes, row.resolutionNotes),
  });
}

export async function getArbitration(sessionId: string): Promise<ArbitrationRow | null> {
  if (isTauri()) return invoke<ArbitrationRow | null>("get_arbitration", { sessionId });
  return memArbitration.get(sessionId) ?? null;
}

// ── Conditions — Stage 7 condition tracking (spec §6) ────────────────────────

/** One tracked release condition as it crosses IPC. */
export interface ConditionRow {
  conditionId: string;
  sessionId: string;
  conditionType: string;
  label: string;
  description: string;
  status: string; // pending | in_progress | met | failed | waived
  metadataJson: string | null;
  metAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  onChainTx: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveConditionArgs {
  sessionId: string;
  conditionId: string;
  conditionType: string;
  label: string;
  description: string;
  status: string;
  metadataJson?: string | null;
}

/**
 * Condition status transition. Every optional field is COALESCE'd in SQL, so
 * omitting one preserves the stored value instead of nulling it.
 */
export interface UpdateConditionStatusArgs {
  conditionId: string;
  status: string;
  metAt?: string | null;
  failedAt?: string | null;
  failureReason?: string | null;
  onChainTx?: string | null;
}

// Browser-mode store. Like the release-path tables and unlike the write-only
// ones, conditions are *read back* to drive the Escrow Monitor, so a no-op
// fallback would leave the checklist blank under `npm run dev`. Insertion order
// is preserved to match the SQL `ORDER BY created_at, rowid`.
const memConditions = new Map<string, ConditionRow>();

/**
 * Insert a condition, or refresh the descriptive fields of one already stored.
 *
 * Mirrors the Rust upsert exactly, including the part that matters most: an
 * existing row keeps its `status` and timestamps. The poll loop re-saves the
 * whole checklist every tick, so overwriting status here would revoke waivers.
 */
export async function saveCondition(args: SaveConditionArgs): Promise<void> {
  if (isTauri()) return invoke<void>("save_condition", { ...args });

  const existing = memConditions.get(args.conditionId);
  const now = new Date().toISOString();
  memConditions.set(args.conditionId, {
    conditionId: args.conditionId,
    sessionId: args.sessionId,
    conditionType: args.conditionType,
    label: args.label,
    description: args.description,
    metadataJson: args.metadataJson ?? null,
    // Preserved across a re-save — status is owned by updateConditionStatus.
    status: existing?.status ?? args.status,
    metAt: existing?.metAt ?? null,
    failedAt: existing?.failedAt ?? null,
    failureReason: existing?.failureReason ?? null,
    onChainTx: existing?.onChainTx ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

export async function updateConditionStatus(args: UpdateConditionStatusArgs): Promise<void> {
  if (isTauri()) return invoke<void>("update_condition_status", { ...args });

  const row = memConditions.get(args.conditionId);
  if (!row) return;
  memConditions.set(args.conditionId, {
    ...row,
    status: args.status,
    metAt: coalesce(args.metAt, row.metAt),
    failedAt: coalesce(args.failedAt, row.failedAt),
    failureReason: coalesce(args.failureReason, row.failureReason),
    onChainTx: coalesce(args.onChainTx, row.onChainTx),
    updatedAt: new Date().toISOString(),
  });
}

export async function getConditions(sessionId: string): Promise<ConditionRow[]> {
  if (isTauri()) return invoke<ConditionRow[]>("get_conditions", { sessionId });
  return [...memConditions.values()].filter((c) => c.sessionId === sessionId);
}

export async function logEvent(
  sessionId: string,
  eventType: string,
  userIdentity: string,
  payloadJson: string,
): Promise<AuditEntry> {
  if (isTauri()) {
    return invoke<AuditEntry>("log_event", { sessionId, eventType, userIdentity, payloadJson });
  }
  return memAppendAudit(sessionId, eventType, userIdentity, payloadJson);
}

export async function getAuditTrail(sessionId: string): Promise<AuditEntry[]> {
  if (isTauri()) return invoke<AuditEntry[]>("get_audit_trail", { sessionId });
  return memAudit.filter((e) => e.sessionId === sessionId);
}

export interface NotifyRequest {
  channel: "email" | "sms";
  to: string;
  clientName: string;
  amountCents: number;
  reference: string;
}

export interface NotifyResult {
  channel: "email" | "sms";
  target: string;
  status: "sent" | "delivered" | "skipped" | "failed";
}

/**
 * Post-settlement client notification. Under Tauri this calls the Rust
 * SMTP/Twilio layer; in the browser it simulates delivery. An empty target is
 * skipped (optional SMS).
 */
export async function sendClientNotification(req: NotifyRequest): Promise<NotifyResult> {
  if (!req.to || !req.to.trim()) {
    return { channel: req.channel, target: req.to, status: "skipped" };
  }
  if (isTauri()) {
    try {
      return await invoke<NotifyResult>("send_client_notification", { request: req });
    } catch {
      return { channel: req.channel, target: req.to, status: "failed" };
    }
  }
  return { channel: req.channel, target: req.to, status: "delivered" };
}

export async function verifyAuditChain(): Promise<ChainVerification> {
  if (isTauri()) return invoke<ChainVerification>("verify_audit_chain");
  // Recompute the in-memory chain.
  let prev: string | null = null;
  for (const e of memAudit) {
    const material =
      [String(e.logId), e.sessionId, e.eventType, e.userIdentity, e.payloadJson, e.blockTimestamp, e.previousHash ?? ""].join(
        FIELD_SEP,
      ) + FIELD_SEP;
    const recomputed = await sha256Prefixed(material);
    if (e.previousHash !== prev || recomputed !== e.entryHash) {
      return { valid: false, entries: memAudit.length, brokenAt: e.logId };
    }
    prev = e.entryHash;
  }
  return { valid: true, entries: memAudit.length, brokenAt: null };
}

// ── Credential vault ─────────────────────────────────────────────────────────

export async function vaultStatus(): Promise<VaultStatus> {
  return isTauri() ? invoke<VaultStatus>("vault_status") : browserVault.status();
}

export async function vaultUnlock(password: string): Promise<UnlockResult> {
  return isTauri() ? invoke<UnlockResult>("vault_unlock", { password }) : browserVault.unlock(password);
}

export async function vaultLock(): Promise<void> {
  if (isTauri()) {
    await invoke("vault_lock");
    return;
  }
  browserVault.lock();
}

export async function vaultGetPublic(): Promise<VaultPublic> {
  return isTauri() ? invoke<VaultPublic>("vault_get_public") : browserVault.getPublic();
}

export async function vaultSetAi(input: AiInput): Promise<void> {
  if (isTauri()) {
    await invoke("vault_set_ai", { input });
    return;
  }
  await browserVault.setAi(input);
}

export async function vaultSetSmtp(input: SmtpInput): Promise<void> {
  if (isTauri()) {
    await invoke("vault_set_smtp", { input });
    return;
  }
  await browserVault.setSmtp(input);
}

export async function vaultSetTwilio(input: TwilioInput): Promise<void> {
  if (isTauri()) {
    await invoke("vault_set_twilio", { input });
    return;
  }
  await browserVault.setTwilio(input);
}

export async function vaultSetApify(input: ApifyInput): Promise<void> {
  if (isTauri()) {
    await invoke("vault_set_apify", { input });
    return;
  }
  await browserVault.setApify(input);
}

export async function vaultDelete(
  group: "ai" | "smtp" | "twilio" | "apify" | "docusign" | "blockchain",
): Promise<void> {
  if (isTauri()) {
    await invoke("vault_delete", { group });
    return;
  }
  await browserVault.deleteGroup(group);
}

// ── DocuSign credentials (spec §24) ──────────────────────────────────────────

/** Does the vault hold usable DocuSign credentials? Gates the real provider. */
export async function hasDocuSign(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>("vault_has_docusign");
  return browserVault.hasDocusign();
}

export async function getDocuSignPublic(): Promise<DocuSignPublic> {
  if (isTauri()) return invoke<DocuSignPublic>("vault_get_docusign_public");
  return browserVault.getDocusignPublic();
}

export async function setDocuSign(input: DocuSignInput): Promise<void> {
  if (isTauri()) {
    await invoke("vault_set_docusign", { input });
    return;
  }
  await browserVault.setDocusign(input);
}

// ── Blockchain settlement config ─────────────────────────────────────────────

/**
 * Public view of the on-chain settlement config.
 *
 * Carries no private key and no RPC credential — only `hasPrivateKey` and the
 * RPC *host*. Everything else is a public on-chain identifier.
 */
export async function getBlockchainPublic(): Promise<BlockchainPublic> {
  if (isTauri()) return invoke<BlockchainPublic>("vault_get_blockchain_public");
  return browserVault.getBlockchainPublic();
}

/**
 * Write the blockchain config.
 *
 * Takes a password as a second factor — unlike every other setter here. The
 * deployer private key is the one credential in this application that cannot be
 * revoked after it leaks, so an unattended machine is not sufficient authority
 * to write one.
 *
 * Which password depends on the backend, and the caller does not have to know:
 * under App Vault it is the vault password, re-derived and compared in constant
 * time; under OS Keychain it is the write authorization password, checked
 * against a bcrypt hash. One command either way — the generic `setCredential`
 * refuses this group, so there is no ungated path to the key.
 */
export async function setBlockchain(password: string, input: BlockchainInput): Promise<void> {
  if (isTauri()) {
    await invoke("set_blockchain_credential", {
      credentialJson: JSON.stringify(input),
      confirmationPassword: password,
    });
    return;
  }
  await browserVault.setBlockchain(password, input);
}

/**
 * Has a blockchain write authorization password been enrolled?
 *
 * Decides whether the modal asks the operator to *set* a password or to
 * *confirm* one, and whether Configuration offers a change link. Only ever true
 * under the OS-keychain backend — App Vault gates on the vault password and
 * enrols nothing.
 */
export async function hasBlockchainWriteAuth(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("has_blockchain_write_auth");
  } catch {
    return false;
  }
}

/** Replace the write authorization password, proving the current one first. */
export async function changeBlockchainWriteAuth(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("change_blockchain_write_auth", { currentPassword, newPassword });
}

/**
 * Can this install actually settle on-chain? Gates the settle button.
 *
 * Stricter than `hasConfig`: network settings with no signing key describe a
 * chain this install can read but not write. A locked vault reports `false`
 * rather than throwing, so the workflow degrades instead of failing.
 */
export async function hasBlockchain(): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invoke<boolean>("vault_has_blockchain");
    } catch {
      return false;
    }
  }
  try {
    return browserVault.hasBlockchain();
  } catch {
    return false;
  }
}

/**
 * CRE workflow configuration assembled from the vault.
 *
 * Outside Tauri there is no Rust signer to assemble it, so this reports "not
 * configured" rather than synthesising one from the browser vault — the browser
 * path has no way to run the workflow regardless.
 */
export async function getCreConfig(): Promise<CreConfig> {
  if (!isTauri()) throw new Error("CRE configuration requires the desktop backend.");
  return invoke<CreConfig>("get_cre_config");
}

// ── USDC/USD price feed (Chainlink Data Feed, read-only) ─────────────────────

/** Mirrors the Rust `UsdcPrice` — live market data from the mainnet feed. */
export interface UsdcPrice {
  /** USD per 1 USDC as a decimal string, e.g. "0.99987". Display data only. */
  price: string;
  /** Unix seconds of the feed's last on-chain update. */
  updatedAt: number;
}

/**
 * Live USDC/USD rate from Chainlink's mainnet Data Feed, read by the desktop
 * backend over a keyless `eth_call` (no credentials, nothing signed).
 *
 * Resolves `null` whenever a real rate is unavailable — outside Tauri, RPC
 * unreachable, a stale or non-positive round. Never a fabricated rate: the
 * caller's contract is that a number displayed next to "Chainlink Price Feed"
 * actually came from the feed, so "unavailable" must render as no number.
 */
export async function getUsdcPrice(): Promise<UsdcPrice | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<UsdcPrice>("get_usdc_price");
  } catch {
    return null;
  }
}

// ── On-chain settlement — Path A DirectSettlement ────────────────────────────

export interface DirectSettleArgs {
  clientWallet: string;
  firmWallet: string;
  /**
   * USDC base units (integer, 6 decimals) as a decimal string — Tauri's JSON
   * transport cannot carry bigint, and a `number` would silently lose
   * precision above 2^53 base units.
   */
  clientAmountUsdc: string;
  firmAmountUsdc: string;
  /** ArtifactGuard hash (`sha256:<64 hex>`) — anchored as the bytes32 documentHash. */
  documentHash: string;
}

/** Mirrors the Rust `DirectSettleResult` — all public on-chain data. */
export interface DirectSettleResult {
  /** Real transaction hash (`0x` + 64 hex) from the signed, accepted tx. */
  txHash: string;
  blockNumber: number | null;
  gasUsed: number;
}

/**
 * Sign, broadcast and confirm a real `directSettle` transaction from the
 * vault-held deployer key (Rust-side; the key never crosses IPC).
 *
 * Rejects on every failure — locked credential store, RPC unreachable,
 * `onlyWorkflow` rejection, on-chain revert, confirmation timeout. Outside
 * Tauri there is no signer, so this rejects rather than simulating: a
 * plausible-looking value here would render as a settlement reference for
 * money that never moved, which is exactly the failure this seam exists to
 * make impossible.
 */
export async function executeDirectSettle(args: DirectSettleArgs): Promise<DirectSettleResult> {
  if (!isTauri()) throw new Error("On-chain settlement requires the desktop backend.");
  return invoke<DirectSettleResult>("execute_direct_settle", { ...args });
}

// ── CRE Confidential Workflow — HTTPTrigger (spec §13) ───────────────────────

/** Mirrors the Rust `CreTriggerResult` — opaque public identifiers only. */
export interface CreTriggerResult {
  /** The DON's ID for this run. What LexTrace matches on when the poll picks it up. */
  executionId: string;
  /** `"ACCEPTED"` when the gateway queued the run. */
  status: string;
  workflowId: string;
}

/**
 * Trigger the deployed CRE Confidential Workflow for an escrow.
 *
 * The workflow validates the payload and computes an HMAC seal inside a TEE
 * enclave; it does not settle and it authorises nothing. Callers treat a
 * rejection as an observation that did not happen — never as a settlement that
 * must not — so this is the one backend seam whose failure is deliberately not
 * allowed to stop the flow that calls it.
 *
 * Outside Tauri there is no signer and no gateway, so this rejects rather than
 * simulating: a fabricated execution ID would surface in the event log as
 * evidence of an enclave run that never occurred.
 */
export async function triggerCreWorkflow(payload: Record<string, unknown>): Promise<CreTriggerResult> {
  if (!isTauri()) throw new Error("The CRE workflow trigger requires the desktop backend.");
  return invoke<CreTriggerResult>("trigger_cre_workflow", { payload });
}

// ── Practice-management integrations (spec §14 V1) ───────────────────────────

export async function setClio(input: ClioConfigInput): Promise<void> {
  if (isTauri()) {
    await invoke("vault_set_clio", { input });
    return;
  }
  await browserVault.setClio(input);
}

export async function getClioPublic(): Promise<ClioPublic> {
  if (isTauri()) return invoke<ClioPublic>("vault_get_clio_public");
  return browserVault.getClioPublic();
}

// ── Clio Manage — OAuth 2.0 and read-only matter intake ──────────────────────
//
// Every one of these needs a real HTTP client, a loopback listener and the
// stored client secret, none of which exist in a browser build. They reject
// rather than degrade: a fabricated matter in an intake path that feeds an
// escrow would be far worse than an honest refusal.

const NO_CLIO_OUTSIDE_TAURI = "Clio intake needs the desktop app.";

/**
 * Start an authorization: returns the URL to open, and opens the loopback
 * listener behind it.
 *
 * The two are one call because a URL without a listener behind it sends the
 * operator to a consent screen whose redirect lands nowhere — a failure that
 * would surface minutes later as "nothing happened".
 */
export async function clioGetAuthUrl(): Promise<string> {
  if (!isTauri()) throw new Error(NO_CLIO_OUTSIDE_TAURI);
  return invoke<string>("clio_get_auth_url");
}

/** Redeem the authorization code. Rejects if `state` does not match the flow. */
export async function clioExchangeCode(code: string, state: string): Promise<void> {
  if (!isTauri()) throw new Error(NO_CLIO_OUTSIDE_TAURI);
  await invoke("clio_exchange_code", { code, state });
}

export async function clioRefreshToken(): Promise<void> {
  if (!isTauri()) throw new Error(NO_CLIO_OUTSIDE_TAURI);
  await invoke("clio_refresh_token");
}

/**
 * Validate the stored token upstream and report who it belongs to.
 *
 * Answers "not connected" rather than throwing for every failure — an expired
 * refresh token, an unreachable Clio, no registration at all. The Configuration
 * screen renders that state; it does not have to handle it as an error.
 */
export async function clioCheckConnection(): Promise<ClioConnectionStatus> {
  if (!isTauri()) return { connected: false, expiresAt: null, firmName: null };
  try {
    return await invoke<ClioConnectionStatus>("clio_check_connection");
  } catch {
    return { connected: false, expiresAt: null, firmName: null };
  }
}

/** Drop the token set, keeping the app registration. */
export async function clioDisconnect(): Promise<void> {
  if (!isTauri()) return;
  await invoke("clio_disconnect");
}

export async function clioSearchMatters(query: string): Promise<ClioMatterSummary[]> {
  if (!isTauri()) throw new Error(NO_CLIO_OUTSIDE_TAURI);
  return invoke<ClioMatterSummary[]>("clio_search_matters", { query });
}

/**
 * Fetch one matter across all five Clio endpoints.
 *
 * The returned payload is held in the session store for the length of one
 * escrow transaction and written nowhere — Clio's ToS §10(e) forbids persisting
 * it, and the backend command that produces it takes no database handle.
 */
export async function clioFetchMatter(matterId: number): Promise<ClioMatterPayload> {
  if (!isTauri()) throw new Error(NO_CLIO_OUTSIDE_TAURI);
  return invoke<ClioMatterPayload>("clio_fetch_matter", { matterId });
}

/**
 * Subscribe to the OAuth callback the loopback listener emits.
 *
 * Returns an unsubscribe function. Outside Tauri there is no listener, so this
 * is a no-op subscription rather than a throw — the Configuration screen mounts
 * it unconditionally, and a browser preview should render, not crash.
 */
export async function onClioOAuthCallback(
  handler: (payload: { code: string; state: string }) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ code: string; state: string }>("clio:oauth_callback", (event) =>
    handler(event.payload),
  );
}

export async function setPracticePanther(input: PracticePantherConfigInput): Promise<void> {
  if (isTauri()) {
    await invoke("vault_set_practice_panther", { input });
    return;
  }
  await browserVault.setPracticePanther(input);
}

export async function getPracticePantherPublic(): Promise<PracticePantherPublic> {
  if (isTauri()) return invoke<PracticePantherPublic>("vault_get_practice_panther_public");
  return browserVault.getPracticePantherPublic();
}

export type IntegrationVendor = "clio" | "practicePanther";

/** Mirrors the Rust `WebhookOutcome` and the frontend `WebhookResult`. */
export interface WebhookOutcome {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Deliver a webhook body through the **backend**, using the vault-held API key.
 *
 * This is why the frontend never reads the integration API keys: they are
 * bearer tokens for a firm's matter data, and `vault.rs` guarantees secrets do
 * not cross IPC. The payload is composed in the WebView (it is a projection of
 * session state, which lives there) and posted in Rust (where the credential
 * lives), so neither side needs what the other holds.
 *
 * Outside Tauri there is no backend to delegate to; the caller falls back to
 * posting directly with the browser-vault config.
 */
export async function sendIntegrationWebhook(
  vendor: IntegrationVendor,
  body: unknown,
): Promise<WebhookOutcome> {
  if (!isTauri()) return { success: false, error: "No backend transport outside Tauri" };
  try {
    return await invoke<WebhookOutcome>("integration_send_webhook", {
      vendor,
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Webhook configs for the session store's firing points.
 *
 * Under Tauri the returned configs deliberately carry **no** `apiKey` — they
 * exist only to say "this vendor is configured, and here is where it points".
 * Delivery goes through `sendIntegrationWebhook`, which supplies the credential
 * backend-side. In browser mode the full config (key included) comes back,
 * because there is no backend and the browser vault is the only holder.
 *
 * A locked vault yields nothing configured rather than throwing: webhooks are
 * non-fatal by contract, and an unlocked-vault requirement would make them a
 * hard dependency of settlement.
 */
export async function getIntegrationConfigs(): Promise<{
  practicePanther?: { webhookUrl: string; matterId?: string; apiKey?: string };
}> {
  if (!isTauri()) {
    try {
      return browserVault.resolveWebhookConfigs();
    } catch {
      return {};
    }
  }
  try {
    // Clio is absent by design. Its credential group is now an OAuth app
    // registration with no webhook URL and no API key, and the Clio Manage
    // integration is read-only by contract — LexEscrow reads matters from it
    // and never writes anything back.
    const pp = await getPracticePantherPublic();
    return {
      ...(pp.webhookUrl && {
        practicePanther: {
          webhookUrl: pp.webhookUrl,
          ...(pp.matterId && { matterId: pp.matterId }),
        },
      }),
    };
  } catch {
    return {};
  }
}

// ── LexTrace debug console ───────────────────────────────────────────────────

/**
 * Store the debug-console credentials.
 *
 * A blank `password` keeps the stored hash, matching every other group — the
 * operator name can be corrected on its own. The plaintext is hashed backend
 * side and is never stored, so there is no read counterpart to this write.
 */
export async function setDebugConsole(input: DebugConsoleInput): Promise<void> {
  if (isTauri()) {
    await invoke("vault_set_debug_console", { input });
    return;
  }
  await browserVault.setDebugConsole(input);
}

export async function getDebugConsolePublic(): Promise<DebugConsolePublic> {
  if (isTauri()) return invoke<DebugConsolePublic>("vault_get_debug_console_public");
  return browserVault.getDebugConsolePublic();
}

/**
 * Is the console set up at all?
 *
 * Answers `false` rather than throwing when the vault is locked or the group is
 * absent, because the caller is the debug icon deciding between opening the
 * password prompt and showing "requires IT setup" — and both of those are the
 * same answer.
 */
export async function hasDebugConsole(): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invoke<boolean>("vault_has_debug_console");
    } catch {
      return false;
    }
  }
  return browserVault.hasDebugConsole();
}

/**
 * The password gate. One bit out, by design: a wrong password and a locked
 * vault are indistinguishable to the WebView, which is what they should be.
 */
export async function authenticateDebugConsole(password: string): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invoke<boolean>("debug_console_authenticate", { password });
    } catch {
      return false;
    }
  }
  return browserVault.verifyDebugConsole(password);
}

/**
 * Run the next CRE CLI command and return its output with ANSI codes intact.
 *
 * Which command runs is the backend's decision, not this call's — it alternates
 * between the two read-only invocations on every call, and nothing here can
 * name a third. An empty string means a run was already in flight and is not an
 * error; the panel simply has nothing to append.
 *
 * Outside Tauri there is no subprocess to run, so this rejects rather than
 * pretending: a browser preview has no CRE CLI, and a fabricated transcript in
 * a debug console would be worse than an honest refusal.
 */
export async function runCreDebug(sessionId?: string | null): Promise<string> {
  if (!isTauri()) {
    throw new Error("The debug console needs the desktop app — there is no CRE CLI in a browser.");
  }
  return invoke<string>("run_cre_debug", { sessionId: sessionId ?? null });
}

export async function vaultChangePassword(current: string, next: string): Promise<void> {
  if (isTauri()) {
    await invoke("vault_change_password", { current, next });
    return;
  }
  await browserVault.changePassword(current, next);
}

// ── AI transport (secret stays in the backend / browser vault) ───────────────

export async function aiRequestHttp(system: string, user: string): Promise<string> {
  if (isTauri()) return invoke<string>("ai_request_http", { system, user });
  return browserAiHttp(system, user);
}

export async function aiRequestWs(system: string, user: string): Promise<string> {
  if (isTauri()) return invoke<string>("ai_request_ws", { system, user });
  return browserAiWs(system, user);
}

/**
 * Map a stored model label / legacy id to a currently-valid Anthropic model id.
 * Mirrors `normalize_model()` in src-tauri/src/ai.rs — anything off the current
 * allow-list defaults to `claude-sonnet-4-6`, so the request can never 404 on
 * the model string alone.
 */
function normalizeModel(model: string): string {
  switch (model.trim().toLowerCase()) {
    case "claude-opus-4-6":
      return "claude-opus-4-6";
    case "claude-sonnet-4-6":
      return "claude-sonnet-4-6";
    case "claude-haiku-4-5-20251001":
      return "claude-haiku-4-5-20251001";
    default:
      return "claude-sonnet-4-6";
  }
}

/**
 * The Anthropic Messages API body: exactly `model`, `max_tokens`, top-level
 * `system`, and a `messages` array (user turn only). No other fields — a
 * top-level `user` field or a `system`-role message would be rejected.
 */
function aiBody(providerName: string, system: string, user: string): string {
  return JSON.stringify({
    model: normalizeModel(providerName),
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: user }],
  });
}

async function browserAiHttp(system: string, user: string): Promise<string> {
  const ai = browserVault.resolveAi();
  if (!ai || !ai.apiKey) throw new Error("No AI provider configured (unlock the vault).");
  const resp = await fetch(ai.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ai.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: aiBody(ai.providerName, system, user),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`AI provider returned HTTP ${resp.status}: ${text}`);
  return text;
}

async function browserAiWs(system: string, user: string): Promise<string> {
  const ai = browserVault.resolveAi();
  if (!ai || !ai.apiKey) throw new Error("No AI provider configured (unlock the vault).");
  // Browsers cannot set custom WebSocket headers; the key travels in the message.
  const payload = JSON.stringify({
    model: ai.providerName,
    apiKey: ai.apiKey,
    system,
    user,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(ai.endpoint);
    let collected = "";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("AI WebSocket timed out"));
    }, 30_000);
    ws.onopen = () => ws.send(payload);
    ws.onmessage = (ev) => {
      collected += typeof ev.data === "string" ? ev.data : "";
      try {
        JSON.parse(collected.trim());
        clearTimeout(timer);
        ws.close();
        resolve(collected);
      } catch {
        // keep collecting until a complete JSON payload arrives
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("AI WebSocket error"));
    };
    ws.onclose = () => {
      clearTimeout(timer);
      if (collected.trim()) resolve(collected);
      else reject(new Error("AI WebSocket returned no data"));
    };
  });
}

// ── Credential store backend ─────────────────────────────────────────────────
//
// Outside Tauri there is no OS keychain and no config file, so every one of
// these resolves to the browser vault. That keeps the browser build — and the
// component tests that run in jsdom — on a single code path instead of needing
// the selector flow stubbed at each call site.

/**
 * Which backend is active, or null on first launch.
 *
 * Null is what gates `CredentialStoreSelector`. The browser build reports
 * `app_vault` unconditionally: the browser vault *is* an app vault, so there is
 * no choice to present and no first-launch selection to make.
 */
export async function getStoreBackend(): Promise<StoreBackend | null> {
  if (!isTauri()) return "app_vault";
  return invoke<StoreBackend | null>("get_store_backend");
}

/**
 * Select a backend and persist the choice.
 *
 * Rejects with a `StoreBackendError` rather than a bare string, because the
 * caller has to distinguish "libsecret is missing, here is the command" from
 * every other failure. Tauri serializes the Rust error struct through as the
 * rejection value.
 */
export async function setStoreBackend(backend: StoreBackend): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_store_backend", { backend });
}

export async function checkOsKeychain(): Promise<OsKeychainStatus> {
  if (!isTauri()) return { available: false, installCommand: null };
  return invoke<OsKeychainStatus>("check_os_keychain");
}

/**
 * Copy every credential to the other backend and switch to it.
 *
 * Non-destructive — the source keeps its copy, so a migration into a store that
 * later proves unreadable is recoverable by switching back. Read `newBackend`
 * from the result rather than assuming the target took effect: a run with any
 * failure deliberately stays on the current backend.
 */
export async function migrateCredentials(target: StoreBackend): Promise<MigrateResult> {
  if (!isTauri()) {
    return { migrated: [], failed: [], newBackend: "app_vault" };
  }
  return invoke<MigrateResult>("migrate_credentials", { targetBackend: target });
}

/**
 * Masked presence check for one credential key.
 *
 * Returns a fixed bullet string when something is stored and null when nothing
 * is — never a truncation of the real value, since the leading characters of an
 * API key are a meaningful fraction of it.
 */
export async function getCredentialMasked(key: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("get_credential_masked", { key });
}

export async function setCredential(key: string, value: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_credential", { key, value });
}

export async function deleteCredential(key: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_credential", { key });
}

/** Narrow an unknown rejection to the structured backend error, if it is one. */
export function asStoreBackendError(e: unknown): StoreBackendError | null {
  if (typeof e === "object" && e !== null && "code" in e && "message" in e) {
    return e as StoreBackendError;
  }
  return null;
}
