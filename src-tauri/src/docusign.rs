//! DocuSign eSignature integration (spec Part II, §15–25).
//!
//! LexEscrow's first `eSignProvider` implementation. Everything that touches a
//! credential lives here, in the backend: the WebView asks for an envelope and
//! gets back an envelope ID, never an access token and never the RSA key that
//! minted it.
//!
//! Three design points carried over from the spec:
//!
//!   * **JWT Grant, not interactive OAuth.** Server-to-server auth with no user
//!     login (§18). The assertion is signed RS256 with the vault-held PEM and
//!     exchanged for a bearer token that is cached in memory until it nears
//!     expiry.
//!   * **Polling, not webhooks** (§16). DocuSign Connect needs a public HTTPS
//!     endpoint; a sovereign desktop app has none. Signature events are
//!     human-timescale, so a 30s poll is indistinguishable from real-time. The
//!     *timing* of that poll is owned by the frontend — these commands are
//!     stateless single-shot calls, which keeps the poll loop cancellable from
//!     the UI and testable without a Tokio task per envelope.
//!   * **Four endpoints, not four hundred** (§17): create envelope, read status,
//!     download completion certificate, plus the token exchange.

use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;
use tokio::sync::RwLock;

use crate::vault::{DocuSignSecret, VaultState};

/// DocuSign rejects assertions older than an hour; we ask for the full window.
const JWT_TTL_SECS: u64 = 3600;
/// Refresh this far ahead of expiry so a poll never races the boundary.
const TOKEN_REFRESH_MARGIN: Duration = Duration::from_secs(60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const SCOPE: &str = "signature impersonation";

// ============================================================================
// Types
// ============================================================================

/// One signer on an envelope. `routing_order` drives DocuSign's sequential
/// signing — equal values sign in parallel, ascending values sign in turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ESignSigner {
    pub name: String,
    pub email: String,
    pub role: String,
    pub routing_order: u32,
}

#[derive(Debug, Serialize)]
struct JwtClaims {
    iss: String,
    sub: String,
    aud: String,
    iat: u64,
    exp: u64,
    scope: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct EnvelopeCreated {
    envelope_id: String,
}

#[derive(Debug, Deserialize)]
struct EnvelopeStatus {
    status: String,
}

struct CachedToken {
    token: String,
    expires_at: Instant,
    /// Which credential minted this token. A vault edit (new key, or a
    /// Sandbox → Production flip) changes the fingerprint and forces a refresh,
    /// so a stale token can never be replayed against the wrong account.
    fingerprint: String,
}

/// `RwLock::const_new` lets the cache be a plain `static` with no init cost.
static TOKEN_CACHE: RwLock<Option<CachedToken>> = RwLock::const_new(None);

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .expect("reqwest client")
    })
}

// ============================================================================
// Environment routing
// ============================================================================

/// Sandbox and production have separate auth hosts *and* separate JWT
/// audiences. The account base URI is the authoritative signal — DocuSign hands
/// out `https://demo.docusign.net` for sandbox accounts — so a mislabelled
/// `environment` string cannot point an assertion at the wrong host.
fn is_sandbox(base_uri: &str) -> bool {
    let u = base_uri.to_ascii_lowercase();
    u.contains("demo") || u.contains("sandbox") || u.contains("-d.")
}

fn auth_host(base_uri: &str) -> &'static str {
    if is_sandbox(base_uri) {
        "account-d.docusign.com"
    } else {
        "account.docusign.com"
    }
}

fn unix_now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| format!("system clock is before the unix epoch: {e}"))
}

// ============================================================================
// JWT authentication (§18)
// ============================================================================

/// Build and RS256-sign the JWT Grant assertion.
pub fn build_jwt(
    integration_key: &str,
    user_id: &str,
    base_uri: &str,
    private_key_pem: &str,
) -> Result<String, String> {
    if integration_key.is_empty() || user_id.is_empty() {
        return Err("DocuSign integration key and user ID are required.".into());
    }
    if private_key_pem.is_empty() {
        return Err("DocuSign JWT private key is not configured.".into());
    }

    let now = unix_now()?;
    let claims = JwtClaims {
        iss: integration_key.to_string(),
        sub: user_id.to_string(),
        aud: auth_host(base_uri).to_string(),
        iat: now,
        exp: now + JWT_TTL_SECS,
        scope: SCOPE.to_string(),
    };

    // Accepts PKCS#1 ("BEGIN RSA PRIVATE KEY") and PKCS#8 ("BEGIN PRIVATE
    // KEY") — DocuSign's Developer Center issues the former.
    let key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes()).map_err(|e| {
        format!("DocuSign JWT private key is not a valid RSA PEM: {e}")
    })?;

    encode(&Header::new(Algorithm::RS256), &claims, &key)
        .map_err(|e| format!("failed to sign DocuSign JWT: {e}"))
}

/// Identifies the credential set without exposing it — the PEM is represented
/// only by its length, never its content.
fn fingerprint(creds: &DocuSignSecret) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        creds.integration_key,
        creds.user_id,
        creds.account_id,
        creds.base_uri,
        creds.jwt_private_key.len(),
    )
}

/// Exchange a JWT assertion for a bearer token, reusing a cached one while it
/// has more than [`TOKEN_REFRESH_MARGIN`] of life left.
pub async fn get_access_token(creds: &DocuSignSecret) -> Result<String, String> {
    let fp = fingerprint(creds);

    {
        let cache = TOKEN_CACHE.read().await;
        if let Some(c) = cache.as_ref() {
            if c.fingerprint == fp && c.expires_at > Instant::now() + TOKEN_REFRESH_MARGIN {
                return Ok(c.token.clone());
            }
        }
    }

    let assertion = build_jwt(
        &creds.integration_key,
        &creds.user_id,
        &creds.base_uri,
        &creds.jwt_private_key,
    )?;

    let url = format!("https://{}/oauth/token", auth_host(&creds.base_uri));
    let resp = http()
        .post(&url)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &assertion),
        ])
        .send()
        .await
        .map_err(|e| format!("DocuSign token request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("DocuSign token response was unreadable: {e}"))?;

    if !status.is_success() {
        // `consent_required` is the one failure an operator can actually fix,
        // so name the fix rather than echoing the raw error (spec §25).
        if body.contains("consent_required") {
            return Err(
                "DocuSign consent has not been granted for this integration key. Grant one-time \
                 user consent in a browser, then retry."
                    .into(),
            );
        }
        return Err(format!("DocuSign auth failed (HTTP {status}): {body}"));
    }

    let parsed: TokenResponse = serde_json::from_str(&body)
        .map_err(|e| format!("DocuSign token response was not valid JSON: {e}"))?;

    let ttl = parsed.expires_in.unwrap_or(JWT_TTL_SECS);
    let mut cache = TOKEN_CACHE.write().await;
    *cache = Some(CachedToken {
        token: parsed.access_token.clone(),
        expires_at: Instant::now() + Duration::from_secs(ttl),
        fingerprint: fp,
    });

    Ok(parsed.access_token)
}

// ============================================================================
// Envelope operations (§17, §19)
// ============================================================================

fn envelopes_url(base_uri: &str, account_id: &str) -> String {
    format!(
        "{}/restapi/v2.1/accounts/{}/envelopes",
        base_uri.trim_end_matches('/'),
        account_id
    )
}

/// DocuSign infers the renderer from `fileExtension`, so a mislabelled document
/// silently renders as garbage. Take the real extension when there is one.
fn file_extension(document_name: &str) -> String {
    document_name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| !ext.is_empty() && ext.len() <= 5)
        .unwrap_or_else(|| "pdf".to_string())
}

/// Create and send an envelope. Returns the DocuSign envelope ID.
pub async fn create_envelope(
    account_id: &str,
    base_uri: &str,
    access_token: &str,
    document_bytes: &[u8],
    document_name: &str,
    subject: &str,
    message: &str,
    signers: &[ESignSigner],
) -> Result<String, String> {
    if signers.is_empty() {
        return Err("An envelope needs at least one signer.".into());
    }
    if document_bytes.is_empty() {
        return Err("Cannot send an empty document for signature.".into());
    }

    let recipients: Vec<_> = signers
        .iter()
        .enumerate()
        .map(|(i, s)| {
            json!({
                // recipientId is envelope-local and 1-based.
                "recipientId": (i + 1).to_string(),
                "name": s.name,
                "email": s.email,
                "roleName": s.role,
                "routingOrder": s.routing_order.to_string(),
            })
        })
        .collect();

    let body = json!({
        "emailSubject": subject,
        "emailBlurb": message,
        "documents": [{
            "documentBase64": B64.encode(document_bytes),
            "name": document_name,
            "fileExtension": file_extension(document_name),
            "documentId": "1",
        }],
        "recipients": { "signers": recipients },
        // "sent" dispatches immediately; "created" would leave it as a draft.
        "status": "sent",
    });

    let resp = http()
        .post(envelopes_url(base_uri, account_id))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("DocuSign envelope request failed: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("DocuSign envelope response was unreadable: {e}"))?;

    if !status.is_success() {
        return Err(format!("DocuSign rejected the envelope (HTTP {status}): {text}"));
    }

    let created: EnvelopeCreated = serde_json::from_str(&text)
        .map_err(|e| format!("DocuSign envelope response was not valid JSON: {e}"))?;
    Ok(created.envelope_id)
}

/// Current envelope status: `sent` | `delivered` | `completed` | `declined` |
/// `voided`.
pub async fn get_envelope_status(
    account_id: &str,
    base_uri: &str,
    access_token: &str,
    envelope_id: &str,
) -> Result<String, String> {
    let url = format!("{}/{}", envelopes_url(base_uri, account_id), envelope_id);
    let resp = http()
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("DocuSign status request failed: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("DocuSign status response was unreadable: {e}"))?;

    if !status.is_success() {
        return Err(format!("DocuSign status check failed (HTTP {status}): {text}"));
    }

    let parsed: EnvelopeStatus = serde_json::from_str(&text)
        .map_err(|e| format!("DocuSign status response was not valid JSON: {e}"))?;
    Ok(parsed.status.to_ascii_lowercase())
}

/// Download the certificate of completion PDF. Only meaningful once the
/// envelope has reached `completed` — DocuSign 404s or returns a stub before
/// then.
pub async fn get_certificate(
    account_id: &str,
    base_uri: &str,
    access_token: &str,
    envelope_id: &str,
) -> Result<Vec<u8>, String> {
    let url = format!(
        "{}/{}/documents/certificate",
        envelopes_url(base_uri, account_id),
        envelope_id
    );
    let resp = http()
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("DocuSign certificate request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("DocuSign certificate download failed (HTTP {status}): {text}"));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("DocuSign certificate body was unreadable: {e}"))?;
    Ok(bytes.to_vec())
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Pull credentials + a live token. The resolved secret is dropped (and
/// zeroized) as soon as this returns.
async fn authed(vault: &State<'_, VaultState>) -> Result<(DocuSignSecret, String), String> {
    let creds = vault.resolve_docusign().ok_or(
        "DocuSign is not configured. Unlock the vault and add DocuSign credentials in \
         Configuration.",
    )?;
    let token = get_access_token(&creds).await?;
    Ok((creds, token))
}

/// Send a document for signature. Returns the envelope ID.
///
/// Deliberately does *not* start a poll loop: the frontend owns polling cadence
/// and lifecycle, so a closed session stops polling without a task leak.
#[tauri::command]
pub async fn docusign_send_envelope(
    vault: State<'_, VaultState>,
    document_bytes: Vec<u8>,
    document_name: String,
    subject: String,
    message: String,
    signers: Vec<ESignSigner>,
    session_id: String,
) -> Result<String, String> {
    let (creds, token) = authed(&vault).await?;
    let envelope_id = create_envelope(
        &creds.account_id,
        &creds.base_uri,
        &token,
        &document_bytes,
        &document_name,
        &subject,
        &message,
        &signers,
    )
    .await?;
    // The session linkage is persisted by the frontend (docusign_envelopes);
    // recording it here keeps the two sides correlatable in a backend log.
    eprintln!("docusign: envelope {envelope_id} sent for session {session_id}");
    Ok(envelope_id)
}

/// One status read. Called by the frontend on its 30-second interval.
#[tauri::command]
pub async fn docusign_poll_status(
    vault: State<'_, VaultState>,
    envelope_id: String,
) -> Result<String, String> {
    let (creds, token) = authed(&vault).await?;
    get_envelope_status(&creds.account_id, &creds.base_uri, &token, &envelope_id).await
}

/// Certificate of completion PDF bytes. Call only once status is `completed`.
#[tauri::command]
pub async fn docusign_get_certificate(
    vault: State<'_, VaultState>,
    envelope_id: String,
) -> Result<Vec<u8>, String> {
    let (creds, token) = authed(&vault).await?;
    get_certificate(&creds.account_id, &creds.base_uri, &token, &envelope_id).await
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;

    // A throwaway 2048-bit PKCS#1 key, generated for this test only. It signs
    // nothing outside the assertions below.
    const TEST_PEM: &str = include_str!("../test-fixtures/docusign_test_key.pem");

    #[test]
    fn sandbox_detection_routes_auth_host() {
        assert!(is_sandbox("https://demo.docusign.net"));
        assert!(is_sandbox("https://DEMO.docusign.net"));
        assert!(!is_sandbox("https://na3.docusign.net"));
        assert_eq!(auth_host("https://demo.docusign.net"), "account-d.docusign.com");
        assert_eq!(auth_host("https://na3.docusign.net"), "account.docusign.com");
    }

    #[test]
    fn file_extension_falls_back_to_pdf() {
        assert_eq!(file_extension("retainer.PDF"), "pdf");
        assert_eq!(file_extension("agreement.docx"), "docx");
        assert_eq!(file_extension("no-extension"), "pdf");
        // A dotted path with an implausible "extension" is not a file type.
        assert_eq!(file_extension("v1.2.finaldocument"), "pdf");
    }

    #[test]
    fn build_jwt_produces_three_rs256_segments() {
        let jwt = build_jwt("ik", "uid", "https://demo.docusign.net", TEST_PEM).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);

        let header = B64URL.decode(parts[0]).unwrap();
        let header: serde_json::Value = serde_json::from_slice(&header).unwrap();
        assert_eq!(header["alg"], "RS256");

        let claims = B64URL.decode(parts[1]).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&claims).unwrap();
        assert_eq!(claims["iss"], "ik");
        assert_eq!(claims["sub"], "uid");
        assert_eq!(claims["aud"], "account-d.docusign.com");
        assert_eq!(claims["scope"], "signature impersonation");
        // The full hour of validity the grant allows.
        assert_eq!(
            claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(),
            JWT_TTL_SECS
        );
    }

    #[test]
    fn build_jwt_audience_follows_environment() {
        let jwt = build_jwt("ik", "uid", "https://na3.docusign.net", TEST_PEM).unwrap();
        let claims = B64URL.decode(jwt.split('.').nth(1).unwrap()).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&claims).unwrap();
        assert_eq!(claims["aud"], "account.docusign.com");
    }

    #[test]
    fn build_jwt_rejects_missing_or_malformed_key() {
        assert!(build_jwt("ik", "uid", "https://demo.docusign.net", "").is_err());
        assert!(build_jwt("ik", "uid", "https://demo.docusign.net", "not-a-pem").is_err());
        assert!(build_jwt("", "uid", "https://demo.docusign.net", TEST_PEM).is_err());
        assert!(build_jwt("ik", "", "https://demo.docusign.net", TEST_PEM).is_err());
    }

    #[test]
    fn fingerprint_never_contains_key_material() {
        let creds = DocuSignSecret {
            integration_key: "ik".into(),
            user_id: "uid".into(),
            account_id: "acct".into(),
            base_uri: "https://demo.docusign.net".into(),
            jwt_private_key: "SUPER-SECRET-PEM".into(),
            environment: "sandbox".into(),
        };
        let fp = fingerprint(&creds);
        assert!(!fp.contains("SUPER-SECRET-PEM"));
        assert!(fp.ends_with("|16")); // length only
    }

    #[test]
    fn envelopes_url_tolerates_a_trailing_slash() {
        assert_eq!(
            envelopes_url("https://demo.docusign.net/", "acct-1"),
            "https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes"
        );
    }
}
