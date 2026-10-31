// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Shared vault types. The `*Public` shapes are the only credential data that
 * crosses IPC to the WebView — secrets (api_key, password, auth_token) are
 * replaced by `has*` presence flags. Inputs carry an optional secret; omitting
 * it on edit keeps the existing one.
 */

export type ConnectionType = "http" | "websocket";

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

export interface UnlockResult {
  ok: boolean;
  created: boolean;
  reason?: string;
  message?: string;
}

export interface AiPublic {
  providerName: string;
  endpoint: string;
  connectionType: ConnectionType;
  hasApiKey: boolean;
}

export interface SmtpPublic {
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
}

export interface TwilioPublic {
  accountSid: string;
  fromNumber: string;
  hasAuthToken: boolean;
}

/**
 * Apify's public view — backs attorney bar verification.
 *
 * The token is the entire credential, so presence is the only thing there is to
 * report. There is no addressing field to echo back: the actor is pinned in
 * code, and what varies per install is only who is paying for the run.
 */
export interface ApifyPublic {
  hasApiToken: boolean;
}

/**
 * DocuSign's public view (spec §24).
 *
 * The two credentials — the integration key and the RSA PEM — never cross IPC
 * and are reduced to presence flags, as every other secret in the vault is. The
 * addressing fields are echoed in full for the same reason Clio's webhook URL
 * is: the operator typed them, needs to confirm them, and must be able to
 * correct one without re-entering the whole credential. Without them an edit
 * starts blank and overwrites what is stored with whatever was retyped.
 *
 * `accountIdHint` stays alongside the full `accountId` because the collapsed
 * summary still masks the account down to its last four characters — the edit
 * form is where the full value is needed.
 */
export interface DocuSignPublic {
  hasCredentials: boolean;
  environment: string;
  accountIdHint: string;
  userId: string;
  accountId: string;
  baseUri: string;
  hasIntegrationKey: boolean;
  hasJwtPrivateKey: boolean;
}

export interface VaultPublic {
  ai: AiPublic | null;
  smtp: SmtpPublic | null;
  twilio: TwilioPublic | null;
  apify: ApifyPublic | null;
}

/**
 * Clio Manage OAuth registration — public view.
 *
 * The app registration fields cross in full: the operator typed them into the
 * Clio Developer Portal and needs to confirm them here, and `redirectUri` in
 * particular has to match the Portal exactly, so hiding it would make the
 * commonest setup failure undiagnosable. The client secret and both tokens are
 * reduced to flags.
 *
 * `hasCredentials` and `connected` answer different questions and the
 * Configuration screen needs both: the first is "this install could start an
 * OAuth flow", the second is "this install holds a token set". An app registered
 * but never authorised is the first true and the second false.
 *
 * An install still holding the pre-OAuth placeholder shape reads as all-empty
 * and both-false — the required "prompt them to connect" state, reached without
 * an error path.
 */
export interface ClioPublic {
  appId: string;
  clientId: string;
  redirectUri: string;
  hasClientSecret: boolean;
  hasCredentials: boolean;
  connected: boolean;
  /** ISO-8601, or empty when no token has been issued. */
  tokenExpiresAt: string;
}

export interface PracticePantherPublic {
  webhookUrl: string;
  matterId: string;
  hasApiKey: boolean;
}

/**
 * Clio app-registration payload.
 *
 * The three app fields only — tokens are written by the OAuth exchange in the
 * backend and never submitted from here. A blank `clientSecret` keeps the
 * stored one; a blank `clientId` clears the whole registration.
 */
export interface ClioConfigInput {
  appId: string;
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
}

/** What `clio_check_connection` reports after validating the token upstream. */
export interface ClioConnectionStatus {
  connected: boolean;
  expiresAt: string | null;
  firmName: string | null;
}

export interface PracticePantherConfigInput {
  webhookUrl: string;
  matterId?: string;
  apiKey?: string;
}

/**
 * Blockchain settlement config — public view.
 *
 * Addresses are echoed in full because they are public on-chain identifiers;
 * the operator needs to confirm which contract this install settles against.
 * The two values that are *not* public are handled differently from each
 * other: `deployerPrivateKey` is reduced to `hasPrivateKey`, and the RPC URL to
 * `rpcUrlHint` (its host), because providers put the API key in the URL path.
 *
 * `hasConfig` means "there is enough here to reach a chain". It does **not**
 * mean settlement can proceed — that also needs a signing key, which is what
 * `hasBlockchain()` reports and what the settle gate uses.
 */
export interface BlockchainPublic {
  hasConfig: boolean;
  networkName: string;
  chainId: number;
  contractAddress: string;
  deployerAddress: string;
  usdcAddress: string;
  forwarderAddress: string;
  rpcUrlHint: string;
  hasPrivateKey: boolean;
}

/**
 * Blockchain setter payload. `rpcUrl` and `deployerPrivateKey` follow the house
 * rule — blank on edit keeps what is stored — so correcting a mistyped address
 * never requires re-pasting a key that can move funds.
 */
export interface BlockchainInput {
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
 * CRE workflow configuration, assembled from the vault (`cre.rs`).
 *
 * The secret-free half of what the workflow needs. The RPC credential and the
 * deployer key stay in Rust — see `resolve_signing_config`.
 */
export interface CreConfig {
  rpcUrlHint: string;
  contractAddress: string;
  chainId: number;
  networkName: string;
  usdcAddress: string;
  forwarderAddress: string;
  chainSelectorName: string;
  isTestnet: boolean;
}

export interface AiInput {
  providerName: string;
  endpoint: string;
  connectionType: ConnectionType;
  apiKey?: string;
}

export interface SmtpInput {
  host: string;
  port: number;
  username: string;
  password?: string;
}

export interface TwilioInput {
  accountSid: string;
  fromNumber: string;
  authToken?: string;
}

/** A blank `apiToken` keeps the stored one, as elsewhere. */
export interface ApifyInput {
  apiToken?: string;
}

/**
 * DocuSign setter payload — every field is a string because the whole entry is
 * secret-bearing. Submitting `integrationKey` or `jwtPrivateKey` blank keeps
 * whatever is already stored, matching the other groups' edit semantics.
 */
export interface DocuSignInput {
  integrationKey: string;
  userId: string;
  accountId: string;
  baseUri: string;
  jwtPrivateKey: string;
  environment: string;
}

/** Secret-bearing AI credential — only ever lives in the backend / browser vault. */
export interface AiSecret {
  providerName: string;
  endpoint: string;
  connectionType: ConnectionType;
  apiKey: string;
}

// ── Credential store backend selection ───────────────────────────────────────

/**
 * Which store holds this install's credentials.
 *
 * The wire form matches the Rust `StoreBackend` enum and the on-disk config
 * file, so the string in `lexescrow_store_config.json`, the one crossing IPC,
 * and the one branched on here are all the same string.
 */
export type StoreBackend = "os_keychain" | "app_vault";

/** Display name for a backend. The only place these two strings are spelled. */
export const BACKEND_LABEL: Record<StoreBackend, string> = {
  os_keychain: "OS Keychain",
  app_vault: "App Vault",
};

/**
 * A failed backend switch.
 *
 * `code` is the machine token; `LIBSECRET_NOT_FOUND` is the only one the UI
 * treats specially, because it is the sole failure the operator can fix
 * themselves — hence `installCommand`, which is null when the distro was not
 * recognised (a wrong `sudo` line being worse than none).
 */
export interface StoreBackendError {
  code: "LIBSECRET_NOT_FOUND" | "UNKNOWN_BACKEND" | "OS_ERROR" | "VAULT_ERROR" | "NOT_FOUND" | "IO_ERROR";
  message: string;
  installCommand: string | null;
}

export interface OsKeychainStatus {
  available: boolean;
  installCommand: string | null;
}

/**
 * Outcome of a backend migration.
 *
 * `newBackend` is authoritative rather than assumed: a run with any failure
 * deliberately does *not* switch, and reports the backend still in use, so the
 * caller must read this instead of assuming the target took effect.
 */
export interface MigrateResult {
  migrated: string[];
  failed: string[];
  newBackend: StoreBackend;
}

/**
 * LexTrace debug-console credentials — public view.
 *
 * The odd group out: every other entry stores a credential the app presents to
 * a third party, so its metadata is echoed back for editing. This one stores a
 * verifier, so there is nothing to echo — `configured` is the whole of what the
 * password contributes to this shape.
 *
 * `operatorId` crosses in full because it is not a secret at all: it is the
 * name printed in the panel header and written against every line in
 * `debug_audit_trail`.
 */
export interface DebugConsolePublic {
  configured: boolean;
  operatorId: string;
}

/** Setter payload — a blank `password` keeps the stored hash, as elsewhere. */
export interface DebugConsoleInput {
  operatorId: string;
  password?: string;
}

/** Human-readable name per credential key, for migration results. */
export const CREDENTIAL_LABEL: Record<string, string> = {
  ai: "AI provider",
  smtp: "SMTP",
  twilio: "Twilio",
  docusign: "DocuSign",
  clio: "Clio Manage",
  "practice-panther": "PracticePanther",
  apify: "Apify bar verification",
  blockchain: "Settlement",
  "debug-console": "LexTrace debug console",
  "hmac-vault-key": "AnchorReceipt seal key",
};
