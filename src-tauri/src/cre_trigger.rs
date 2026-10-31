// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

//! CRE HTTPTrigger — signed JSON-RPC invocation of the deployed workflow.
//!
//! `cre.rs` settles on chain. This module does something narrower and stranger:
//! it asks the deployed Confidential Workflow to *look* at an escrow. The
//! workflow runs inside a TEE enclave, validates the payload, computes an HMAC
//! seal and crosses the result to the DON. It moves no money and authorises
//! nothing — which is why the caller treats a failure here as an observation
//! that did not happen, never as a settlement that must not.
//!
//! The gateway authenticates the caller with a JWT whose `alg` is `ETH`: the
//! signature is an Ethereum personal-sign over the encoded header and payload,
//! and the gateway recovers the signer address from it and compares that to
//! `iss`. Two details in here are load-bearing and neither is guessable from
//! the shape of the JSON:
//!
//!   * The POSTed body must be the *same bytes* that were hashed into `digest`.
//!     The gateway re-derives the digest from what it receives, so a body that
//!     is merely equivalent JSON — different key order, different spacing —
//!     fails verification. `canonical_json` below is the single place that
//!     serialises the request, and both the digest and the body come from it.
//!   * The signature's final byte is the recovery ID (0 or 1), not Ethereum's
//!     27/28 `v`. `Signature::as_bytes()` in alloy emits the latter, so this
//!     module uses `as_rsy()`, which emits the former.
//!
//! Both match `cre-sdk-typescript/packages/cre-http-trigger/src` (`create-jwt.ts`,
//! `utils.ts`, `trigger-workflow.ts`), which is the only executable statement of
//! this protocol that exists.

use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::credential_store::CredentialStoreState;

/// The deployed Confidential Workflow. Registered private, ACTIVE on the DON.
const WORKFLOW_ID: &str = "00ef7d0a234078399c24b4036e848d358ec1315546bc1c8cd5f00f4d31ef408e";

/// Zone-A gateway that fronts the DON this workflow runs on.
///
/// Not the `enterprise-gateway` host of the same zone, despite the workflow
/// being deployed to the *private registry*. Those two "private"s are unrelated:
/// the registry decides who may deploy and see the workflow, the gateway is
/// simply the DON's front door, and this DON's is the standard one — the same
/// host the `cre` CLI uses (`CRE_VAULT_DON_GATEWAY_URL`). Sending to
/// `enterprise-gateway` gets `-32600 Workflow not found` for a workflow that is
/// demonstrably ACTIVE, which reads like a bad ID and is not one.
const GATEWAY_URL: &str = "https://01.gateway.zone-a.cre.chain.link/";

/// JWT lifetime. The gateway rejects anything longer than 300s, so this is a
/// ceiling rather than a preference.
const JWT_TTL_SECS: u64 = 300;

/// How long to wait on the gateway before giving up. Deliberately short: the
/// caller is on the settlement path with a human watching, and this trigger is
/// an observation it will proceed without.
const REQUEST_TIMEOUT_SECS: u64 = 20;

/// What the gateway accepted. Every field is an opaque public identifier — no
/// part of the JWT or the signing key is reachable from here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreTriggerResult {
    pub execution_id: String,
    pub status: String,
    pub workflow_id: String,
}

// ── Canonical JSON ───────────────────────────────────────────────────────────

/// Serialise `value` with object keys in ascending order at every nesting
/// level, compact, no whitespace — the output of `json-stable-stringify`, which
/// is what the reference client hashes and sends.
///
/// Written out rather than leaning on `serde_json::Map`'s BTreeMap backing.
/// That backing is only sorted while the `preserve_order` feature is off, and
/// that feature is additive across the whole dependency graph: any crate that
/// switches it on anywhere would silently turn this function's output into
/// insertion order, and the symptom would be a gateway rejecting our digest
/// rather than anything failing to compile. Scalars still round-trip through
/// `serde_json` so that string escaping and number formatting stay identical to
/// the reference.
fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                // Through serde_json so escaping matches JSON.stringify.
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into()));
                out.push(':');
                write_canonical(&map[*key], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        scalar => {
            out.push_str(&serde_json::to_string(scalar).unwrap_or_else(|_| "null".into()));
        }
    }
}

fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `"0x" + hex(sha256(canonical_body))` — the `digest` claim.
fn digest_of(canonical_body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_body.as_bytes());
    format!("0x{}", hex::encode(hasher.finalize()))
}

// ── JWT ──────────────────────────────────────────────────────────────────────

/// Build the `alg: ETH` JWT authorising one request body.
///
/// The payload's key order is the reference client's insertion order — digest,
/// iss, iat, exp, jti — not alphabetical. That is not an oversight and it is
/// not a contradiction of the digest rule above: the gateway verifies this
/// signature over the base64url text it receives and then reads the claims out
/// of it, so the ordering never has to be re-derived by anyone. Sorting here
/// would be a gratuitous divergence from the only client known to work against
/// this gateway, on a value where sorting buys nothing.
async fn create_jwt(signer: &PrivateKeySigner, canonical_body: &str) -> Result<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "System clock is before the Unix epoch.".to_string())?
        .as_secs();

    // EIP-55 checksummed, matching viem's `account.address` in the reference.
    let issuer = signer.address().to_string();

    let header = json!({ "alg": "ETH", "typ": "JWT" });
    let payload = json!({
        "digest": digest_of(canonical_body),
        "iss": issuer,
        "iat": now,
        "exp": now + JWT_TTL_SECS,
        "jti": uuid::Uuid::new_v4().to_string(),
    });

    let encoded_header = b64url(serde_json::to_string(&header).map_err(fmt_err)?.as_bytes());
    let encoded_payload = b64url(serde_json::to_string(&payload).map_err(fmt_err)?.as_bytes());
    let message = format!("{encoded_header}.{encoded_payload}");

    // `sign_message` applies the EIP-191 `\x19Ethereum Signed Message:\n<len>`
    // prefix and keccak256 before signing — the personal-sign the gateway
    // recovers against.
    let signature = signer
        .sign_message(message.as_bytes())
        .await
        .map_err(|e| format!("Could not sign the CRE gateway request: {e}"))?;

    // r || s || recovery_id. `as_rsy` puts 0/1 in the final byte; `as_bytes`
    // would put 27/28 there and the gateway would recover a different address.
    let encoded_signature = b64url(&signature.as_rsy());

    Ok(format!("{message}.{encoded_signature}"))
}

fn fmt_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ── Response parsing ─────────────────────────────────────────────────────────

/// Pull the accepted execution out of a gateway response, or explain why there
/// isn't one.
///
/// Split out from the transport so the shapes that actually vary — a JSON-RPC
/// `error` object, a `result` missing the execution ID, a body that is not the
/// envelope at all — are testable without a network.
fn parse_gateway_response(body: &str) -> Result<CreTriggerResult, String> {
    let parsed: Value = serde_json::from_str(body)
        .map_err(|e| format!("Gateway returned a body that is not JSON ({e}): {body}"))?;

    if let Some(error) = parsed.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("no message")
            .to_string();
        let code = error.get("code").and_then(Value::as_i64);
        return Err(match code {
            Some(c) => format!("CRE gateway rejected the request ({c}): {message}"),
            None => format!("CRE gateway rejected the request: {message}"),
        });
    }

    let result = parsed
        .get("result")
        .ok_or_else(|| format!("Gateway response carried neither `result` nor `error`: {body}"))?;

    let execution_id = result
        .get("workflow_execution_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Gateway response has no `workflow_execution_id`: {body}"))?
        .to_string();

    Ok(CreTriggerResult {
        execution_id,
        status: result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_string(),
        workflow_id: result
            .get("workflow_id")
            .and_then(Value::as_str)
            .unwrap_or(WORKFLOW_ID)
            .to_string(),
    })
}

// ── The trigger ──────────────────────────────────────────────────────────────

/// Sign and POST one `workflows.execute` request for `payload`.
///
/// Split from the command so the vault read is the command's business and this
/// is purely the protocol — the key arrives already resolved.
async fn trigger_cre_workflow_signed(
    deployer_private_key: &str,
    payload: Value,
) -> Result<CreTriggerResult, String> {
    let signer: PrivateKeySigner = deployer_private_key
        .trim()
        .parse()
        .map_err(|_| "The stored deployer private key is not a valid secp256k1 key.".to_string())?;

    let request = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "jsonrpc": "2.0",
        "method": "workflows.execute",
        "params": {
            "input": payload,
            "workflow": { "workflowID": WORKFLOW_ID },
        },
    });

    // Serialised once. The digest is taken over this string and this string is
    // the body — the two cannot drift apart.
    let canonical_body = canonical_json(&request);
    let jwt = create_jwt(&signer, &canonical_body).await?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Could not build the HTTP client for the CRE gateway: {e}"))?;

    let response = client
        .post(GATEWAY_URL)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {jwt}"))
        .body(canonical_body)
        .send()
        .await
        .map_err(|e| format!("Could not reach the CRE gateway: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("CRE gateway response could not be read: {e}"))?;

    // A JSON-RPC error can arrive under a non-200, and it carries the useful
    // text ("signer is not authorized…"), so parse before judging the status.
    match parse_gateway_response(&body) {
        Ok(result) => Ok(result),
        Err(e) if status.is_success() => Err(e),
        Err(e) => Err(format!("{e} (HTTP {})", status.as_u16())),
    }
}

/// Trigger the deployed CRE Confidential Workflow for this escrow.
///
/// The deployer key is read from the credential store's blockchain group at
/// call time and never crosses IPC — the same contract `cre::resolve_signing_config`
/// documents, and the reason this command takes no key parameter. Only the key
/// is required: the RPC URL, contract address and chain ID that settlement needs
/// have nothing to do with reaching the gateway, so a partially configured
/// blockchain entry can still trigger.
///
/// Errors are returned, not swallowed, and also written to stderr for the
/// LexTrace audit trail. The caller is expected to continue to settlement on an
/// `Err` — this workflow validates and seals, it does not authorise, and gating
/// settlement on it would give an unreachable gateway veto power over money
/// movement it plays no part in.
#[tauri::command]
pub async fn trigger_cre_workflow(
    vault: State<'_, CredentialStoreState>,
    payload: Value,
) -> Result<CreTriggerResult, String> {
    let key = vault
        .resolve_blockchain()
        .map(|c| c.deployer_private_key.clone())
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| {
            "CRE trigger is not configured — unlock the credential store and set the deployer key \
             in Configuration."
                .to_string()
        })?;

    match trigger_cre_workflow_signed(&key, payload).await {
        Ok(result) => {
            eprintln!(
                "[cre_trigger] accepted execution {} (status {})",
                result.execution_id, result.status
            );
            Ok(result)
        }
        Err(e) => {
            eprintln!("[cre_trigger] {e}");
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_keys_at_every_level() {
        let v = json!({
            "method": "workflows.execute",
            "id": "abc",
            "jsonrpc": "2.0",
            "params": { "workflow": { "workflowID": "ff" }, "input": { "b": 2, "a": 1 } },
        });
        assert_eq!(
            canonical_json(&v),
            r#"{"id":"abc","jsonrpc":"2.0","method":"workflows.execute","params":{"input":{"a":1,"b":2},"workflow":{"workflowID":"ff"}}}"#
        );
    }

    #[test]
    fn canonical_json_is_compact_and_preserves_array_order() {
        // Arrays are sequences, not objects: sorting them would change meaning.
        let v = json!({ "z": [3, 1, 2], "a": null });
        assert_eq!(canonical_json(&v), r#"{"a":null,"z":[3,1,2]}"#);
    }

    #[test]
    fn canonical_json_escapes_strings_like_json_stringify() {
        let v = json!({ "k\"q": "line\nbreak\ttab\"quote\\slash" });
        assert_eq!(canonical_json(&v), r#"{"k\"q":"line\nbreak\ttab\"quote\\slash"}"#);
    }

    #[test]
    fn digest_matches_sha256_of_the_canonical_string() {
        // Independently checkable: sha256("{}") is the well-known empty-object
        // digest, so this pins the hash input to the canonical text — not to a
        // re-serialisation of the value.
        let digest = digest_of("{}");
        assert_eq!(
            digest,
            "0x44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
        assert!(digest.starts_with("0x"));
        assert_eq!(digest.len(), 66);
    }

    #[test]
    fn base64url_is_url_safe_and_unpadded() {
        // 0xfb 0xff exercises both substituted characters (+/ → -_).
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
        assert!(!b64url(&[0x01]).contains('='));
    }

    /// The JWT the gateway must be able to verify: three base64url segments, a
    /// 65-byte signature whose final byte is a recovery ID rather than an
    /// Ethereum `v`, and an `iss` that is the address of the signing key.
    #[tokio::test]
    async fn jwt_carries_a_recoverable_personal_sign_signature() {
        use alloy::primitives::eip191_hash_message;
        use alloy::primitives::Signature;

        // go-ethereum's published test key — a documented throwaway that
        // appears verbatim across Ethereum tooling docs. Fixed rather than
        // random so a signature regression is reproducible.
        let signer: PrivateKeySigner =
            "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"
                .parse()
                .unwrap();

        let body = canonical_json(&json!({ "jsonrpc": "2.0", "id": "x" }));
        let jwt = create_jwt(&signer, &body).await.unwrap();

        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);

        let header: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "ETH");
        assert_eq!(header["typ"], "JWT");

        let payload: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(payload["digest"], digest_of(&body));
        assert_eq!(payload["iss"], signer.address().to_string());
        // Checksummed, like viem — mixed case, not lowercased.
        assert_ne!(payload["iss"].as_str().unwrap(), &signer.address().to_string().to_lowercase());
        let iat = payload["iat"].as_u64().unwrap();
        assert_eq!(payload["exp"].as_u64().unwrap(), iat + 300);
        assert_eq!(payload["exp"].as_u64().unwrap() - iat, JWT_TTL_SECS);

        let sig_bytes = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(sig_bytes.len(), 65);
        // The claim that actually matters at the gateway: recovery ID, not 27/28.
        assert!(sig_bytes[64] == 0 || sig_bytes[64] == 1, "v was {}", sig_bytes[64]);

        // And it recovers to `iss` over the signed message, which is what the
        // gateway does before it trusts the claims.
        let message = format!("{}.{}", parts[0], parts[1]);
        let mut rs = [0u8; 64];
        rs.copy_from_slice(&sig_bytes[..64]);
        let signature = Signature::from_bytes_and_parity(&rs, sig_bytes[64] == 1);
        let recovered = signature
            .recover_address_from_prehash(&eip191_hash_message(message.as_bytes()))
            .unwrap();
        assert_eq!(recovered, signer.address());
    }

    #[test]
    fn accepted_response_yields_the_execution_id() {
        let body = r#"{"jsonrpc":"2.0","id":"req-1","method":"workflows.execute",
            "result":{"workflow_id":"0xabc","workflow_execution_id":"exec-77","status":"ACCEPTED"}}"#;
        let r = parse_gateway_response(body).unwrap();
        assert_eq!(r.execution_id, "exec-77");
        assert_eq!(r.status, "ACCEPTED");
        assert_eq!(r.workflow_id, "0xabc");
    }

    #[test]
    fn jsonrpc_error_surfaces_the_gateway_message() {
        let body = r#"{"jsonrpc":"2.0","id":"req-1","error":{"code":-32600,
            "message":"Auth failure: signer '0xdead' is not authorized"}}"#;
        let e = parse_gateway_response(body).unwrap_err();
        assert!(e.contains("not authorized"), "{e}");
        assert!(e.contains("-32600"), "{e}");
    }

    #[test]
    fn result_without_an_execution_id_is_an_error_not_an_empty_success() {
        let body = r#"{"jsonrpc":"2.0","id":"r","result":{"status":"ACCEPTED"}}"#;
        assert!(parse_gateway_response(body).unwrap_err().contains("workflow_execution_id"));
    }

    #[test]
    fn a_non_json_body_is_reported_rather_than_parsed_into_nothing() {
        assert!(parse_gateway_response("<html>502 Bad Gateway</html>")
            .unwrap_err()
            .contains("not JSON"));
    }

    #[test]
    fn a_body_with_neither_result_nor_error_is_rejected() {
        assert!(parse_gateway_response(r#"{"jsonrpc":"2.0","id":"r"}"#)
            .unwrap_err()
            .contains("neither"));
    }

    /// Live protocol check against the real gateway, signed by a throwaway key.
    ///
    /// Ignored by default because it needs the network. Its value is that it
    /// needs no secret: an unauthorised signer still exercises every step the
    /// gateway performs before authorisation — canonical body, digest, JWT
    /// decode, and the personal-sign address recovery. A reply naming the
    /// throwaway address back to us means the recovery worked, which is the
    /// one thing no offline test can prove.
    ///
    ///     cargo test --lib live_gateway -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the live CRE gateway"]
    async fn live_gateway_recovers_our_signer_from_the_jwt() {
        let throwaway = PrivateKeySigner::random();
        let address = throwaway.address();
        eprintln!("throwaway signer: {address}");

        let err = trigger_cre_workflow_signed(
            &format!("0x{}", hex::encode(throwaway.to_bytes())),
            json!({ "session_id": "protocol-check", "asset_class": "legal" }),
        )
        .await
        .expect_err("an unauthorised signer must not be accepted");

        eprintln!("gateway said: {err}");

        // The gateway names the address it recovered, and it is the one we
        // signed with. That single fact clears the whole protocol: it read the
        // canonical body, matched the digest, decoded the JWT and ran the
        // personal-sign recovery to completion. Nothing but a correct
        // implementation gets this address echoed back.
        assert!(
            err.to_lowercase().contains(&address.to_string().to_lowercase()),
            "gateway did not echo our recovered address: {err}"
        );
        // And it stopped at authorisation, so no execution was created — which
        // is what keeps this test safe to run against the live workflow.
        assert!(err.contains("not authorized"), "unexpected rejection: {err}");
    }

    #[test]
    fn an_unparseable_key_fails_before_any_network_call() {
        let err = tauri::async_runtime::block_on(trigger_cre_workflow_signed(
            "not-a-key",
            json!({ "session_id": "s1" }),
        ))
        .unwrap_err();
        assert!(err.contains("not a valid secp256k1 key"), "{err}");
    }
}
