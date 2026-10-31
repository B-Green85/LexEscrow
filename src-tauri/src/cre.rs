// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

//! CRE workflow configuration — the vault-to-workflow seam.
//!
//! The Chainlink CRE workflow (`cre/main.ts`) is already fully config-driven:
//! it reads the receiver address, chain selector and gas limit from its
//! `Config` schema and hardcodes nothing. What it historically read that config
//! *from* was `cre/config.json` on disk, next to a `.env` holding the deployer
//! private key in plaintext — two files whose only protection was a `.gitignore`
//! entry.
//!
//! This module replaces that. The config is assembled from the vault at call
//! time and handed out in two deliberately different shapes:
//!
//!   * `CreConfig` — network settings and contract addresses. Safe to cross IPC
//!     to the WebView; every field is a public on-chain identifier or a chain
//!     selector, and the RPC URL is reduced to its host.
//!   * `resolve_signing_config` — the same settings *plus* the full RPC URL and
//!     the deployer private key. Never crosses IPC. Rust-side callers only.
//!
//! The split is the whole point: the renderer can render "settling against
//! 0x6f53…8674 on Ethereum Sepolia" without ever being in a position to sign.

use alloy::network::{EthereumWallet, TransactionBuilder};
use alloy::primitives::{Address, B256, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolCall;
use serde::Serialize;
use tauri::State;

use crate::credential_store::CredentialStoreState;
use crate::vault::BlockchainConfig;

/// Chain-selector names the CRE SDK understands, keyed by EIP-155 chain ID.
///
/// `getNetwork({ chainSelectorName })` in the workflow needs this name rather
/// than the numeric ID, so the mapping has to live somewhere. Here is better
/// than in the vault entry: it is a property of the SDK, not of the operator's
/// configuration, and storing it would mean a vault written today goes stale
/// when the SDK adds a network.
fn chain_selector_name(chain_id: u64) -> Option<&'static str> {
    match chain_id {
        1 => Some("ethereum-mainnet"),
        11155111 => Some("ethereum-testnet-sepolia"),
        _ => None,
    }
}

/// Is this chain a testnet? Drives the CRE SDK's `isTestnet` flag.
fn is_testnet(chain_id: u64) -> bool {
    chain_id != 1
}

/// Secret-free CRE configuration. Crosses IPC.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreConfig {
    pub rpc_url_hint: String, // host only — the API key stays in the backend
    pub contract_address: String,
    pub chain_id: u64,
    pub network_name: String,
    pub usdc_address: String,
    pub forwarder_address: String,
    pub chain_selector_name: String,
    pub is_testnet: bool,
}

/// Full configuration including the RPC credential and signing key.
///
/// Not `Serialize`, and that is not an oversight — the type has no derive that
/// would let it be returned from a `#[tauri::command]` even by accident.
pub struct CreSigningConfig {
    pub rpc_url: String,
    pub deployer_private_key: String,
    pub contract_address: String,
    pub chain_id: u64,
    pub chain_selector_name: String,
    pub is_testnet: bool,
}

/// Assemble the signing configuration for Rust-side use.
///
/// Returns `None` when the vault is locked or holds no blockchain entry, which
/// the caller must surface as "not configured" rather than falling back to an
/// environment variable. Falling back is what this module exists to end: a
/// silent `.env` fallback would mean a machine with a stale `contracts/.env`
/// settles against whatever that file happens to say, which is precisely the
/// failure mode the vault is supposed to remove.
pub fn resolve_signing_config(vault: &CredentialStoreState) -> Option<CreSigningConfig> {
    let c: BlockchainConfig = vault.resolve_blockchain()?;
    if c.rpc_url.is_empty() || c.contract_address.is_empty() || c.deployer_private_key.is_empty() {
        return None;
    }
    let selector = chain_selector_name(c.chain_id)?;
    Some(CreSigningConfig {
        rpc_url: c.rpc_url.clone(),
        deployer_private_key: c.deployer_private_key.clone(),
        contract_address: c.contract_address.clone(),
        chain_id: c.chain_id,
        chain_selector_name: selector.to_string(),
        is_testnet: is_testnet(c.chain_id),
    })
}

/// Secret-free CRE config for the renderer.
///
/// Errors rather than returning an empty shape when nothing is configured: the
/// caller is asking "what chain do I settle against", and an all-blank answer
/// invites a caller to proceed with empty addresses. The settle path gates on
/// `vault_has_blockchain` before it gets here.
#[tauri::command]
pub fn get_cre_config(vault: State<'_, CredentialStoreState>) -> Result<CreConfig, String> {
    let c = vault
        .resolve_blockchain()
        .ok_or_else(|| "Blockchain is not configured — set it up in Configuration.".to_string())?;

    let selector = chain_selector_name(c.chain_id).ok_or_else(|| {
        format!("Chain ID {} is not a network the CRE workflow supports.", c.chain_id)
    })?;

    Ok(CreConfig {
        rpc_url_hint: host_of(&c.rpc_url),
        contract_address: c.contract_address.clone(),
        chain_id: c.chain_id,
        network_name: c.network_name.clone(),
        usdc_address: c.usdc_address.clone(),
        forwarder_address: c.forwarder_address.clone(),
        chain_selector_name: selector.to_string(),
        is_testnet: is_testnet(c.chain_id),
    })
}

// ── Path A — on-chain DirectSettlement ───────────────────────────────────────

alloy::sol! {
    /// Path A entrypoint on RetainerRelease
    /// (contracts/src/RetainerRelease.sol:181). `onlyWorkflow` — the deployer
    /// key held in the credential store is the contract's `workflow` address
    /// (the constructor sets `workflow = msg.sender`; see
    /// contracts/DEPLOYMENT.md for the verified direct deployer call).
    function directSettle(
        address clientWallet,
        address firmWallet,
        uint256 clientAmountUsdc,
        uint256 firmAmountUsdc,
        bytes32 documentHash
    );
}

/// Outcome of a broadcast `directSettle` transaction. Every field is public
/// on-chain data, so the struct is safe to cross IPC — unlike
/// `CreSigningConfig`, which supplied the key that signed it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectSettleResult {
    /// The real transaction hash, `0x` + 64 hex chars, straight from the
    /// signed transaction the RPC accepted. Never fabricated: every failure
    /// path in `execute_direct_settle` returns `Err` instead.
    pub tx_hash: String,
    pub block_number: Option<u64>,
    pub gas_used: u64,
}

fn parse_address(value: &str, what: &str) -> Result<Address, String> {
    value
        .trim()
        .parse::<Address>()
        .map_err(|_| format!("{what} is not a valid Ethereum address."))
}

fn parse_amount(value: &str, what: &str) -> Result<U256, String> {
    value
        .trim()
        .parse::<U256>()
        .map_err(|_| format!("{what} is not a valid integer USDC amount."))
}

/// `sha256:<64 hex>` (ArtifactGuard's format), `0x<64 hex>`, or bare hex →
/// the `bytes32 documentHash` the contract anchors the settlement to.
pub(crate) fn parse_document_hash(value: &str) -> Result<B256, String> {
    let bare = value.trim();
    let bare = bare.strip_prefix("sha256:").unwrap_or(bare);
    let bare = bare.strip_prefix("0x").unwrap_or(bare);
    if bare.len() != 64 || !bare.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "Document hash is not a 32-byte hex digest ({} hex chars, need 64).",
            bare.len()
        ));
    }
    format!("0x{bare}")
        .parse::<B256>()
        .map_err(|_| "Document hash is not a 32-byte hex digest.".to_string())
}

/// Execute Path A for real: sign a `directSettle` transaction with the
/// vault-held deployer key, broadcast it through the configured RPC endpoint,
/// wait for the receipt, and return the actual transaction hash.
///
/// Amounts arrive as decimal strings of USDC base units (integer, 6 decimals)
/// — Tauri's JSON transport cannot carry bigint, and floats are banned from
/// settlement math everywhere in this application (spec: amounts are integer
/// base units on chain).
///
/// Every failure — locked store, malformed config, unreachable RPC, an
/// `onlyWorkflow` rejection, an underfunded escrow, an on-chain revert — comes
/// back as `Err`. There is no fabricated fallback hash: an error here means
/// the money did not move, and the caller must say so.
#[tauri::command]
pub async fn execute_direct_settle(
    vault: State<'_, CredentialStoreState>,
    client_wallet: String,
    firm_wallet: String,
    client_amount_usdc: String,
    firm_amount_usdc: String,
    document_hash: String,
) -> Result<DirectSettleResult, String> {
    // Assembled fresh from the credential store at call time — the same "no
    // silent .env fallback" contract `resolve_signing_config` documents.
    let cfg = resolve_signing_config(&vault).ok_or_else(|| {
        "Blockchain signing is not configured — unlock the credential store and set the RPC URL, \
         contract address and deployer key in Configuration."
            .to_string()
    })?;

    let client = parse_address(&client_wallet, "Client wallet")?;
    let firm = parse_address(&firm_wallet, "Firm wallet")?;
    let contract = parse_address(&cfg.contract_address, "Configured contract address")?;
    let client_amount = parse_amount(&client_amount_usdc, "Client amount")?;
    let firm_amount = parse_amount(&firm_amount_usdc, "Firm amount")?;
    let doc_hash = parse_document_hash(&document_hash)?;

    let signer: PrivateKeySigner = cfg
        .deployer_private_key
        .trim()
        .parse()
        .map_err(|_| "The stored deployer private key is not a valid secp256k1 key.".to_string())?;

    // EIP-1559 fees, nonce and gas come from the provider's recommended
    // fillers; the wallet layer signs. Nothing here is hand-rolled.
    let provider = ProviderBuilder::new()
        .wallet(EthereumWallet::from(signer))
        .connect(cfg.rpc_url.trim())
        .await
        .map_err(|e| format!("Could not reach the configured RPC endpoint: {e}"))?;

    let calldata = directSettleCall {
        clientWallet: client,
        firmWallet: firm,
        clientAmountUsdc: client_amount,
        firmAmountUsdc: firm_amount,
        documentHash: doc_hash,
    }
    .abi_encode();

    let tx = TransactionRequest::default()
        .with_to(contract)
        .with_chain_id(cfg.chain_id)
        .with_input(calldata);

    // Gas estimation dry-runs the call first, so an `onlyWorkflow` rejection
    // or an underfunded escrow fails here — before anything is broadcast —
    // with the node's revert reason attached.
    let pending = provider
        .send_transaction(tx)
        .await
        .map_err(|e| format!("Settlement transaction was rejected: {e}"))?;

    let tx_hash = format!("{:#x}", *pending.tx_hash());

    let receipt = pending
        .with_timeout(Some(std::time::Duration::from_secs(180)))
        .get_receipt()
        .await
        .map_err(|e| {
            format!("Transaction {tx_hash} was broadcast but not confirmed within 180s: {e}")
        })?;

    if !receipt.status() {
        return Err(format!(
            "Transaction {tx_hash} reverted on-chain — the escrow was not settled."
        ));
    }

    Ok(DirectSettleResult {
        tx_hash: format!("{:#x}", receipt.transaction_hash),
        block_number: receipt.block_number,
        gas_used: receipt.gas_used,
    })
}

// ── USDC/USD price feed — Chainlink Data Feed, read-only ─────────────────────

alloy::sol! {
    /// Chainlink AggregatorV3Interface — the read behind the UI's
    /// "Converting USD → USDC" conversion-rate label.
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// Chainlink's USDC/USD aggregator proxy on Ethereum mainnet (8 decimals).
///
/// Mainnet regardless of which chain settlement runs on: the USD price of
/// USDC is a property of the asset, and the mainnet feed is the canonical,
/// deepest-liquidity source. The call is a plain `eth_call` — no signing, no
/// credential-store involvement, nothing broadcast.
const USDC_USD_FEED: &str = "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6";

/// Public, keyless mainnet RPC endpoints, tried in order.
const MAINNET_RPC_URLS: [&str; 2] =
    ["https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com"];

/// The feed's heartbeat is 24h — an answer older than that means the feed is
/// stalled, and a stalled price is treated as no price at all.
const MAX_FEED_AGE_SECS: u64 = 86_400;

/// Live USDC/USD rate. Public market data throughout — safe to cross IPC.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsdcPrice {
    /// USD per 1 USDC as a decimal string (e.g. "0.99987") — the feed's
    /// 8-decimal answer with trailing zeros trimmed. A string because this is
    /// display data: settlement math never touches it.
    pub price: String,
    /// Unix seconds of the feed's last on-chain update, from `latestRoundData`.
    pub updated_at: u64,
}

/// 8-decimal fixed-point integer → decimal string, trailing zeros trimmed
/// ("99987000" → "0.99987", "100000000" → "1").
fn format_price_e8(raw: u128) -> String {
    let mut s = format!("{}.{:08}", raw / 100_000_000, raw % 100_000_000);
    while s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    s
}

async fn fetch_usdc_price(rpc_url: &str) -> Result<UsdcPrice, String> {
    let feed = parse_address(USDC_USD_FEED, "USDC/USD feed address")?;

    let provider = ProviderBuilder::new()
        .connect(rpc_url)
        .await
        .map_err(|e| format!("RPC unreachable: {e}"))?;

    let tx = TransactionRequest::default()
        .with_to(feed)
        .with_input(latestRoundDataCall {}.abi_encode());

    let bytes = provider.call(tx).await.map_err(|e| format!("eth_call failed: {e}"))?;

    let r = latestRoundDataCall::abi_decode_returns(&bytes)
        .map_err(|e| format!("feed returned undecodable data: {e}"))?;

    if r.answer.is_negative() || r.answer.is_zero() {
        return Err(format!("feed answered a non-positive price ({})", r.answer));
    }

    let updated_at: u64 = r
        .updatedAt
        .try_into()
        .map_err(|_| "feed updatedAt does not fit in u64".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch".to_string())?
        .as_secs();
    let age = now.saturating_sub(updated_at);
    if age > MAX_FEED_AGE_SECS {
        return Err(format!("feed is stale — last updated {age}s ago (limit {MAX_FEED_AGE_SECS}s)"));
    }

    // Non-negative was checked above, so the raw two's-complement value is the
    // magnitude; anything that overflows u128 is not a price.
    let raw: u128 = r
        .answer
        .into_raw()
        .try_into()
        .map_err(|_| "feed answer is implausibly large".to_string())?;

    Ok(UsdcPrice { price: format_price_e8(raw), updated_at })
}

/// Live USDC/USD rate from Chainlink's mainnet Data Feed via read-only
/// `eth_call` — no signing key and no stored credential required.
///
/// Every failure — RPC unreachable, undecodable return data, a non-positive
/// answer, a round older than the feed's 24h heartbeat — comes back as `Err`.
/// There is no fabricated fallback rate: the UI's contract is that a number
/// shown next to "Chainlink Price Feed" actually came from the feed, and an
/// error here renders as no number at all.
#[tauri::command]
pub async fn get_usdc_price() -> Result<UsdcPrice, String> {
    let mut last_err = String::from("no RPC endpoints configured");
    for url in MAINNET_RPC_URLS {
        match fetch_usdc_price(url).await {
            Ok(price) => return Ok(price),
            Err(e) => last_err = format!("{}: {e}", host_of(url)),
        }
    }
    Err(format!("USDC/USD price feed unavailable — {last_err}"))
}

/// Host portion of a URL. Mirrors `vault::url_host`, which is private to that
/// module; duplicated rather than made public because widening the visibility
/// of a redaction helper invites it to be used somewhere it is not the right
/// redaction.
fn host_of(url: &str) -> String {
    let after_scheme = match url.split_once("://") {
        Some((_, rest)) => rest,
        None => url,
    };
    after_scheme.split(['/', '?', '#']).next().unwrap_or("").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_names_match_the_cre_sdk_vocabulary() {
        assert_eq!(chain_selector_name(11155111), Some("ethereum-testnet-sepolia"));
        assert_eq!(chain_selector_name(1), Some("ethereum-mainnet"));
        assert_eq!(chain_selector_name(999999), None);
        assert!(is_testnet(11155111));
        assert!(!is_testnet(1));
    }

    #[test]
    fn price_formatting_trims_trailing_zeros() {
        assert_eq!(format_price_e8(99_987_000), "0.99987");
        assert_eq!(format_price_e8(99_991_656), "0.99991656");
        assert_eq!(format_price_e8(100_000_000), "1");
        assert_eq!(format_price_e8(100_013_000), "1.00013");
    }

    #[test]
    fn host_of_drops_the_rpc_api_key() {
        assert_eq!(host_of("https://eth-sepolia.g.alchemy.com/v2/KEY"), "eth-sepolia.g.alchemy.com");
        assert_eq!(host_of("http://127.0.0.1:8545"), "127.0.0.1:8545");
    }
}
