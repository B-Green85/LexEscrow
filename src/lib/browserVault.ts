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
  BlockchainInput,
  BlockchainPublic,
  ClioConfigInput,
  ClioPublic,
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
interface ApifyStored {
  apiToken: string;
}
interface DocuSignStored {
  integrationKey: string;
  userId: string;
  accountId: string;
  baseUri: string;
  jwtPrivateKey: string;
  environment: string;
}
/** PracticePanther's webhook config. Clio no longer shares this shape — it
 *  moved to the OAuth registration below. */
interface WebhookStored {
  webhookUrl: string;
  matterId: string;
  apiKey: string;
}

/**
 * Clio Manage OAuth registration, mirroring the Rust `ClioConfig`.
 *
 * Every field is optional-with-a-default on read for the same reason the Rust
 * side gives them `#[serde(default)]`: a browser vault written under the old
 * placeholder shape must decrypt into "not connected" rather than throwing.
 */
interface ClioStored {
  appId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
}
/** Mirrors the Rust `BlockchainConfig`. Both secrets stay in this module. */
interface BlockchainStored {
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  deployerAddress: string;
  deployerPrivateKey: string;
  usdcAddress: string;
  forwarderAddress: string;
  networkName: string;
}
/**
 * Mirrors the Rust `DebugConsoleEntry`. The password is stored only as a
 * PBKDF2 verifier — the browser analogue of the backend's scrypt hash, exactly
 * as `deriveKey` is the analogue of its scrypt KDF. No plaintext, here either.
 */
interface DebugConsoleStored {
  operatorId: string;
  passwordHash: string;
}
interface VData {
  ai: AiStored | null;
  smtp: SmtpStored | null;
  twilio: TwilioStored | null;
  apify: ApifyStored | null;
  docusign: DocuSignStored | null;
  clio: ClioStored | null;
  practicePanther: WebhookStored | null;
  blockchain: BlockchainStored | null;
  debugConsole: DebugConsoleStored | null;
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
  return {
    ai: null,
    smtp: null,
    twilio: null,
    apify: null,
    docusign: null,
    clio: null,
    practicePanther: null,
    blockchain: null,
    debugConsole: null,
  };
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
    apify: data.apify ? { hasApiToken: data.apify.apiToken.length > 0 } : null,
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

export async function setApify(input: ApifyInput): Promise<void> {
  const s = requireUnlocked();
  const apiToken = input.apiToken && input.apiToken.length > 0 ? input.apiToken : (s.data.apify?.apiToken ?? "");
  s.data.apify = { apiToken: apiToken.trim() };
  await persist();
}

export async function deleteGroup(
  group: "ai" | "smtp" | "twilio" | "apify" | "docusign" | "clio" | "practicePanther" | "blockchain",
): Promise<void> {
  const s = requireUnlocked();
  s.data[group] = null;
  await persist();
}

// ── Blockchain settlement config ─────────────────────────────────────────────

/**
 * Confirm the submitted password is the one this vault is unlocked with.
 *
 * The Rust side compares derived keys directly; here the key is a
 * non-extractable `CryptoKey`, so there is nothing to compare. Re-deriving from
 * the stored salt and attempting a decrypt of the stored envelope reaches the
 * same conclusion by the same mechanism the vault already relies on — a wrong
 * password derives a wrong key and GCM authentication fails.
 */
async function verifyPassword(password: string): Promise<boolean> {
  const s = requireUnlocked();
  const raw = storeGet();
  if (raw === null) return false;
  try {
    const env = JSON.parse(raw) as { iv: string; data: string };
    const key = await deriveKey(password, s.salt);
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(env.iv) },
      key,
      unb64(env.data) as unknown as BufferSource,
    );
    return true;
  } catch {
    return false;
  }
}

/** Host portion of a URL — the API key lives in the path and must not escape. */
function hostOf(url: string): string {
  const afterScheme = url.includes("://") ? url.slice(url.indexOf("://") + 3) : url;
  return afterScheme.split(/[/?#]/)[0].trim();
}

/** Enough config to reach a chain. Signing is a separate question. */
function hasNetworkConfig(b: BlockchainStored | null): boolean {
  return !!b && b.rpcUrl.length > 0 && b.contractAddress.length > 0 && b.chainId !== 0;
}

/** Mirrors the Rust `set_blockchain`, password re-check included. */
export async function setBlockchain(password: string, input: BlockchainInput): Promise<void> {
  const s = requireUnlocked();
  if (!(await verifyPassword(password))) throw new Error("incorrect password");

  const prev = s.data.blockchain;
  const keep = (submitted: string, current: string | undefined): string =>
    submitted.trim().length > 0 ? submitted.trim() : (current ?? "");

  s.data.blockchain = {
    rpcUrl: keep(input.rpcUrl, prev?.rpcUrl),
    chainId: input.chainId,
    contractAddress: input.contractAddress.trim(),
    deployerAddress: input.deployerAddress.trim(),
    deployerPrivateKey: keep(input.deployerPrivateKey, prev?.deployerPrivateKey),
    usdcAddress: input.usdcAddress.trim(),
    forwarderAddress: input.forwarderAddress.trim(),
    networkName: input.networkName.trim(),
  };
  await persist();
}

export function getBlockchainPublic(): BlockchainPublic {
  const b = requireUnlocked().data.blockchain;
  if (!b) {
    return {
      hasConfig: false,
      networkName: "",
      chainId: 0,
      contractAddress: "",
      deployerAddress: "",
      usdcAddress: "",
      forwarderAddress: "",
      rpcUrlHint: "",
      hasPrivateKey: false,
    };
  }
  return {
    hasConfig: hasNetworkConfig(b),
    networkName: b.networkName,
    chainId: b.chainId,
    contractAddress: b.contractAddress,
    deployerAddress: b.deployerAddress,
    usdcAddress: b.usdcAddress,
    forwarderAddress: b.forwarderAddress,
    rpcUrlHint: hostOf(b.rpcUrl),
    hasPrivateKey: b.deployerPrivateKey.length > 0,
  };
}

/** Mirrors `VaultState::has_blockchain` — network config *and* a signing key. */
export function hasBlockchain(): boolean {
  const b = state?.data.blockchain ?? null;
  return hasNetworkConfig(b) && (b?.deployerPrivateKey.length ?? 0) > 0;
}

// ── Practice-management webhooks (spec §14 V1) ───────────────────────────────

/**
 * Store one vendor's webhook config.
 *
 * Mirrors the Rust `set_clio` / `set_practice_panther` exactly, including both
 * edit rules: a blank API key keeps the stored one, and a blank webhook URL
 * clears the entry rather than storing a half-configured one — so disabling an
 * integration does not leave its token behind.
 */
// PracticePanther only — Clio moved to the OAuth registration below and no
// longer shares this shape.
async function setWebhookGroup(
  group: "practicePanther",
  input: { webhookUrl: string; matterId?: string; apiKey?: string },
): Promise<void> {
  const s = requireUnlocked();
  const url = input.webhookUrl.trim();
  if (!url) {
    s.data[group] = null;
    await persist();
    return;
  }
  const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : (s.data[group]?.apiKey ?? "");
  s.data[group] = { webhookUrl: url, matterId: input.matterId?.trim() ?? "", apiKey };
  await persist();
}

function webhookPublic(stored: WebhookStored | null): PracticePantherPublic {
  if (!stored) return { webhookUrl: "", matterId: "", hasApiKey: false };
  return {
    webhookUrl: stored.webhookUrl,
    matterId: stored.matterId,
    hasApiKey: stored.apiKey.length > 0,
  };
}

// ── Clio Manage (OAuth 2.0) ──────────────────────────────────────────────────

const CLIO_DEFAULT_REDIRECT_URI = "http://127.0.0.1:8080/callback";

/**
 * A stored Clio group, normalised.
 *
 * The `?? ""` on every field is the stale-shape path: an install holding
 * `{webhookUrl, apiKey}` from before the OAuth migration reads through here as
 * an all-empty registration, which `hasCredentials` reports as "not connected".
 * No error, no crash, and the operator is prompted to connect — which is the
 * required behaviour.
 */
function clioStored(raw: Partial<ClioStored> | null | undefined): ClioStored | null {
  if (!raw) return null;
  return {
    appId: raw.appId ?? "",
    clientId: raw.clientId ?? "",
    clientSecret: raw.clientSecret ?? "",
    redirectUri: raw.redirectUri ?? "",
    accessToken: raw.accessToken ?? "",
    refreshToken: raw.refreshToken ?? "",
    tokenExpiresAt: raw.tokenExpiresAt ?? "",
  };
}

/**
 * Save the app registration. A blank client ID clears the entry — the delete
 * affordance, and what keeps a removed integration from leaving a refresh token
 * behind. Changing the client ID drops the token set, since a token belongs to
 * one OAuth client.
 */
export async function setClio(input: ClioConfigInput): Promise<void> {
  const s = requireUnlocked();
  const clientId = input.clientId.trim();
  if (!clientId) {
    s.data.clio = null;
    await persist();
    return;
  }
  const existing = clioStored(s.data.clio);
  const sameApp = existing?.clientId === clientId;
  s.data.clio = {
    appId: input.appId.trim(),
    clientId,
    clientSecret: input.clientSecret?.trim() || (existing?.clientSecret ?? ""),
    redirectUri: input.redirectUri?.trim() || existing?.redirectUri || CLIO_DEFAULT_REDIRECT_URI,
    accessToken: sameApp ? (existing?.accessToken ?? "") : "",
    refreshToken: sameApp ? (existing?.refreshToken ?? "") : "",
    tokenExpiresAt: sameApp ? (existing?.tokenExpiresAt ?? "") : "",
  };
  await persist();
}

export function getClioPublic(): ClioPublic {
  const c = clioStored(requireUnlocked().data.clio);
  const hasCredentials = Boolean(c && c.appId && c.clientId && c.clientSecret);
  return {
    appId: c?.appId ?? "",
    clientId: c?.clientId ?? "",
    redirectUri: c?.redirectUri ?? "",
    hasClientSecret: Boolean(c?.clientSecret),
    hasCredentials,
    connected: hasCredentials && Boolean(c?.refreshToken),
    tokenExpiresAt: c?.tokenExpiresAt ?? "",
  };
}

// ── LexTrace debug console ───────────────────────────────────────────────────
//
// Same contract as the Rust group, same posture: the password is hashed on the
// way in and never held. PBKDF2 stands in for scrypt for the same reason it
// does for the vault key itself — it is the KDF Web Crypto actually offers —
// and the format is self-describing so the two are never confused for each
// other.

const DEBUG_HASH_ITERATIONS = 200_000;

async function hashDebugPassword(password: string, salt: Uint8Array): Promise<string> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: DEBUG_HASH_ITERATIONS,
      hash: "SHA-256",
    },
    base,
    256,
  );
  return `pbkdf2$${DEBUG_HASH_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

/** Constant-time comparison, so a wrong password leaks nothing by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A blank password keeps the stored hash, matching the house rule everywhere
 * else — so the operator name can be corrected on its own.
 */
export async function setDebugConsole(input: DebugConsoleInput): Promise<void> {
  const { data } = requireUnlocked();
  const submitted = input.password?.trim() ?? "";
  const passwordHash = submitted
    ? await hashDebugPassword(submitted, crypto.getRandomValues(new Uint8Array(16)))
    : (data.debugConsole?.passwordHash ?? "");
  data.debugConsole = { operatorId: input.operatorId.trim(), passwordHash };
  await persist();
}

export function getDebugConsolePublic(): DebugConsolePublic {
  const entry = requireUnlocked().data.debugConsole;
  return {
    configured: Boolean(entry && entry.operatorId && entry.passwordHash),
    operatorId: entry?.operatorId ?? "",
  };
}

export function hasDebugConsole(): boolean {
  try {
    return getDebugConsolePublic().configured;
  } catch {
    // A locked vault is "not configured" as far as every caller is concerned.
    return false;
  }
}

/**
 * Check a submitted password. A locked vault, an unconfigured console and a
 * malformed stored hash are all `false` — the caller is a gate with one
 * decision to make.
 */
export async function verifyDebugConsole(password: string): Promise<boolean> {
  let entry: DebugConsoleStored | null;
  try {
    entry = requireUnlocked().data.debugConsole;
  } catch {
    return false;
  }
  if (!entry?.operatorId || !entry.passwordHash) return false;

  const parts = entry.passwordHash.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  try {
    salt = unb64(parts[2]);
  } catch {
    return false;
  }

  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    base,
    256,
  );
  return timingSafeEqual(b64(new Uint8Array(bits)), parts[3]);
}

export async function setPracticePanther(input: PracticePantherConfigInput): Promise<void> {
  await setWebhookGroup("practicePanther", input);
}

export function getPracticePantherPublic(): PracticePantherPublic {
  return webhookPublic(requireUnlocked().data.practicePanther);
}

/**
 * Full configs — API key included — for the browser-mode webhook transport.
 *
 * Only reachable outside Tauri. Under Tauri the key stays in the Rust vault and
 * the POST is made there (`integrations.rs`), which is why there is no
 * equivalent of this function on the IPC surface.
 */
export function resolveWebhookConfigs(): {
  practicePanther?: { webhookUrl: string; matterId?: string; apiKey?: string };
} {
  const data = state?.data;
  const project = (w: WebhookStored | null | undefined) =>
    w && w.webhookUrl
      ? {
          webhookUrl: w.webhookUrl,
          ...(w.matterId && { matterId: w.matterId }),
          ...(w.apiKey && { apiKey: w.apiKey }),
        }
      : undefined;
  // Clio is absent: its group is now an OAuth app registration with no webhook
  // URL and no API key, and the Clio Manage integration is read-only by
  // contract — there is nothing to deliver with, and nothing it may deliver.
  return {
    ...(project(data?.practicePanther) && { practicePanther: project(data?.practicePanther)! }),
  };
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
  if (!d) {
    return {
      hasCredentials: false,
      environment: "",
      accountIdHint: "",
      userId: "",
      accountId: "",
      baseUri: "",
      hasIntegrationKey: false,
      hasJwtPrivateKey: false,
    };
  }
  return {
    hasCredentials: usable(d),
    environment: d.environment,
    accountIdHint: d.accountId.length <= 4 ? d.accountId : d.accountId.slice(-4),
    // Addressing, not key material — echoed so an edit can start from what is
    // stored rather than from blanks.
    userId: d.userId,
    accountId: d.accountId,
    baseUri: d.baseUri,
    hasIntegrationKey: d.integrationKey.length > 0,
    hasJwtPrivateKey: d.jwtPrivateKey.length > 0,
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
