//! Practice-management webhook delivery (spec §14 V1).
//!
//! The payload is built in the frontend — it is a projection of session state,
//! which lives there — but the POST is made here. That split exists for one
//! reason: the Clio / PracticePanther API key is a bearer token for a firm's
//! matter data, and `vault.rs` guarantees that secrets never cross IPC to the
//! WebView. Resolving the config in the backend and sending from here keeps
//! that guarantee intact while the frontend still decides what to say.
//!
//! Delivery is best-effort by design. A webhook is a courtesy copy sent to a
//! system LexEscrow does not control; the authoritative record is the
//! hash-chained audit trail, so an unreachable practice-management server is
//! reported to the caller and never propagated as a failure of the escrow.

use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::credential_store::CredentialStoreState;

/// Spec Task 2 — abandon the request after ten seconds.
const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(10);

/// Mirrors the frontend `WebhookResult` so both transports report identically.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookOutcome {
    pub success: bool,
    pub status_code: Option<u16>,
    pub error: Option<String>,
}

impl WebhookOutcome {
    fn failed(message: impl Into<String>) -> Self {
        Self { success: false, status_code: None, error: Some(message.into()) }
    }
}

/// Which vendor's stored config to send with. Resolved rather than passed so a
/// compromised WebView cannot redirect a firm's API key to an arbitrary host.
enum Vendor {
    Clio,
    PracticePanther,
}

impl Vendor {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "clio" => Some(Self::Clio),
            "practicePanther" | "practice_panther" => Some(Self::PracticePanther),
            _ => None,
        }
    }
}

/// POST a JSON body to the configured webhook for `vendor`.
///
/// `body` arrives as a serialized JSON string and is forwarded verbatim: this
/// layer is a transport, and re-encoding a payload it does not model would risk
/// changing what the frontend meant to send.
#[tauri::command]
pub async fn integration_send_webhook(
    state: State<'_, CredentialStoreState>,
    vendor: String,
    body: String,
) -> Result<WebhookOutcome, String> {
    let Some(kind) = Vendor::parse(&vendor) else {
        return Ok(WebhookOutcome::failed(format!("Unknown integration '{vendor}'")));
    };

    // The config is cloned out and the guard dropped before the await — the
    // vault mutex is a std lock and must not be held across a suspension point.
    let resolved = match kind {
        Vendor::Clio => state
            .resolve_clio()
            .map(|c| (c.webhook_url.clone(), c.api_key.clone())),
        Vendor::PracticePanther => state
            .resolve_practice_panther()
            .map(|c| (c.webhook_url.clone(), c.api_key.clone())),
    };

    let Some((url, api_key)) = resolved else {
        return Ok(WebhookOutcome::failed("Integration is not configured"));
    };
    if url.trim().is_empty() {
        return Ok(WebhookOutcome::failed("No webhook URL configured"));
    }

    let client = match reqwest::Client::builder().timeout(WEBHOOK_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => return Ok(WebhookOutcome::failed(e.to_string())),
    };

    let mut request = client
        .post(&url)
        .header("content-type", "application/json")
        .body(body);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(key);
    }

    Ok(match request.send().await {
        Ok(res) => {
            let status = res.status();
            WebhookOutcome {
                success: status.is_success(),
                status_code: Some(status.as_u16()),
                error: if status.is_success() {
                    None
                } else {
                    Some(format!("HTTP {}", status.as_u16()))
                },
            }
        }
        // Includes the timeout — reqwest surfaces it as an ordinary send error.
        Err(e) => WebhookOutcome::failed(e.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendor_parses_both_spellings_and_rejects_others() {
        assert!(matches!(Vendor::parse("clio"), Some(Vendor::Clio)));
        assert!(matches!(
            Vendor::parse("practicePanther"),
            Some(Vendor::PracticePanther)
        ));
        assert!(matches!(
            Vendor::parse("practice_panther"),
            Some(Vendor::PracticePanther)
        ));
        assert!(Vendor::parse("").is_none());
        assert!(Vendor::parse("clio ").is_none());
        assert!(Vendor::parse("evil-vendor").is_none());
    }

    #[test]
    fn failed_outcome_carries_no_status_code() {
        let outcome = WebhookOutcome::failed("boom");
        assert!(!outcome.success);
        assert_eq!(outcome.status_code, None);
        assert_eq!(outcome.error.as_deref(), Some("boom"));
    }

    #[test]
    fn outcome_serializes_camel_case_for_the_webview() {
        let json = serde_json::to_string(&WebhookOutcome {
            success: false,
            status_code: Some(503),
            error: Some("HTTP 503".into()),
        })
        .unwrap();
        assert!(json.contains("\"statusCode\":503"));
    }
}
