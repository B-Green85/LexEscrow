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
import type {
  AiInput,
  SmtpInput,
  TwilioInput,
  UnlockResult,
  VaultPublic,
  VaultStatus,
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

export async function vaultDelete(group: "ai" | "smtp" | "twilio"): Promise<void> {
  if (isTauri()) {
    await invoke("vault_delete", { group });
    return;
  }
  await browserVault.deleteGroup(group);
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

function aiBody(providerName: string, system: string, user: string): string {
  return JSON.stringify({
    model: providerName,
    system,
    user,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
}

async function browserAiHttp(system: string, user: string): Promise<string> {
  const ai = browserVault.resolveAi();
  if (!ai || !ai.apiKey) throw new Error("No AI provider configured (unlock the vault).");
  const resp = await fetch(ai.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ai.apiKey}`, "x-api-key": ai.apiKey },
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
