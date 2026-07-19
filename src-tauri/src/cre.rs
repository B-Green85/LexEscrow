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

use serde::Serialize;
use tauri::State;

use crate::vault::{BlockchainConfig, VaultState};

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
pub fn resolve_signing_config(vault: &VaultState) -> Option<CreSigningConfig> {
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
pub fn get_cre_config(vault: State<'_, VaultState>) -> Result<CreConfig, String> {
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
    fn host_of_drops_the_rpc_api_key() {
        assert_eq!(host_of("https://eth-sepolia.g.alchemy.com/v2/KEY"), "eth-sepolia.g.alchemy.com");
        assert_eq!(host_of("http://127.0.0.1:8545"), "127.0.0.1:8545");
    }
}
