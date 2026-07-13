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
}

export interface PayloadCentsRow {
  payloadId: string;
  sessionId: string;
  totalHeldCents: number;
  earnedFeesCents: number;
  unearnedBalanceCents: number;
  disputedHours: number;
  disputedAmountCents: number;
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

export async function createSession(session: NewSession): Promise<void> {
  if (isTauri()) return invoke<void>("create_session", { session });
  // browser: nothing to persist
}

export async function updateSessionState(sessionId: string, newState: string): Promise<void> {
  if (isTauri()) return invoke<void>("update_session_state", { sessionId, newState });
}

export async function setExecutionPath(sessionId: string, path: string): Promise<void> {
  if (isTauri()) return invoke<void>("set_execution_path", { sessionId, path });
}

export async function savePayload(payload: PayloadCentsRow): Promise<void> {
  if (isTauri()) return invoke<void>("save_payload", { payload });
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
