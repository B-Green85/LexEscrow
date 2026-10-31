// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

//! AnchorReceipt on-chain registration (spec §8, step 3) — real, not mocked.
//!
//! Anchors a document's SHA-256 fingerprint in `AnchorRegistry`
//! (`contracts/src/AnchorRegistry.sol`) by calling `anchor(bytes32)`. The
//! registry is permissionless and keeps the *first* anchoring timestamp, so
//! re-registering a document is harmless: it costs gas and emits a fresh
//! `Anchored` event, but never moves the provenance date later.
//!
//! Signing material comes from the same place Path A settlement takes it —
//! `cre::resolve_signing_config`, i.e. the unlocked credential store (RPC URL,
//! deployer key, chain ID). Only the registry *address* is read from the
//! environment (`ANCHOR_REGISTRY_ADDRESS`): it is a public on-chain identifier,
//! not a secret, and the vault's blockchain entry has no slot for it yet.

use alloy::network::{EthereumWallet, TransactionBuilder};
use alloy::primitives::{Address, B256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolCall;
use tauri::State;

use crate::cre::{parse_document_hash, resolve_signing_config};
use crate::credential_store::CredentialStoreState;

alloy::sol! {
    /// AnchorRegistry — the one write this module makes.
    function anchor(bytes32 documentHash) external;
}

/// Env var naming the deployed AnchorRegistry (see `contracts/DEPLOYMENT.md`).
pub const REGISTRY_ENV: &str = "ANCHOR_REGISTRY_ADDRESS";

/// How long to wait for the anchoring transaction to be mined. A receipt only
/// claims `registered` once the hash is actually on-chain, so this waits for
/// inclusion rather than returning on broadcast.
const CONFIRM_TIMEOUT_SECS: u64 = 180;

fn registry_address() -> Result<Address, String> {
    let raw = std::env::var(REGISTRY_ENV).map_err(|_| {
        format!("AnchorRegistry is not configured — set {REGISTRY_ENV} in .env.")
    })?;
    raw.trim()
        .parse::<Address>()
        .map_err(|_| format!("{REGISTRY_ENV} is not a valid address: {raw:?}"))
}

/// Sign, broadcast and confirm `anchor(documentHash)`; returns the tx hash.
///
/// Separated from the Tauri command so it can be exercised live without a
/// credential store (see the ignored test below).
async fn anchor_with(
    rpc_url: &str,
    private_key: &str,
    chain_id: u64,
    registry: Address,
    document_hash: B256,
) -> Result<String, String> {
    let signer: PrivateKeySigner = private_key
        .trim()
        .parse()
        .map_err(|_| "The stored deployer private key is not a valid secp256k1 key.".to_string())?;

    let provider = ProviderBuilder::new()
        .wallet(EthereumWallet::from(signer))
        .connect(rpc_url.trim())
        .await
        .map_err(|e| format!("Could not reach the configured RPC endpoint: {e}"))?;

    let tx = TransactionRequest::default()
        .with_to(registry)
        .with_chain_id(chain_id)
        .with_input(anchorCall { documentHash: document_hash }.abi_encode());

    let pending = provider
        .send_transaction(tx)
        .await
        .map_err(|e| format!("Anchoring transaction was rejected: {e}"))?;

    let tx_hash = format!("{:#x}", *pending.tx_hash());

    let receipt = pending
        .with_timeout(Some(std::time::Duration::from_secs(CONFIRM_TIMEOUT_SECS)))
        .get_receipt()
        .await
        .map_err(|e| {
            format!(
                "Anchoring transaction {tx_hash} was broadcast but not confirmed within \
                 {CONFIRM_TIMEOUT_SECS}s: {e}"
            )
        })?;

    if !receipt.status() {
        return Err(format!("Anchoring transaction {tx_hash} reverted on-chain."));
    }

    Ok(format!("{:#x}", receipt.transaction_hash))
}

/// Anchor a document fingerprint on-chain and return the confirmed tx hash.
///
/// `hash` accepts ArtifactGuard's `sha256:<hex>` form, `0x<hex>`, or bare hex.
/// Every failure — locked store, missing registry address, unreachable RPC,
/// revert, confirmation timeout — is an `Err`. There is no fabricated fallback
/// hash: the caller marks the receipt item unregistered instead.
#[tauri::command]
pub async fn anchor_document(
    vault: State<'_, CredentialStoreState>,
    hash: String,
) -> Result<String, String> {
    let cfg = resolve_signing_config(&vault).ok_or_else(|| {
        "Blockchain signing is not configured — unlock the credential store and set the RPC URL \
         and deployer key in Configuration."
            .to_string()
    })?;
    let registry = registry_address()?;
    let document_hash = parse_document_hash(&hash)?;

    anchor_with(&cfg.rpc_url, &cfg.deployer_private_key, cfg.chain_id, registry, document_hash)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calldata_is_the_anchor_selector_plus_the_hash() {
        let h = B256::repeat_byte(0xab);
        let data = anchorCall { documentHash: h }.abi_encode();
        // keccak256("anchor(bytes32)")[..4]
        assert_eq!(&data[..4], &alloy::primitives::keccak256("anchor(bytes32)")[..4]);
        assert_eq!(&data[4..], h.as_slice());
    }

    /// Anchors a random hash on the deployed Sepolia registry using the
    /// deployer key and RPC from the environment (`CRE_ETH_PRIVATE_KEY`,
    /// `SEPOLIA_RPC`, `ANCHOR_REGISTRY_ADDRESS`). Spends Sepolia gas.
    ///
    ///     cargo test --lib live_anchor -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "broadcasts a real Sepolia transaction"]
    async fn live_anchor_returns_a_confirmed_tx_hash() {
        let _ = dotenvy::dotenv();
        let rpc = std::env::var("SEPOLIA_RPC").expect("SEPOLIA_RPC");
        let key = std::env::var("CRE_ETH_PRIVATE_KEY").expect("CRE_ETH_PRIVATE_KEY");
        let registry = registry_address().expect("registry address");
        // Unique per run, so each live test anchors a fresh fingerprint.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let hash = alloy::primitives::keccak256(nanos.to_be_bytes());

        let tx = anchor_with(&rpc, &key, 11155111, registry, hash).await.expect("anchor");
        eprintln!("anchored {hash:#x} in https://sepolia.etherscan.io/tx/{tx}");
        assert!(tx.starts_with("0x") && tx.len() == 66, "not a tx hash: {tx}");
    }
}
