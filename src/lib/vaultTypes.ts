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
 * DocuSign's public view is narrower than the others: no integration key, no
 * user ID, and the account ID reduced to its last four characters. Everything
 * an operator needs to confirm the right account is wired up, nothing that
 * helps an attacker (spec §24).
 */
export interface DocuSignPublic {
  hasCredentials: boolean;
  environment: string;
  accountIdHint: string;
}

export interface VaultPublic {
  ai: AiPublic | null;
  smtp: SmtpPublic | null;
  twilio: TwilioPublic | null;
}

/**
 * Practice-management webhook public views (spec §14 V1).
 *
 * The webhook URL and matter ID are shown in full — they are addressing
 * information the operator typed and needs to confirm — while the API key is a
 * bearer token for a firm's matter data and is reduced to a presence flag, as
 * every other secret in the vault is.
 */
export interface ClioPublic {
  webhookUrl: string;
  matterId: string;
  hasApiKey: boolean;
}

export interface PracticePantherPublic {
  webhookUrl: string;
  matterId: string;
  hasApiKey: boolean;
}

/** Setter payload — a blank `apiKey` keeps the stored one, as elsewhere. A
 *  blank `webhookUrl` clears the entry, which is how the UI disables it. */
export interface ClioConfigInput {
  webhookUrl: string;
  matterId?: string;
  apiKey?: string;
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
