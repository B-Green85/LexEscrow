/**
 * Browser-fallback credential vault (used outside Tauri).
 *
 * Mirrors the Rust vault's contract and security posture with Web Crypto:
 * PBKDF2 key derivation (the browser analogue of scrypt) + AES-256-GCM, wrong
 * password detected by GCM authentication failure on decrypt, secrets held in
 * memory only and never returned to the UI. The encrypted envelope persists to
 * localStorage (or an in-memory store when localStorage is unavailable, e.g.
 * headless tests). Plaintext is never written.
 */

import type {
  AiInput,
  AiSecret,
  DocuSignInput,
  DocuSignPublic,
  SmtpInput,
  TwilioInput,
  UnlockResult,
  VaultPublic,
  VaultStatus,
} from "./vaultTypes";

interface AiStored {
  providerName: string;
  endpoint: string;
  connectionType: "http" | "websocket";
  apiKey: string;
}
interface SmtpStored {
  host: string;
  port: number;
  username: string;
  password: string;
}
interface TwilioStored {
  accountSid: string;
  fromNumber: string;
  authToken: string;
}
interface DocuSignStored {
  integrationKey: string;
  userId: string;
  accountId: string;
  baseUri: string;
  jwtPrivateKey: string;
  environment: string;
}
interface VData {
  ai: AiStored | null;
  smtp: SmtpStored | null;
  twilio: TwilioStored | null;
  docusign: DocuSignStored | null;
}

const STORAGE_KEY = "lexescrow.vault";
const enc = new TextEncoder();
const dec = new TextDecoder();

// localStorage when available; otherwise an in-memory cell.
const memCell: { v: string | null } = { v: null };
function storeGet(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return memCell.v;
  }
}
function storeSet(v: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    memCell.v = v;
  }
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: 200_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

let state: { data: VData; key: CryptoKey; salt: Uint8Array } | null = null;

function emptyData(): VData {
  return { ai: null, smtp: null, twilio: null, docusign: null };
}

/** A vault written before a group existed decrypts without that key — fill in
 *  the missing slots so callers never read `undefined`. */
function hydrate(raw: Partial<VData>): VData {
  return { ...emptyData(), ...raw };
}

async function persist(): Promise<void> {
  if (!state) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, state.key, enc.encode(JSON.stringify(state.data))),
  );
  storeSet(
    JSON.stringify({ v: 1, kdf: "pbkdf2", salt: b64(state.salt), iv: b64(iv), data: b64(ct) }),
  );
}

export function status(): VaultStatus {
  return { exists: storeGet() !== null, unlocked: state !== null };
}

export async function unlock(password: string): Promise<UnlockResult> {
  if (!password) return { ok: false, created: false, reason: "error", message: "Password is required." };
  const raw = storeGet();

  if (raw === null) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    state = { data: emptyData(), key, salt };
    await persist();
    return { ok: true, created: true };
  }

  let env: { salt: string; iv: string; data: string };
  try {
    env = JSON.parse(raw);
  } catch {
    return { ok: false, created: false, reason: "corrupt", message: "Vault file is unreadable." };
  }
  const salt = unb64(env.salt);
  const iv = unb64(env.iv);
  const ct = unb64(env.data);
  const key = await deriveKey(password, salt);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct as unknown as BufferSource);
    state = { data: hydrate(JSON.parse(dec.decode(pt)) as Partial<VData>), key, salt };
    return { ok: true, created: false };
  } catch {
    return { ok: false, created: false, reason: "wrong_password", message: "Incorrect password." };
  }
}

export function lock(): void {
  state = null;
}

function requireUnlocked(): { data: VData; key: CryptoKey; salt: Uint8Array } {
  if (!state) throw new Error("Vault is locked.");
  return state;
}

export function getPublic(): VaultPublic {
  const { data } = requireUnlocked();
  return {
    ai: data.ai
      ? {
          providerName: data.ai.providerName,
          endpoint: data.ai.endpoint,
          connectionType: data.ai.connectionType,
          hasApiKey: data.ai.apiKey.length > 0,
        }
      : null,
    smtp: data.smtp
      ? { host: data.smtp.host, port: data.smtp.port, username: data.smtp.username, hasPassword: data.smtp.password.length > 0 }
      : null,
    twilio: data.twilio
      ? { accountSid: data.twilio.accountSid, fromNumber: data.twilio.fromNumber, hasAuthToken: data.twilio.authToken.length > 0 }
      : null,
  };
}

export async function setAi(input: AiInput): Promise<void> {
  const s = requireUnlocked();
  const apiKey = input.apiKey && input.apiKey.length > 0 ? input.apiKey : (s.data.ai?.apiKey ?? "");
  s.data.ai = {
    providerName: input.providerName.trim(),
    endpoint: input.endpoint.trim(),
    connectionType: input.connectionType,
    apiKey,
  };
  await persist();
}

export async function setSmtp(input: SmtpInput): Promise<void> {
  const s = requireUnlocked();
  const password = input.password && input.password.length > 0 ? input.password : (s.data.smtp?.password ?? "");
  s.data.smtp = { host: input.host.trim(), port: input.port, username: input.username.trim(), password };
  await persist();
}

export async function setTwilio(input: TwilioInput): Promise<void> {
  const s = requireUnlocked();
  const authToken = input.authToken && input.authToken.length > 0 ? input.authToken : (s.data.twilio?.authToken ?? "");
  s.data.twilio = { accountSid: input.accountSid.trim(), fromNumber: input.fromNumber.trim(), authToken };
  await persist();
}

export async function deleteGroup(group: "ai" | "smtp" | "twilio" | "docusign"): Promise<void> {
  const s = requireUnlocked();
  s.data[group] = null;
  await persist();
}

// ── DocuSign (spec §24) ──────────────────────────────────────────────────────

/** Configured means it could actually authenticate — metadata alone is not a
 *  usable credential. Mirrors `VaultState::has_docusign` in vault.rs. */
function usable(d: DocuSignStored | null): boolean {
  return !!d && !!d.integrationKey && !!d.jwtPrivateKey && !!d.accountId;
}

export async function setDocusign(input: DocuSignInput): Promise<void> {
  const s = requireUnlocked();
  const prev = s.data.docusign;
  // Blank secret on edit keeps the stored one (same rule as AI/SMTP).
  const keep = (submitted: string, current: string | undefined) =>
    submitted.length > 0 ? submitted : (current ?? "");
  s.data.docusign = {
    integrationKey: keep(input.integrationKey.trim(), prev?.integrationKey),
    userId: input.userId.trim(),
    accountId: input.accountId.trim(),
    baseUri: input.baseUri.trim().replace(/\/+$/, ""),
    jwtPrivateKey: keep(input.jwtPrivateKey.trim(), prev?.jwtPrivateKey),
    environment: input.environment.trim(),
  };
  await persist();
}

export function getDocusignPublic(): DocuSignPublic {
  const { data } = requireUnlocked();
  const d = data.docusign;
  if (!d) return { hasCredentials: false, environment: "", accountIdHint: "" };
  return {
    hasCredentials: usable(d),
    environment: d.environment,
    accountIdHint: d.accountId.length <= 4 ? d.accountId : d.accountId.slice(-4),
  };
}

/** Presence flag. A locked vault reports `false` rather than throwing — the
 *  provider resolver treats "not available" and "not configured" alike. */
export function hasDocusign(): boolean {
  return usable(state?.data.docusign ?? null);
}

export async function changePassword(current: string, next: string): Promise<void> {
  const s = requireUnlocked();
  if (!next) throw new Error("New password is required.");
  const raw = storeGet();
  if (raw) {
    const env = JSON.parse(raw) as { salt: string; iv: string; data: string };
    const candidate = await deriveKey(current, unb64(env.salt));
    try {
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(env.iv) },
        candidate,
        unb64(env.data) as unknown as BufferSource,
      );
    } catch {
      throw new Error("Current password is incorrect.");
    }
  }
  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  state = { data: s.data, key: await deriveKey(next, newSalt), salt: newSalt };
  await persist();
}

/** Secret AI credential for the browser AI transport (never leaves this module in Tauri mode). */
export function resolveAi(): AiSecret | null {
  return state?.data.ai
    ? {
        providerName: state.data.ai.providerName,
        endpoint: state.data.ai.endpoint,
        connectionType: state.data.ai.connectionType,
        apiKey: state.data.ai.apiKey,
      }
    : null;
}
