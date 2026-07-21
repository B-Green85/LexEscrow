//! AI provider transport.
//!
//! Two commands mirror the two connection types stored in the vault. Both pull
//! the API key + endpoint from the unlocked vault *inside the Rust core* — the
//! secret is injected into the request here and never crosses IPC to the
//! WebView. The TS provider layer supplies the system prompt and the user
//! content (the document text, or a correction prompt); the raw model response
//! is returned for the provider to validate + shape.
//!
//! The request body carries `model` (from the vault's provider name — nothing
//! hardcoded), a top-level `system`/`user`, and a `messages` array, so both
//! adapter endpoints and chat-style APIs can read it.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tauri::State;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::vault::VaultState;

/// Map the stored model string to a currently-valid Anthropic model ID.
///
/// The vault stores a provider *label* ("Claude") rather than a model ID, and
/// older IDs (`claude-3-*`, `claude-instant`) are retired. Anything not on the
/// current allow-list falls back to `claude-sonnet-4-6`, so the request can
/// never 404 on the model string alone.
fn normalize_model(model: &str) -> &'static str {
    match model.trim().to_ascii_lowercase().as_str() {
        "claude-opus-4-6" => "claude-opus-4-6",
        "claude-sonnet-4-6" => "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001" => "claude-haiku-4-5-20251001",
        _ => "claude-sonnet-4-6",
    }
}

/// The Anthropic Messages API body: exactly `model`, `max_tokens`, top-level
/// `system`, and a `messages` array (user turn only). No other fields —
/// Anthropic rejects unknown keys with "Extra inputs are not permitted", and
/// a `system`-role entry inside `messages` is invalid (roles must be
/// user/assistant). The system prompt lives only in the top-level `system`.
fn request_body(model: &str, system: &str, user: &str) -> String {
    json!({
        "model": normalize_model(model),
        "max_tokens": 4096,
        "system": system,
        "messages": [
            { "role": "user", "content": user },
        ],
    })
    .to_string()
}

#[tauri::command]
pub async fn ai_request_http(
    state: State<'_, VaultState>,
    system: String,
    user: String,
) -> Result<String, String> {
    // Clone the credential out under lock, then release before any await.
    let ai = state.resolve_ai().ok_or("No AI provider configured (unlock the vault).".to_string())?;
    if ai.api_key.is_empty() {
        return Err("Configured AI provider has no API key.".into());
    }
    let body = request_body(&ai.provider_name, &system, &user);

    // Path-identification log (Issue #4) — confirms the HTTP call executes in
    // the Rust backend, not the WebView. Left in place for the next test run.
    eprintln!(
        "[ai] HTTP request executing in Rust backend (ai_request_http) -> {}",
        ai.endpoint
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(&ai.endpoint)
        .header("content-type", "application/json")
        .header("x-api-key", &ai.api_key)
        .header("anthropic-version", "2023-06-01")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("AI provider returned HTTP {}: {text}", status.as_u16()));
    }
    Ok(text)
}

#[tauri::command]
pub async fn ai_request_ws(
    state: State<'_, VaultState>,
    system: String,
    user: String,
) -> Result<String, String> {
    let ai = state.resolve_ai().ok_or("No AI provider configured (unlock the vault).".to_string())?;
    if ai.api_key.is_empty() {
        return Err("Configured AI provider has no API key.".into());
    }
    let body = request_body(&ai.provider_name, &system, &user);

    let mut request = ai
        .endpoint
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    // Anthropic authenticates via x-api-key, never Authorization: Bearer.
    let headers = request.headers_mut();
    if let Ok(v) = ai.api_key.parse() {
        headers.insert("x-api-key", v);
    }

    let (mut ws, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;

    ws.send(Message::Text(body.into())).await.map_err(|e| e.to_string())?;

    // Stream frames, collecting the full payload until the socket closes or a
    // complete JSON object has arrived.
    let mut collected = String::new();
    let deadline = Duration::from_secs(30);
    loop {
        let next = tokio::time::timeout(deadline, ws.next())
            .await
            .map_err(|_| "AI WebSocket timed out".to_string())?;
        match next {
            Some(Ok(Message::Text(t))) => {
                collected.push_str(t.as_str());
                if serde_json::from_str::<serde_json::Value>(collected.trim()).is_ok() {
                    break;
                }
            }
            Some(Ok(Message::Binary(b))) => {
                collected.push_str(&String::from_utf8_lossy(b.as_ref()));
            }
            Some(Ok(Message::Close(_))) | None => break,
            Some(Ok(_)) => {} // ping / pong / continuation
            Some(Err(e)) => return Err(e.to_string()),
        }
    }
    let _ = ws.close(None).await;

    if collected.trim().is_empty() {
        return Err("AI WebSocket returned no data.".into());
    }
    Ok(collected)
}
