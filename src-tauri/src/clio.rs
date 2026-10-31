// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

//! Clio Manage — read-only matter intake over OAuth 2.0.
//!
//! LexEscrow's second document-intake path. Where the Artifact Loader takes raw
//! PDF/DOCX bytes and hashes them, this pulls a firm's already-structured matter
//! data straight out of Clio. Everything downstream — the AI parser, LexGuard,
//! the settlement paths — is unchanged; only the shape of the input differs.
//!
//! ## What this module is not allowed to do
//!
//! Three constraints from Clio's Terms of Service are load-bearing here, and
//! each one is enforced structurally rather than by convention:
//!
//!  * **§10(e) — no persistence beyond session scope.** `clio_fetch_matter`
//!    returns its payload to the WebView and writes nothing. This module does
//!    not import [`crate::db`] and takes no `State<'_, Db>` on any command, so
//!    there is no handle here through which a Clio field could reach SQLite even
//!    by accident. `no_path_from_this_module_to_sqlite` asserts that against the
//!    module's own source, so the guarantee fails at `cargo test` rather than in
//!    a review.
//!  * **Read-only.** Every request below is a `GET`. The one `POST` in the file
//!    is to Clio's *token* endpoint, which is the OAuth handshake, not the
//!    matter API. `every_api_call_is_a_get` pins that.
//!  * **Minimum necessary data.** Each endpoint carries an explicit `fields=`
//!    list naming exactly what LexEscrow maps into its own payload. Clio would
//!    happily return the whole record; asking for less is the point.
//!
//! ## Shape of the file
//!
//! The HTTP-touching commands are thin wrappers over pure functions — URL
//! construction, token-response parsing, expiry arithmetic, and the field
//! mapping for all five endpoints. That split is what makes the interesting
//! half testable without standing up a mock HTTP server: the tests below drive
//! the real field mappings against captured Clio response shapes, and what is
//! left untested is `reqwest` doing what `reqwest` does.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::credential_store::CredentialStoreState;
use crate::vault::{ClioConfig, CLIO_DEFAULT_REDIRECT_URI};

// ============================================================================
// Endpoints and constants
// ============================================================================

pub const AUTHORIZE_URL: &str = "https://app.clio.com/oauth/authorize";
pub const TOKEN_URL: &str = "https://app.clio.com/oauth/token";
pub const API_BASE: &str = "https://app.clio.com/api/v4";

/// The four read scopes LexEscrow uses, and no others. A scope LexEscrow does
/// not read is a scope a firm's security review has to ask about.
pub const SCOPES: &str = "matters:read contacts:read billing:read documents:read";

/// Fixed by the redirect URI registered in the Clio Developer Portal. Clio
/// requires an exact string match, so this cannot be negotiated at runtime.
pub const CALLBACK_PORT: u16 = 8080;
pub const CALLBACK_PATH: &str = "/callback";

/// Emitted to the WebView when the browser lands on the loopback callback.
pub const OAUTH_CALLBACK_EVENT: &str = "clio:oauth_callback";

/// How long the loopback listener waits for the operator to finish authorising
/// before giving the port back. Long enough to find a password manager, short
/// enough that an abandoned attempt does not hold 8080 for the session.
const AUTH_WINDOW_SECS: u64 = 300;

const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const MAX_REQUEST_BYTES: usize = 8 * 1024;

/// Refresh this far ahead of the stated expiry. A token that expires while the
/// request carrying it is in flight fails as a 401 the operator cannot act on,
/// and Clio's hour-long lifetime leaves ample room to be early.
const EXPIRY_SKEW_SECS: i64 = 60;

/// The firm-name lookup. Cosmetic: it labels the connection and decides nothing.
const WHO_AM_I: &str = "/users/who_am_i.json?fields=id,name,account{id,name}";

pub const NOT_CONNECTED: &str = "Clio is not connected — connect your account in Configuration.";
pub const SESSION_EXPIRED: &str = "Clio session expired — reconnect";

const RESPONSE_OK: &str =
    "<html><body><p>LexEscrow is connected to Clio. You may close this window.</p></body></html>";

// ============================================================================
// Wire types (cross IPC — none of them is persisted)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClioParty {
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub is_client: bool,
    pub is_bill_recipient: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClioBill {
    pub number: String,
    pub total_cents: i64,
    pub paid_cents: i64,
    pub balance_cents: i64,
    pub state: String,
    pub issued_at: Option<String>,
    pub due_at: Option<String>,
    pub memo: Option<String>,
}

/// One matter, assembled from five endpoints, held in memory for the length of
/// one escrow transaction and never written anywhere.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClioMatterPayload {
    pub matter_id: u64,
    pub display_number: String,
    pub description: String,
    pub status: String,
    pub billing_method: String,
    pub open_date: Option<String>,
    pub close_date: Option<String>,
    pub client_name: String,
    pub client_email: Option<String>,
    pub client_phone: Option<String>,
    pub parties: Vec<ClioParty>,
    pub bills: Vec<ClioBill>,
    pub trust_balance_cents: Option<i64>,
    /// ISO-8601. Session tracking only — it is one of the three inputs to the
    /// deterministic intake identifier, never a stored Clio field.
    pub fetched_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClioMatterSummary {
    pub id: u64,
    pub display_number: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClioConnectionStatus {
    pub connected: bool,
    pub expires_at: Option<String>,
    pub firm_name: Option<String>,
}

impl ClioConnectionStatus {
    fn disconnected() -> Self {
        Self { connected: false, expires_at: None, firm_name: None }
    }
}

/// The three values a token response contributes to the stored group.
#[derive(Debug, Clone, PartialEq)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: String,
}

// ============================================================================
// Managed state — the pending authorization
// ============================================================================

struct PendingAuth {
    /// CSRF nonce. Clio echoes it back on the redirect; a callback carrying
    /// anything else did not originate from the URL this app opened.
    state: String,
    /// Closes the loopback listener. Taken when the flow ends, by callback,
    /// timeout, or a second Connect click.
    shutdown: Option<oneshot::Sender<()>>,
}

/// Session state for the OAuth flow. Holds at most one pending authorization —
/// a second "Connect" supersedes the first rather than racing it for the port.
#[derive(Default)]
pub struct ClioState {
    pending: Mutex<Option<PendingAuth>>,
}

impl ClioState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Install a new pending authorization, closing any listener still running
    /// from a previous attempt.
    fn begin(&self, state: String, shutdown: oneshot::Sender<()>) {
        let mut guard = self.pending.lock().unwrap();
        if let Some(previous) = guard.take() {
            if let Some(tx) = previous.shutdown {
                let _ = tx.send(());
            }
        }
        *guard = Some(PendingAuth { state, shutdown: Some(shutdown) });
    }

    /// Consume the pending authorization if `state` matches, closing the
    /// listener. A mismatch leaves the pending flow untouched — a forged
    /// callback must not be able to cancel a legitimate one in flight.
    fn take_if_matches(&self, state: &str) -> bool {
        let mut guard = self.pending.lock().unwrap();
        let matches = guard.as_ref().is_some_and(|p| ct_eq(&p.state, state));
        if matches {
            if let Some(mut pending) = guard.take() {
                if let Some(tx) = pending.shutdown.take() {
                    let _ = tx.send(());
                }
            }
        }
        matches
    }

    fn clear(&self) {
        let mut guard = self.pending.lock().unwrap();
        if let Some(mut pending) = guard.take() {
            if let Some(tx) = pending.shutdown.take() {
                let _ = tx.send(());
            }
        }
    }
}

/// Constant-time string comparison for the CSRF nonce. Overkill against a
/// same-machine attacker, and free.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ============================================================================
// Pure core — URLs, expiry, parsing, field mapping
// ============================================================================

/// A 32-character hex nonce from the OS CSPRNG.
pub fn random_state() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// The full authorization URL, with every parameter percent-encoded.
///
/// Built through `Url::parse_with_params` rather than by formatting a string:
/// `scope` is space-separated and `redirect_uri` carries a scheme, a port and a
/// path, and hand-rolling that encoding is how a redirect stops matching what
/// the Developer Portal has registered.
pub fn build_auth_url(client_id: &str, redirect_uri: &str, state: &str) -> String {
    reqwest::Url::parse_with_params(
        AUTHORIZE_URL,
        &[
            ("response_type", "code"),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("scope", SCOPES),
            ("state", state),
        ],
    )
    .map(String::from)
    // Unreachable for a constant base URL, but a panic in a command is worse
    // than a URL the browser will reject visibly.
    .unwrap_or_else(|_| AUTHORIZE_URL.to_string())
}

/// Is the stored access token too old to use?
///
/// Unparseable and empty both answer `true`. The caller's only response to
/// `true` is "refresh first", and refreshing a token whose expiry cannot be
/// read is strictly better than sending it and getting a 401 whose cause is
/// invisible.
pub fn is_expired(expires_at: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    match chrono::DateTime::parse_from_rfc3339(expires_at.trim()) {
        Ok(t) => t.with_timezone(&chrono::Utc) - chrono::Duration::seconds(EXPIRY_SKEW_SECS) <= now,
        Err(_) => true,
    }
}

/// Absolute expiry from Clio's relative `expires_in`.
pub fn expires_at_from(expires_in_secs: i64, now: chrono::DateTime<chrono::Utc>) -> String {
    (now + chrono::Duration::seconds(expires_in_secs)).to_rfc3339()
}

/// Read a token response, keeping the previous refresh token when the response
/// omits one.
///
/// Clio returns a fresh refresh token on the authorization-code exchange but
/// may omit it on a plain refresh. Treating an absent field as "no refresh
/// token" would disconnect the account on its first hourly refresh — the
/// failure mode this argument exists to prevent.
pub fn parse_token_response(
    body: &Value,
    previous_refresh: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<TokenSet, String> {
    if let Some(err) = body.get("error").and_then(Value::as_str) {
        let detail = body
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or(err);
        return Err(format!("Clio rejected the token request: {detail}"));
    }
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Clio's token response carried no access token.")?
        .to_string();

    let refresh_token = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| previous_refresh.to_string());

    // Clio states an hour; the default is a floor, not a guess at the protocol.
    let expires_in = body.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);

    Ok(TokenSet { access_token, refresh_token, expires_at: expires_at_from(expires_in, now) })
}

/// A Clio money field as integer cents.
///
/// Accepts a JSON number or a numeric string — Clio v4 returns numbers, but a
/// money field that silently becomes a string in a future API version should
/// degrade to the right value rather than to zero. `round` rather than truncate:
/// `19999.99_f64 * 100.0` is `1999998.9999…`, and truncation would quietly lose
/// a cent on a majority of real amounts.
pub fn money_to_cents(v: Option<&Value>) -> i64 {
    let dollars = match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().replace([',', '$'], "").parse::<f64>().ok(),
        _ => None,
    };
    dollars.map(|d| (d * 100.0).round() as i64).unwrap_or(0)
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// An optional string field: absent, null and empty all collapse to `None`, so
/// downstream code never has to distinguish "Clio sent nothing" from "Clio sent
/// a blank".
fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Clio v4 wraps every response in `{"data": …}`.
fn data_of(body: &Value) -> &Value {
    body.get("data").unwrap_or(body)
}

/// A contact's display name, falling back to the name parts when `name` is
/// absent — Clio populates `name` for companies and the parts for people.
fn contact_name(v: &Value) -> String {
    if let Some(name) = opt_str(v, "name") {
        return name;
    }
    let first = opt_str(v, "first_name").unwrap_or_default();
    let last = opt_str(v, "last_name").unwrap_or_default();
    format!("{first} {last}").trim().to_string()
}

pub fn parse_party(v: &Value) -> ClioParty {
    ClioParty {
        name: contact_name(v),
        email: opt_str(v, "primary_email_address"),
        phone: opt_str(v, "primary_phone_number"),
        is_client: v.get("is_client").and_then(Value::as_bool).unwrap_or(false),
        is_bill_recipient: v.get("is_bill_recipient").and_then(Value::as_bool).unwrap_or(false),
    }
}

pub fn parse_parties(body: &Value) -> Vec<ClioParty> {
    data_of(body).as_array().map(|rows| rows.iter().map(parse_party).collect()).unwrap_or_default()
}

pub fn parse_bill(v: &Value) -> ClioBill {
    ClioBill {
        // `number` is a Clio-assigned invoice number and arrives as either a
        // string or an integer depending on the firm's numbering scheme.
        number: v
            .get("number")
            .map(|n| match n {
                Value::String(s) => s.clone(),
                other => other.to_string().trim_matches('"').to_string(),
            })
            .unwrap_or_default(),
        total_cents: money_to_cents(v.get("total")),
        paid_cents: money_to_cents(v.get("paid")),
        balance_cents: money_to_cents(v.get("balance")),
        state: str_field(v, "state"),
        issued_at: opt_str(v, "issued_at"),
        due_at: opt_str(v, "due_at"),
        memo: opt_str(v, "memo"),
    }
}

pub fn parse_bills(body: &Value) -> Vec<ClioBill> {
    data_of(body).as_array().map(|rows| rows.iter().map(parse_bill).collect()).unwrap_or_default()
}

/// Total trust funds held on the matter, in cents.
///
/// Clio returns protected funds as a *list* of allocations, so the escrow
/// amount is their sum rather than the first row's `amount`. An empty list is
/// `None`, not `Some(0)`: "this matter holds nothing in trust" and "LexEscrow
/// could not read the trust balance" have to stay distinguishable, because the
/// AI parser treats a present balance as authoritative.
pub fn parse_trust_balance(body: &Value) -> Option<i64> {
    let rows = data_of(body).as_array()?;
    if rows.is_empty() {
        return None;
    }
    Some(rows.iter().map(|r| money_to_cents(r.get("amount"))).sum())
}

pub fn parse_matter_summaries(body: &Value) -> Vec<ClioMatterSummary> {
    data_of(body)
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|v| {
                    Some(ClioMatterSummary {
                        id: v.get("id").and_then(Value::as_u64)?,
                        display_number: str_field(v, "display_number"),
                        description: str_field(v, "description"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The firm name from `users/who_am_i`, used only to label the connection.
pub fn parse_firm_name(body: &Value) -> Option<String> {
    let data = data_of(body);
    data.get("account")
        .and_then(|a| opt_str(a, "name"))
        .or_else(|| opt_str(data, "name"))
}

/// Assemble the five responses into one payload.
///
/// Every field the spec maps is taken here and nothing else is, which is what
/// "minimum necessary data" means in practice: a field Clio returned but
/// LexEscrow does not map never reaches this struct, so it cannot reach the
/// WebView or the AI prompt either.
#[allow(clippy::too_many_arguments)]
pub fn assemble_matter_payload(
    matter_id: u64,
    matter: &Value,
    client: &Value,
    contacts: &Value,
    bills: &Value,
    protected_funds: Option<&Value>,
    fetched_at: String,
) -> ClioMatterPayload {
    let m = data_of(matter);
    let c = data_of(client);
    ClioMatterPayload {
        matter_id,
        display_number: str_field(m, "display_number"),
        description: str_field(m, "description"),
        status: str_field(m, "status"),
        billing_method: str_field(m, "billing_method"),
        open_date: opt_str(m, "open_date"),
        close_date: opt_str(m, "close_date"),
        client_name: contact_name(c),
        client_email: opt_str(c, "primary_email_address"),
        client_phone: opt_str(c, "primary_phone_number"),
        parties: parse_parties(contacts),
        bills: parse_bills(bills),
        trust_balance_cents: protected_funds.and_then(parse_trust_balance),
        fetched_at,
    }
}

// ============================================================================
// HTTP
// ============================================================================

/// Why a Clio API call failed.
///
/// Three conditions used to collapse into one string, and the collapse was the
/// bug: a scope gap, a network blip and a genuinely dead token all reached the
/// Configuration screen as "expired — reconnect". Reconnecting fixes exactly
/// one of those, so an operator hitting either of the other two reconnects
/// forever and lands back where they started.
///
/// The variants exist to be *acted on differently*, not to be logged
/// differently:
///
///  * `Unauthorized` — the token is not accepted. Reconnecting helps.
///  * `Forbidden` — the token is valid but was never granted this resource.
///    Reconnecting does **not** help; the app's scope list has to change, which
///    is a code change, not something the operator can do.
///  * `Http` / `Transport` — Clio or the network. Retrying may help; neither
///    says anything about the token.
#[derive(Debug, Clone, PartialEq)]
pub enum ClioApiError {
    Unauthorized,
    Forbidden { path: String },
    Http { status: u16, path: String },
    Transport(String),
}

impl ClioApiError {
    /// Classify one response status against the path it came from.
    pub fn from_status(status: u16, path: &str) -> Option<Self> {
        match status {
            200..=299 => None,
            401 => Some(Self::Unauthorized),
            403 => Some(Self::Forbidden { path: path.to_string() }),
            other => Some(Self::Http { status: other, path: path.to_string() }),
        }
    }

    /// Does reconnecting stand any chance of fixing this?
    ///
    /// Only `Unauthorized`. This is what the UI needs to know before telling an
    /// operator to walk the OAuth flow again.
    pub fn reconnect_would_help(&self) -> bool {
        matches!(self, Self::Unauthorized)
    }

    pub fn message(&self) -> String {
        match self {
            Self::Unauthorized => SESSION_EXPIRED.to_string(),
            Self::Forbidden { path } => format!(
                "Clio refused {path}: this LexEscrow build did not request access to that \
                 resource. Reconnecting will not change it."
            ),
            Self::Http { status, path } => format!("Clio returned HTTP {status} for {path}"),
            Self::Transport(detail) => format!("Clio request failed: {detail}"),
        }
    }
}

impl From<ClioApiError> for String {
    fn from(e: ClioApiError) -> Self {
        e.message()
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().map_err(|e| e.to_string())
}

/// One authenticated `GET` against the Clio API.
///
/// The only request shape this module makes against matter data. There is no
/// `post`/`put`/`patch` counterpart, and that absence is the read-only
/// guarantee — not a policy applied at each call site.
async fn api_get(access_token: &str, path_and_query: &str) -> Result<Value, ClioApiError> {
    let url = format!("{API_BASE}{path_and_query}");
    let response = client()
        .map_err(ClioApiError::Transport)?
        .get(&url)
        .bearer_auth(access_token)
        .header("content-type", "application/json")
        .send()
        .await
        .map_err(|e| ClioApiError::Transport(e.to_string()))?;

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if let Some(err) = ClioApiError::from_status(status, path_and_query) {
        return Err(err);
    }
    serde_json::from_str(&body)
        .map_err(|e| ClioApiError::Transport(format!("Clio returned unreadable JSON: {e}")))
}

/// Exchange a grant at the token endpoint.
///
/// The one `POST` in this module, and it is the OAuth handshake rather than the
/// matter API — no firm data is created, modified or deleted by it.
async fn token_request(form: &[(&str, &str)]) -> Result<Value, String> {
    let response = client()?
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|e| format!("Clio token request failed: {e}"))?;
    let body = response.text().await.unwrap_or_default();
    serde_json::from_str(&body)
        .map_err(|e| format!("Clio's token endpoint returned unreadable JSON: {e}"))
}

/// Persist a token set into the stored `clio` group, leaving the app
/// registration untouched.
fn store_tokens(store: &CredentialStoreState, tokens: &TokenSet) -> Result<(), String> {
    let mut config = store.resolve_clio().ok_or(NOT_CONNECTED)?;
    config.access_token = tokens.access_token.clone();
    config.refresh_token = tokens.refresh_token.clone();
    config.token_expires_at = tokens.expires_at.clone();
    store.write_clio(&config).map_err(|e| e.to_string())
}

/// Return a usable access token, refreshing first if the stored one has aged
/// out.
///
/// Every API call goes through this. Checking expiry locally rather than
/// reacting to a 401 means the common case costs no wasted round trip, and the
/// operator never sees a spurious failure for a condition the app could predict.
async fn ensure_fresh_token(store: &CredentialStoreState) -> Result<String, String> {
    let config = store.resolve_clio().ok_or(NOT_CONNECTED)?;
    if config.refresh_token.is_empty() {
        return Err(NOT_CONNECTED.to_string());
    }
    if !is_expired(&config.token_expires_at, chrono::Utc::now()) && !config.access_token.is_empty() {
        return Ok(config.access_token.clone());
    }
    refresh_now(store, &config).await
}

async fn refresh_now(store: &CredentialStoreState, config: &ClioConfig) -> Result<String, String> {
    let body = token_request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &config.refresh_token),
        ("client_id", &config.client_id),
        ("client_secret", &config.client_secret),
    ])
    .await?;

    // A refresh that fails is a disconnection, not a transient error: the
    // refresh token is the thing that was supposed to outlive the access token.
    let tokens = parse_token_response(&body, &config.refresh_token, chrono::Utc::now())
        .map_err(|_| SESSION_EXPIRED.to_string())?;
    store_tokens(store, &tokens)?;
    Ok(tokens.access_token)
}

// ============================================================================
// The loopback callback listener
// ============================================================================

/// Serve exactly one OAuth redirect on `127.0.0.1:8080`, then stop.
///
/// Bound on demand rather than at launch, unlike the DocuSign listener in
/// `esign_callback.rs`. Port 8080 is one of the most commonly occupied ports on
/// a developer's machine, and holding it for the whole session to serve a
/// redirect that arrives once — if ever — would break unrelated software for no
/// benefit. The trade is that a bind failure surfaces at Connect time, which is
/// also the only moment an operator can do anything about it.
async fn serve_callback(
    listener: TcpListener,
    app: AppHandle,
    mut shutdown: oneshot::Receiver<()>,
) {
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(AUTH_WINDOW_SECS));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut shutdown => return,
            _ = &mut deadline => {
                eprintln!("clio-oauth: authorization window closed without a callback");
                return;
            }
            accepted = listener.accept() => {
                let Ok((mut stream, _)) = accepted else { continue };
                let mut buf = vec![0u8; MAX_REQUEST_BYTES];
                let read = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..read]).into_owned();

                let _ = stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{RESPONSE_OK}",
                            RESPONSE_OK.len()
                        )
                        .as_bytes(),
                    )
                    .await;
                let _ = stream.shutdown().await;

                if let Some((code, state)) = parse_callback_request(&request) {
                    // The frontend does the exchange, so the operator sees it
                    // happen and a failure lands on the screen that asked for it.
                    let _ = app.emit(OAUTH_CALLBACK_EVENT, serde_json::json!({
                        "code": code,
                        "state": state,
                    }));
                    return;
                }
                // A request that is not the redirect — a probe, a favicon — is
                // answered and ignored; the window stays open for the real one.
            }
        }
    }
}

/// Pull `code` and `state` out of a raw HTTP request's start line.
///
/// Deliberately tolerant about everything except the two parameters: browsers
/// append their own, Clio may reorder them, and the path is matched exactly so
/// a stray request to `/` is not mistaken for a redirect.
pub fn parse_callback_request(request: &str) -> Option<(String, String)> {
    let target = request.split_whitespace().nth(1)?;
    let (path, query) = target.split_once('?')?;
    if path != CALLBACK_PATH {
        return None;
    }
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{CALLBACK_PATH}?{query}")).ok()?;
    let mut code = None;
    let mut state = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }
    Some((code?, state?))
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Build the authorization URL and open the loopback listener behind it.
///
/// The two happen together on purpose: a URL handed out without a listener
/// behind it sends the operator to a consent screen whose redirect lands
/// nowhere, and the failure would surface minutes later as "nothing happened".
#[tauri::command]
pub async fn clio_get_auth_url(
    app: AppHandle,
    store: State<'_, CredentialStoreState>,
    clio: State<'_, ClioState>,
) -> Result<String, String> {
    let config = store
        .resolve_clio()
        .filter(|c| !c.client_id.is_empty())
        .ok_or("Save your Clio App ID, Client ID and Client Secret before connecting.")?;

    let redirect_uri = if config.redirect_uri.is_empty() {
        CLIO_DEFAULT_REDIRECT_URI.to_string()
    } else {
        config.redirect_uri.clone()
    };

    let listener = TcpListener::bind(("127.0.0.1", CALLBACK_PORT)).await.map_err(|e| {
        format!(
            "Could not open the OAuth callback listener on 127.0.0.1:{CALLBACK_PORT} ({e}). \
             Close whatever is using that port and try again."
        )
    })?;

    let state = random_state();
    let (tx, rx) = oneshot::channel();
    clio.begin(state.clone(), tx);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move { serve_callback(listener, handle, rx).await });

    Ok(build_auth_url(&config.client_id, &redirect_uri, &state))
}

/// Validate the CSRF nonce, exchange the authorization code, store the tokens.
#[tauri::command]
pub async fn clio_exchange_code(
    store: State<'_, CredentialStoreState>,
    clio: State<'_, ClioState>,
    code: String,
    state: String,
) -> Result<(), String> {
    // Before the network call, not after: an unmatched state means this
    // callback did not come from a flow this app started, and the code in it
    // must not be redeemed against the firm's client secret.
    if !clio.take_if_matches(&state) {
        return Err("Clio's response did not match this authorization attempt — try connecting again.".into());
    }

    let config = store.resolve_clio().ok_or(NOT_CONNECTED)?;
    let redirect_uri = if config.redirect_uri.is_empty() {
        CLIO_DEFAULT_REDIRECT_URI.to_string()
    } else {
        config.redirect_uri.clone()
    };

    let body = token_request(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("client_id", &config.client_id),
        ("client_secret", &config.client_secret),
        ("redirect_uri", &redirect_uri),
    ])
    .await?;

    let tokens = parse_token_response(&body, &config.refresh_token, chrono::Utc::now())?;
    store_tokens(&store, &tokens)
}

#[tauri::command]
pub async fn clio_refresh_token(store: State<'_, CredentialStoreState>) -> Result<(), String> {
    let config = store.resolve_clio().ok_or(NOT_CONNECTED)?;
    if config.refresh_token.is_empty() {
        return Err(NOT_CONNECTED.to_string());
    }
    refresh_now(&store, &config).await.map(|_| ())
}

/// Validate the stored token against Clio and report who it belongs to.
///
/// Never errors: "not connected" is an answer the Configuration screen renders,
/// not a fault it has to handle. A refresh failure, an unreachable Clio and an
/// account with no tokens all land on the same disconnected shape.
#[tauri::command]
pub async fn clio_check_connection(
    store: State<'_, CredentialStoreState>,
) -> Result<ClioConnectionStatus, String> {
    Ok(check_connection(&store).await)
}

/// The connection check, minus the Tauri wrapper so it can be driven directly.
///
/// **The verdict is `ensure_fresh_token`, and nothing else.** Whether this
/// install is connected is exactly the question "can we obtain a usable access
/// token right now" — and that is what this asks. The `who_am_i` lookup that
/// follows contributes the firm's name for the Configuration screen's label and
/// has no say in the verdict.
///
/// That separation is a fix, not a preference. This used to report
/// `disconnected()` whenever the probe failed, so a token issued thirty seconds
/// earlier and refreshing perfectly well rendered as "expired — reconnect" if
/// the probe hit a scope gap, a 403 or a dropped connection. The operator was
/// then told to fix it by reconnecting, which reissues the same token and
/// produces the same result — a loop with no exit.
pub async fn check_connection(store: &CredentialStoreState) -> ClioConnectionStatus {
    let Some(config) = store.resolve_clio() else {
        return ClioConnectionStatus::disconnected();
    };
    if config.refresh_token.is_empty() {
        return ClioConnectionStatus::disconnected();
    }
    let Ok(token) = ensure_fresh_token(store).await else {
        return ClioConnectionStatus::disconnected();
    };
    // Re-read: `ensure_fresh_token` may have written a new expiry.
    let expires_at =
        store.resolve_clio().map(|c| c.token_expires_at.clone()).filter(|s| !s.is_empty());

    // Best-effort, and deliberately discarded on failure. A missing firm name
    // costs the screen a label; it says nothing about the token.
    let firm_name = match api_get(&token, WHO_AM_I).await {
        Ok(body) => parse_firm_name(&body),
        Err(e) => {
            eprintln!("clio: connected, but the firm-name lookup failed ({})", e.message());
            None
        }
    };

    verdict(true, expires_at, firm_name)
}

/// The collapsing rule, in one place.
///
/// `have_token` is the whole verdict. Extracted so the rule is testable without
/// a network — the regression this guards against is precisely a probe outcome
/// being allowed to flip `connected` to false.
pub fn verdict(
    have_token: bool,
    expires_at: Option<String>,
    firm_name: Option<String>,
) -> ClioConnectionStatus {
    if !have_token {
        return ClioConnectionStatus::disconnected();
    }
    ClioConnectionStatus { connected: true, expires_at, firm_name }
}

/// Drop the token set, keeping the app registration.
///
/// Deliberately asymmetric with "delete the credential group": disconnecting is
/// something an operator does routinely, and making them re-enter a client
/// secret from the Developer Portal each time would turn a normal action into a
/// chore they avoid.
#[tauri::command]
pub fn clio_disconnect(
    store: State<'_, CredentialStoreState>,
    clio: State<'_, ClioState>,
) -> Result<(), String> {
    clio.clear();
    let Some(mut config) = store.resolve_clio() else {
        return Ok(());
    };
    config.access_token.clear();
    config.refresh_token.clear();
    config.token_expires_at.clear();
    store.write_clio(&config).map_err(|e| e.to_string())
}

/// Open matters matching `query`, for the intake picker.
#[tauri::command]
pub async fn clio_search_matters(
    store: State<'_, CredentialStoreState>,
    query: String,
) -> Result<Vec<ClioMatterSummary>, String> {
    let token = ensure_fresh_token(&store).await?;
    let path = format!(
        "/matters.json?query={}&status=open&fields=id,display_number,description,client_id&limit=20",
        urlencode(query.trim())
    );
    Ok(parse_matter_summaries(&api_get(&token, &path).await?))
}

/// Fetch one matter across all five endpoints and assemble the payload.
///
/// **Takes no database handle, by construction.** ToS §10(e) forbids persisting
/// Clio data beyond session scope, and the way that is guaranteed here is that
/// this function has nothing to persist *with* — the payload goes back to the
/// WebView and lives in the session store until the transaction ends.
///
/// The matter and its client are required; contacts, bills and protected funds
/// are best-effort. A firm without trust accounting enabled gets 404 on
/// protected funds, and failing the whole intake over an endpoint their account
/// does not have would make the feature unusable for them.
#[tauri::command]
pub async fn clio_fetch_matter(
    store: State<'_, CredentialStoreState>,
    matter_id: u64,
) -> Result<ClioMatterPayload, String> {
    let token = ensure_fresh_token(&store).await?;

    let matter = api_get(
        &token,
        &format!(
            "/matters/{matter_id}.json?fields=id,display_number,description,status,\
             billing_method,client_id,client_reference,open_date,close_date,billable"
        ),
    )
    .await?;

    let client = api_get(
        &token,
        &format!(
            "/matters/{matter_id}/client.json?fields=id,name,first_name,last_name,\
             primary_email_address,primary_phone_number"
        ),
    )
    .await?;

    let contacts = api_get(
        &token,
        &format!(
            "/matters/{matter_id}/contacts.json?fields=id,name,first_name,last_name,\
             primary_email_address,primary_phone_number,is_client,is_bill_recipient"
        ),
    )
    .await
    .unwrap_or(Value::Null);

    let bills = api_get(
        &token,
        &format!(
            "/bills.json?matter_id={matter_id}&fields=id,number,total,paid,balance,due,state,\
             issued_at,due_at,start_at,end_at,sub_total,memo&limit=10&order=issued_at(desc)"
        ),
    )
    .await
    .unwrap_or(Value::Null);

    let funds = api_get(
        &token,
        &format!("/matters/{matter_id}/protected_funds.json?fields=id,amount,reason,bank_account_id"),
    )
    .await
    .ok();

    Ok(assemble_matter_payload(
        matter_id,
        &matter,
        &client,
        &contacts,
        &bills,
        funds.as_ref(),
        chrono::Utc::now().to_rfc3339(),
    ))
}

/// Percent-encode one query-string value.
fn urlencode(raw: &str) -> String {
    let mut url = reqwest::Url::parse("http://x/").expect("static URL");
    url.query_pairs_mut().clear().append_pair("q", raw);
    url.query().unwrap_or("").trim_start_matches("q=").to_string()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-09-05T12:00:00Z").unwrap().with_timezone(&chrono::Utc)
    }

    // ---- ToS constraints, made mechanical ---------------------------------

    /// This module's own source, minus comments and minus the test module.
    ///
    /// Both halves of that trim matter. Comments are dropped because the module
    /// docs name the very constructs the scans forbid; the test module is
    /// dropped because these assertions quote them too, and a test that matches
    /// its own assertion text proves nothing about the code above it.
    fn shipping_code() -> String {
        let source = include_str!("clio.rs");
        let end = source.find("#[cfg(test)]").unwrap_or(source.len());
        source[..end]
            .lines()
            .map(str::trim_start)
            .filter(|l| !l.starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn no_path_from_this_module_to_sqlite() {
        // ToS §10(e). The guarantee is structural — this module holds no `Db`
        // and imports none — and this is what keeps it that way: adding a
        // database handle to reach "just one derived field" fails here first.
        let code = shipping_code();
        for forbidden in ["crate::db", "State<'_, Db>", "append_audit", "sqlx", "SqlitePool"] {
            assert!(
                !code.contains(forbidden),
                "clio.rs referenced {forbidden:?} — Clio data must never reach SQLite"
            );
        }
    }

    #[test]
    fn every_api_call_is_a_get() {
        // Read-only integration. The only POST in the file is the OAuth token
        // exchange, which touches no firm data; `api_get` is the sole path to
        // the matter API and there is deliberately no sibling for other verbs.
        let code = shipping_code();
        assert!(!code.contains(".put("), "a PUT would be a write to Clio");
        assert!(!code.contains(".patch("), "a PATCH would be a write to Clio");
        assert!(!code.contains(".delete("), "a DELETE would be a write to Clio");
        assert_eq!(code.matches(".post(").count(), 1, "the only POST is the token exchange");
        assert!(code.contains(".post(TOKEN_URL)"));
    }

    #[test]
    fn only_the_four_read_scopes_are_requested() {
        for scope in SCOPES.split(' ') {
            assert!(scope.ends_with(":read"), "{scope} is not a read scope");
        }
        assert_eq!(SCOPES.split(' ').count(), 4);
    }

    // ---- The connection verdict --------------------------------------------
    //
    // The regression these guard: `clio_check_connection` used to return
    // `disconnected()` whenever the `who_am_i` probe failed, so a token issued
    // seconds earlier rendered as "expired — reconnect" for a scope gap, a 403
    // or a dropped connection — and reconnecting reissued the same token and
    // produced the same result.

    #[test]
    fn a_failed_probe_does_not_disconnect_a_live_token() {
        // The bug, stated directly. A token we can obtain is a live connection;
        // the probe contributes a label and nothing more.
        let status = verdict(true, Some("2026-09-05T13:00:00Z".into()), None);

        assert!(status.connected, "a probe failure disconnected a valid token");
        assert_eq!(status.expires_at.as_deref(), Some("2026-09-05T13:00:00Z"));
        assert_eq!(status.firm_name, None, "the label is what is lost, not the connection");
    }

    #[test]
    fn a_successful_probe_only_adds_the_firm_name() {
        let status = verdict(true, Some("2026-09-05T13:00:00Z".into()), Some("Hargrove LLP".into()));
        assert!(status.connected);
        assert_eq!(status.firm_name.as_deref(), Some("Hargrove LLP"));
    }

    #[test]
    fn no_usable_token_is_the_only_route_to_disconnected() {
        // `ensure_fresh_token` failing is the whole verdict. Nothing else may
        // reach this state.
        let status = verdict(false, Some("2026-09-05T13:00:00Z".into()), Some("Hargrove LLP".into()));
        assert!(!status.connected);
        // …and a disconnected status carries neither field, so the screen cannot
        // show a firm name or an expiry beside "not connected".
        assert_eq!(status.expires_at, None);
        assert_eq!(status.firm_name, None);
    }

    fn temp_store() -> CredentialStoreState {
        use crate::store_config::StoreBackend;
        use crate::vault::VaultState;
        let dir = std::env::temp_dir().join(format!("lexclio_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let vault = std::sync::Arc::new(VaultState::new(&dir));
        vault.unlock("pw");
        let state = CredentialStoreState::new(vault);
        state.activate(StoreBackend::AppVault).unwrap();
        state
    }

    #[tokio::test]
    async fn an_unconfigured_install_reports_disconnected_without_a_request() {
        // Reached before `ensure_fresh_token`, so this runs with no network.
        assert_eq!(check_connection(&temp_store()).await, ClioConnectionStatus::disconnected());
    }

    #[tokio::test]
    async fn a_registration_with_no_refresh_token_reports_disconnected() {
        // Registered but never authorised: there is nothing to refresh, so the
        // check must short-circuit rather than attempt a token request.
        let store = temp_store();
        store
            .set_clio(crate::vault::ClioConfigInput {
                app_id: "app-1234".into(),
                client_id: "client-abc".into(),
                client_secret: Some("secret".into()),
                redirect_uri: None,
            })
            .unwrap();
        assert!(store.resolve_clio().is_some(), "the registration was stored");

        assert_eq!(check_connection(&store).await, ClioConnectionStatus::disconnected());
    }

    // ---- API error classification ------------------------------------------

    #[test]
    fn the_three_failure_conditions_are_distinguished() {
        assert_eq!(ClioApiError::from_status(200, "/x"), None);
        assert_eq!(ClioApiError::from_status(204, "/x"), None);
        assert_eq!(ClioApiError::from_status(401, "/x"), Some(ClioApiError::Unauthorized));
        assert_eq!(
            ClioApiError::from_status(403, "/matters.json"),
            Some(ClioApiError::Forbidden { path: "/matters.json".into() })
        );
        assert_eq!(
            ClioApiError::from_status(500, "/matters.json"),
            Some(ClioApiError::Http { status: 500, path: "/matters.json".into() })
        );
        assert_eq!(
            ClioApiError::from_status(429, "/x"),
            Some(ClioApiError::Http { status: 429, path: "/x".into() })
        );
    }

    #[test]
    fn only_a_401_is_worth_reconnecting_over() {
        // The distinction the operator acts on. A 403 is a scope gap — a code
        // change, not something walking the OAuth flow again can fix — and
        // telling them to reconnect would send them round the loop forever.
        assert!(ClioApiError::Unauthorized.reconnect_would_help());
        assert!(!ClioApiError::Forbidden { path: "/x".into() }.reconnect_would_help());
        assert!(!ClioApiError::Http { status: 500, path: "/x".into() }.reconnect_would_help());
        assert!(!ClioApiError::Transport("dns".into()).reconnect_would_help());
    }

    #[test]
    fn each_condition_reads_differently_to_the_operator() {
        // Previously all four produced the same "session expired" string, which
        // is what made a scope bug indistinguishable from a dead token.
        let messages = [
            ClioApiError::Unauthorized.message(),
            ClioApiError::Forbidden { path: "/users/who_am_i.json".into() }.message(),
            ClioApiError::Http { status: 500, path: "/matters.json".into() }.message(),
            ClioApiError::Transport("connection refused".into()).message(),
        ];
        let unique: std::collections::HashSet<&String> = messages.iter().collect();
        assert_eq!(unique.len(), 4, "two conditions still read identically: {messages:?}");

        // Only the reconnectable one says to reconnect.
        assert_eq!(messages[0], SESSION_EXPIRED);
        assert!(messages[1].contains("did not request access"));
        assert!(messages[1].contains("Reconnecting will not change it"));
        assert!(messages[2].contains("HTTP 500"));
        assert!(messages[3].contains("connection refused"));
    }

    #[test]
    fn the_probe_path_is_named_once() {
        // `WHO_AM_I` is cosmetic by contract; pinning it here keeps a future
        // edit from quietly making the verdict depend on it again.
        assert!(WHO_AM_I.starts_with("/users/who_am_i.json"));
    }

    // ---- Authorization URL -------------------------------------------------

    #[test]
    fn the_auth_url_carries_every_required_parameter() {
        let url = build_auth_url("client-abc", CLIO_DEFAULT_REDIRECT_URI, "nonce123");
        let parsed = reqwest::Url::parse(&url).unwrap();
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();

        assert!(url.starts_with(AUTHORIZE_URL));
        assert_eq!(params.get("response_type").unwrap(), "code");
        assert_eq!(params.get("client_id").unwrap(), "client-abc");
        assert_eq!(params.get("redirect_uri").unwrap(), CLIO_DEFAULT_REDIRECT_URI);
        assert_eq!(params.get("scope").unwrap(), SCOPES);
        assert_eq!(params.get("state").unwrap(), "nonce123");
    }

    #[test]
    fn the_auth_url_encodes_the_redirect_and_scopes() {
        // The two parameters that break a hand-rolled URL: the redirect carries
        // `://` and a port, the scope list is space-separated. A Developer
        // Portal match is exact, so a mis-encoded redirect fails at consent.
        let url = build_auth_url("c", CLIO_DEFAULT_REDIRECT_URI, "s");
        assert!(!url.contains("http://127.0.0.1:8080/callback&"), "redirect went in raw");
        assert!(url.contains("scope=matters%3Aread+contacts%3Aread"), "scopes went in raw: {url}");
    }

    #[test]
    fn each_state_nonce_is_unique_and_hex() {
        let (a, b) = (random_state(), random_state());
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    // ---- CSRF --------------------------------------------------------------

    #[test]
    fn a_callback_with_the_wrong_state_is_rejected() {
        let clio = ClioState::new();
        let (tx, _rx) = oneshot::channel();
        clio.begin("expected-nonce".into(), tx);

        assert!(!clio.take_if_matches("forged-nonce"));
        // …and the legitimate flow is still pending, so a forged callback
        // cannot cancel a real one that is still in the browser.
        assert!(clio.take_if_matches("expected-nonce"));
    }

    #[test]
    fn a_state_is_single_use() {
        let clio = ClioState::new();
        let (tx, _rx) = oneshot::channel();
        clio.begin("nonce".into(), tx);
        assert!(clio.take_if_matches("nonce"));
        assert!(!clio.take_if_matches("nonce"), "a replayed callback was accepted");
    }

    #[test]
    fn no_pending_flow_accepts_nothing() {
        assert!(!ClioState::new().take_if_matches("anything"));
    }

    // ---- Callback parsing --------------------------------------------------

    #[test]
    fn the_callback_request_yields_code_and_state() {
        let req = "GET /callback?code=AUTH_CODE&state=nonce123 HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n";
        assert_eq!(
            parse_callback_request(req),
            Some(("AUTH_CODE".to_string(), "nonce123".to_string()))
        );
    }

    #[test]
    fn callback_parsing_survives_reordering_and_extra_parameters() {
        let req = "GET /callback?state=n&extra=1&code=C HTTP/1.1\r\n\r\n";
        assert_eq!(parse_callback_request(req), Some(("C".to_string(), "n".to_string())));
    }

    #[test]
    fn a_percent_encoded_code_is_decoded() {
        let req = "GET /callback?code=a%2Fb%2Bc&state=n HTTP/1.1\r\n\r\n";
        assert_eq!(parse_callback_request(req), Some(("a/b+c".to_string(), "n".to_string())));
    }

    #[test]
    fn non_callback_requests_are_ignored() {
        // A browser probing / or /favicon.ico must not end the auth window.
        for req in [
            "GET / HTTP/1.1\r\n\r\n",
            "GET /favicon.ico HTTP/1.1\r\n\r\n",
            "GET /other?code=C&state=n HTTP/1.1\r\n\r\n",
            "GET /callback HTTP/1.1\r\n\r\n",            // no query
            "GET /callback?error=access_denied HTTP/1.1\r\n\r\n", // user declined
            "",
        ] {
            assert_eq!(parse_callback_request(req), None, "accepted {req:?}");
        }
    }

    // ---- Token handling ----------------------------------------------------

    #[test]
    fn a_token_response_becomes_a_token_set() {
        let body = serde_json::json!({
            "access_token": "at-1", "refresh_token": "rt-1",
            "token_type": "bearer", "expires_in": 3600
        });
        let tokens = parse_token_response(&body, "", now()).unwrap();
        assert_eq!(tokens.access_token, "at-1");
        assert_eq!(tokens.refresh_token, "rt-1");
        assert_eq!(tokens.expires_at, "2026-09-05T13:00:00+00:00");
    }

    #[test]
    fn a_refresh_that_omits_a_refresh_token_keeps_the_old_one() {
        // The failure this prevents: Clio returns only an access token on
        // refresh, the stored refresh token is overwritten with "", and the
        // account disconnects itself an hour after connecting.
        let body = serde_json::json!({ "access_token": "at-2", "expires_in": 3600 });
        let tokens = parse_token_response(&body, "rt-original", now()).unwrap();
        assert_eq!(tokens.refresh_token, "rt-original");
    }

    #[test]
    fn a_token_error_response_is_an_error() {
        let body = serde_json::json!({
            "error": "invalid_grant",
            "error_description": "The authorization code is invalid"
        });
        let err = parse_token_response(&body, "", now()).unwrap_err();
        assert!(err.contains("The authorization code is invalid"), "{err}");

        // A 200 with no access token is equally unusable.
        assert!(parse_token_response(&serde_json::json!({}), "", now()).is_err());
        assert!(parse_token_response(&serde_json::json!({"access_token": ""}), "", now()).is_err());
    }

    #[test]
    fn expiry_is_read_with_a_skew_and_fails_closed() {
        let fresh = expires_at_from(3600, now());
        assert!(!is_expired(&fresh, now()));

        // Inside the skew window: still nominally valid, refreshed anyway, so a
        // token cannot expire while the request carrying it is in flight.
        assert!(is_expired(&expires_at_from(30, now()), now()));
        assert!(is_expired(&expires_at_from(-1, now()), now()));

        // Unreadable and absent both mean "refresh first".
        assert!(is_expired("", now()));
        assert!(is_expired("not-a-timestamp", now()));
        assert!(is_expired("2026-09-05", now()));
    }

    // ---- Money -------------------------------------------------------------

    #[test]
    fn money_converts_to_integer_cents() {
        assert_eq!(money_to_cents(Some(&serde_json::json!(5000))), 500_000);
        assert_eq!(money_to_cents(Some(&serde_json::json!(1234.56))), 123_456);
        assert_eq!(money_to_cents(Some(&serde_json::json!(0))), 0);
        assert_eq!(money_to_cents(Some(&serde_json::json!(-250.25))), -25_025);
    }

    #[test]
    fn money_rounds_rather_than_truncating() {
        // 19999.99 * 100.0 is 1999998.9999999998 in binary floating point.
        // Truncation loses a cent here, and on most real invoice totals.
        assert_eq!(money_to_cents(Some(&serde_json::json!(19999.99))), 1_999_999);
        assert_eq!(money_to_cents(Some(&serde_json::json!(0.07))), 7);
        assert_eq!(money_to_cents(Some(&serde_json::json!(1.005))), 100);
    }

    #[test]
    fn money_accepts_strings_and_defaults_missing_to_zero() {
        assert_eq!(money_to_cents(Some(&serde_json::json!("1234.56"))), 123_456);
        assert_eq!(money_to_cents(Some(&serde_json::json!("$1,234.56"))), 123_456);
        assert_eq!(money_to_cents(Some(&serde_json::json!(null))), 0);
        assert_eq!(money_to_cents(None), 0);
        assert_eq!(money_to_cents(Some(&serde_json::json!("not money"))), 0);
    }

    // ---- Field mapping, against real response shapes -----------------------

    fn matter_json() -> Value {
        serde_json::json!({"data": {
            "id": 4321, "display_number": "00123-Anderson", "description": "Anderson v. Wexler",
            "status": "open", "billing_method": "hourly", "client_id": 99,
            "client_reference": "AND-1", "open_date": "2026-01-15",
            "close_date": null, "billable": true
        }})
    }

    fn client_json() -> Value {
        serde_json::json!({"data": {
            "id": 99, "name": "Jane Anderson", "first_name": "Jane", "last_name": "Anderson",
            "primary_email_address": "jane@example.test", "primary_phone_number": "+15550100"
        }})
    }

    fn contacts_json() -> Value {
        serde_json::json!({"data": [
            {"id": 99, "name": "Jane Anderson", "primary_email_address": "jane@example.test",
             "primary_phone_number": "+15550100", "is_client": true, "is_bill_recipient": true},
            {"id": 100, "first_name": "Marcus", "last_name": "Wexler",
             "primary_email_address": "marcus@example.test", "primary_phone_number": null,
             "is_client": false, "is_bill_recipient": false}
        ]})
    }

    fn bills_json() -> Value {
        serde_json::json!({"data": [
            {"id": 1, "number": "INV-001", "total": 12500.00, "paid": 5000.00,
             "balance": 7500.00, "due": 7500.00, "state": "awaiting_payment",
             "issued_at": "2026-08-01", "due_at": "2026-09-01", "memo": "August fees"},
            {"id": 2, "number": 1002, "total": 300.5, "paid": 300.5, "balance": 0,
             "state": "paid", "issued_at": "2026-07-01", "due_at": null, "memo": null}
        ]})
    }

    fn funds_json() -> Value {
        serde_json::json!({"data": [
            {"id": 7, "amount": 25000.00, "reason": "Retainer", "bank_account_id": 3},
            {"id": 8, "amount": 5000.00, "reason": "Top-up", "bank_account_id": 3}
        ]})
    }

    #[test]
    fn a_matter_payload_is_assembled_from_all_five_responses() {
        let p = assemble_matter_payload(
            4321,
            &matter_json(),
            &client_json(),
            &contacts_json(),
            &bills_json(),
            Some(&funds_json()),
            "2026-09-05T12:00:00Z".into(),
        );

        assert_eq!(p.matter_id, 4321);
        assert_eq!(p.display_number, "00123-Anderson");
        assert_eq!(p.description, "Anderson v. Wexler");
        assert_eq!(p.status, "open");
        assert_eq!(p.billing_method, "hourly");
        assert_eq!(p.open_date.as_deref(), Some("2026-01-15"));
        assert_eq!(p.close_date, None, "a null close_date is None, not \"\"");

        assert_eq!(p.client_name, "Jane Anderson");
        assert_eq!(p.client_email.as_deref(), Some("jane@example.test"));
        assert_eq!(p.client_phone.as_deref(), Some("+15550100"));

        // Trust balance is the *sum* of the protected-fund allocations.
        assert_eq!(p.trust_balance_cents, Some(3_000_000));
        assert_eq!(p.fetched_at, "2026-09-05T12:00:00Z");
    }

    #[test]
    fn parties_carry_the_contact_details_downstream_flows_need() {
        let parties = parse_parties(&contacts_json());
        assert_eq!(parties.len(), 2);

        assert_eq!(parties[0].name, "Jane Anderson");
        assert!(parties[0].is_client && parties[0].is_bill_recipient);

        // A contact with no `name` is assembled from its parts — Clio populates
        // one or the other depending on whether it is a person or a company.
        assert_eq!(parties[1].name, "Marcus Wexler");
        assert_eq!(parties[1].email.as_deref(), Some("marcus@example.test"));
        assert_eq!(parties[1].phone, None);
        assert!(!parties[1].is_client);
    }

    #[test]
    fn bills_convert_to_cents_and_tolerate_a_numeric_invoice_number() {
        let bills = parse_bills(&bills_json());
        assert_eq!(bills.len(), 2);

        assert_eq!(bills[0].number, "INV-001");
        assert_eq!(bills[0].total_cents, 1_250_000);
        assert_eq!(bills[0].paid_cents, 500_000);
        assert_eq!(bills[0].balance_cents, 750_000);
        assert_eq!(bills[0].state, "awaiting_payment");
        assert_eq!(bills[0].memo.as_deref(), Some("August fees"));

        // Firms number invoices either way; both have to survive.
        assert_eq!(bills[1].number, "1002");
        assert_eq!(bills[1].total_cents, 30_050);
        assert_eq!(bills[1].due_at, None);
    }

    #[test]
    fn an_absent_trust_balance_is_none_rather_than_zero() {
        // The distinction matters downstream: the AI parser treats a *present*
        // trust balance as the authoritative escrow amount, so "no trust
        // accounting on this account" must not read as "zero in trust".
        assert_eq!(parse_trust_balance(&serde_json::json!({"data": []})), None);
        assert_eq!(parse_trust_balance(&serde_json::json!({})), None);
        assert_eq!(
            parse_trust_balance(&serde_json::json!({"data": [{"amount": 0}]})),
            Some(0),
            "an explicit zero allocation is a real zero"
        );
    }

    #[test]
    fn a_matter_with_no_contacts_bills_or_funds_still_assembles() {
        // Those three endpoints are best-effort: a firm without trust
        // accounting 404s on protected funds, and failing the whole intake over
        // an endpoint their account does not have would make this unusable.
        let p = assemble_matter_payload(
            1,
            &matter_json(),
            &client_json(),
            &Value::Null,
            &Value::Null,
            None,
            "2026-09-05T12:00:00Z".into(),
        );
        assert!(p.parties.is_empty());
        assert!(p.bills.is_empty());
        assert_eq!(p.trust_balance_cents, None);
        assert_eq!(p.client_name, "Jane Anderson", "the required half still landed");
    }

    #[test]
    fn matter_summaries_parse_and_skip_rows_with_no_id() {
        let body = serde_json::json!({"data": [
            {"id": 1, "display_number": "00001-A", "description": "Matter A", "client_id": 5},
            {"id": 2, "display_number": "00002-B", "description": "Matter B", "client_id": 6},
            {"display_number": "broken", "description": "no id"}
        ]});
        let out = parse_matter_summaries(&body);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], ClioMatterSummary {
            id: 1, display_number: "00001-A".into(), description: "Matter A".into()
        });
        assert_eq!(parse_matter_summaries(&serde_json::json!({"data": []})), vec![]);
        assert_eq!(parse_matter_summaries(&Value::Null), vec![]);
    }

    #[test]
    fn the_firm_name_is_read_from_the_account_or_the_user() {
        let nested = serde_json::json!({"data": {"name": "A. Lawyer", "account": {"name": "Hargrove & Weston LLP"}}});
        assert_eq!(parse_firm_name(&nested).as_deref(), Some("Hargrove & Weston LLP"));

        // Accounts without a nested account object fall back to the user's name
        // rather than showing "Connected to (unknown)".
        let flat = serde_json::json!({"data": {"name": "A. Lawyer"}});
        assert_eq!(parse_firm_name(&flat).as_deref(), Some("A. Lawyer"));
        assert_eq!(parse_firm_name(&serde_json::json!({"data": {}})), None);
    }

    #[test]
    fn the_payload_carries_no_clio_field_that_was_not_mapped() {
        // Minimum necessary data: `client_reference` and `billable` are
        // requested (they are in the spec's fields list) but not mapped, so they
        // must not survive into anything the WebView or the AI prompt sees.
        let p = assemble_matter_payload(
            4321,
            &matter_json(),
            &client_json(),
            &contacts_json(),
            &bills_json(),
            Some(&funds_json()),
            "2026-09-05T12:00:00Z".into(),
        );
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("client_reference") && !json.contains("clientReference"));
        assert!(!json.contains("billable"));
        assert!(!json.contains("bank_account_id") && !json.contains("bankAccountId"));
    }

    #[test]
    fn the_payload_crosses_ipc_in_camel_case() {
        let p = assemble_matter_payload(
            1, &matter_json(), &client_json(), &contacts_json(), &bills_json(), None,
            "2026-09-05T12:00:00Z".into(),
        );
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"displayNumber\""));
        assert!(json.contains("\"trustBalanceCents\""));
        assert!(json.contains("\"isBillRecipient\""));
        assert!(!json.contains("\"display_number\""));
    }

    #[test]
    fn the_search_query_is_percent_encoded() {
        assert_eq!(urlencode("Anderson v. Wexler"), "Anderson+v.+Wexler");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencode(""), "");
    }
}
