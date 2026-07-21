//! External adapter HTTP calls that must run in the backend, not the WebView.
//!
//! The CA State Bar verification lookup is a cross-origin GET against the mock
//! adapter (and, under CRE, the Chainlink Functions target). Issued from the
//! WebView it is a browser `fetch` subject to CORS; issued from here it is an
//! ordinary server request with no origin policy — the same reason DocuSign,
//! the AI transport and the integration webhooks already live in Rust.

use std::time::Duration;

const VERIFY_TIMEOUT: Duration = Duration::from_secs(15);

/// Build `{adapter_url}/verify/{bar_number}`.
///
/// A trailing slash on the base is folded away, and the bar number is
/// percent-encoded as a single path segment (`12/34` → `12%2F34`) so it can
/// never split the path — matching the frontend fallback's URL construction so
/// the two code paths address the mock identically.
fn build_verify_url(adapter_url: &str, bar_number: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(adapter_url)
        .map_err(|e| format!("Invalid bar adapter URL '{adapter_url}': {e}"))?;
    url.path_segments_mut()
        .map_err(|_| format!("Bar adapter URL '{adapter_url}' cannot be a base"))?
        .pop_if_empty()
        .extend(["verify", bar_number]);
    Ok(url)
}

/// GET the CA State Bar verification endpoint and return the parsed JSON body.
///
/// Never panics. A transport failure (DNS, refused connection, timeout) or a
/// non-success status returns `Err(message)`; the frontend router turns that
/// into a `BarVerifyResult` with `status: "error"` — the safe value, since
/// "could not verify" must never be mistaken for "in good standing".
///
/// `state` is carried for context and error wording only. Routing to the right
/// registry already happened in the frontend, which calls this solely for the
/// implemented state (California in V1).
#[tauri::command]
pub async fn verify_bar_number(
    bar_number: String,
    state: String,
    adapter_url: String,
) -> Result<serde_json::Value, String> {
    let url = build_verify_url(&adapter_url, &bar_number)?;

    let client = reqwest::Client::builder()
        .timeout(VERIFY_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not reach the {state} bar adapter: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        return Err(format!(
            "{state} State Bar lookup failed with HTTP {}",
            status.as_u16()
        ));
    }

    res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("{state} State Bar returned an unreadable body: {e}"))
}

#[cfg(test)]
mod tests {
    use super::build_verify_url;

    #[test]
    fn builds_the_verify_path() {
        assert_eq!(
            build_verify_url("http://localhost:3001", "234567").unwrap().as_str(),
            "http://localhost:3001/verify/234567",
        );
    }

    #[test]
    fn folds_away_a_trailing_slash() {
        assert_eq!(
            build_verify_url("http://localhost:3001/", "234567").unwrap().as_str(),
            "http://localhost:3001/verify/234567",
        );
    }

    #[test]
    fn percent_encodes_the_bar_number_as_one_segment() {
        assert_eq!(
            build_verify_url("http://localhost:3001", "12/34").unwrap().as_str(),
            "http://localhost:3001/verify/12%2F34",
        );
    }

    #[test]
    fn rejects_a_url_that_cannot_be_parsed() {
        assert!(build_verify_url("not a url", "234567").is_err());
    }
}
