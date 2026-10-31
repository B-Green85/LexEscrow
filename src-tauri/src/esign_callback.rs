// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

//! Embedded signing return-URL listener (spec Part II, §22).
//!
//! DocuSign's embedded signing ceremony ends by redirecting the *browser* to a
//! return URL with the outcome in the query string. For an email envelope that
//! redirect lands wherever the signer happens to be; for an embedded one it has
//! to land back on us, because the WebView we opened the ceremony in is the
//! only thing that knows the signing is over.
//!
//! So this is a loopback listener, not a webhook. §16 rejected DocuSign Connect
//! precisely because a webhook needs a public HTTPS endpoint and a sovereign
//! desktop app has none — and nothing here changes that. The socket binds to
//! `127.0.0.1` only: the sole client is a WebView on this machine following a
//! redirect, so there is no inbound network exposure and no port to forward.
//!
//! One route, one method, no state:
//!
//!   GET /esign-complete?event={event}&envelopeId={id}
//!     → emits `esign:embedded_complete` to the frontend
//!     → answers a plain HTML page telling the signer they may close the window
//!
//! Everything consequential still happens on the frontend's terms. This
//! listener reports *that* the ceremony ended and how; the completion pipeline
//! (certificate download → ArtifactGuard hash → AnchorReceipt registration →
//! AnchorMatcher) then re-derives the outcome from DocuSign itself. A forged
//! request to this port can therefore make the UI look, briefly, at an
//! envelope — it cannot fulfill a condition or move funds.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

/// Fixed by the return URL registered with DocuSign — it cannot be negotiated
/// at runtime, because the redirect target is baked into the ceremony before
/// the signer ever sees it.
pub const CALLBACK_PORT: u16 = 55432;
pub const CALLBACK_PATH: &str = "/esign-complete";
pub const EMBEDDED_COMPLETE_EVENT: &str = "esign:embedded_complete";

/// Enough for a redirect's request line and headers; anything larger is not a
/// DocuSign return and is answered from whatever prefix arrived.
const MAX_REQUEST_BYTES: usize = 8 * 1024;

const RESPONSE_BODY: &str =
    "<html><body><p>You may close this window and return to LexEscrow.</p></body></html>";

/// The payload the frontend receives on `esign:embedded_complete`.
///
/// `event` is DocuSign's own vocabulary, passed through unmodified:
/// `signing_complete`, `cancel`, `decline`, `session_timeout`, `ttl_expired`,
/// `viewing_complete`. Mapping it to a LexEscrow status is the frontend's job —
/// the two vocabularies are not the same size and collapsing them here would
/// lose the distinction between "declined" and "timed out".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedSigningResult {
    pub envelope_id: String,
    pub event: String,
}

/// Handle to the running listener, kept in Tauri managed state so app exit can
/// close the socket instead of leaving it bound until the process dies.
pub struct CallbackServer {
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl CallbackServer {
    /// Stop the listener. Idempotent — a second call is a no-op, which matters
    /// because `RunEvent::Exit` is not guaranteed to fire exactly once.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.shutdown.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
    }
}

/// Bind the listener and serve it on the Tauri async runtime.
///
/// A bind failure is logged and swallowed rather than propagated: port 55432
/// being occupied breaks embedded signing, but email signing, escrow monitoring
/// and settlement all still work, and refusing to start the whole application
/// over one optional feature is the wrong trade.
pub fn spawn(app: AppHandle) -> CallbackServer {
    let (tx, rx) = oneshot::channel();

    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", CALLBACK_PORT)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!(
                    "esign-callback: could not bind 127.0.0.1:{CALLBACK_PORT} ({e}) — \
                     embedded signing will not report completion."
                );
                return;
            }
        };
        eprintln!("esign-callback: listening on http://127.0.0.1:{CALLBACK_PORT}{CALLBACK_PATH}");
        serve(listener, app, rx).await;
        eprintln!("esign-callback: stopped");
    });

    CallbackServer {
        shutdown: Mutex::new(Some(tx)),
    }
}

/// Accept loop. Each connection is handled on its own task so a signer whose
/// browser opens the socket and stalls cannot block the next redirect.
async fn serve(listener: TcpListener, app: AppHandle, mut shutdown: oneshot::Receiver<()>) {
    loop {
        tokio::select! {
            _ = &mut shutdown => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = handle_connection(stream, &app).await {
                            eprintln!("esign-callback: connection error: {e}");
                        }
                    });
                }
                // A single failed accept is transient (fd exhaustion, a client
                // vanishing mid-handshake); the loop keeps serving.
                Err(e) => eprintln!("esign-callback: accept failed: {e}"),
            },
        }
    }
}

async fn handle_connection(mut stream: TcpStream, app: &AppHandle) -> std::io::Result<()> {
    let request = read_request_head(&mut stream).await?;

    if let Some(result) = parse_callback(&request) {
        eprintln!(
            "esign-callback: envelope {} → {}",
            result.envelope_id, result.event
        );
        // An emit failure means the WebView is already gone (the user closed
        // the app mid-ceremony). The signer still gets their page.
        if let Err(e) = app.emit(EMBEDDED_COMPLETE_EVENT, result) {
            eprintln!("esign-callback: emit failed: {e}");
        }
    }

    write_response(&mut stream).await
}

/// The one response this server ever writes.
///
/// The same 200 for every request. This page is read by a human who just
/// finished signing, not by a machine that branches on the status code, and a
/// 404 would only make a successful signature look broken.
async fn write_response(stream: &mut TcpStream) -> std::io::Result<()> {
    let response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         Cache-Control: no-store\r\n\
         \r\n\
         {}",
        RESPONSE_BODY.len(),
        RESPONSE_BODY
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

/// Read until the end of the header block, or until the cap.
///
/// The body is deliberately not read: this endpoint only ever answers a GET
/// redirect, so everything meaningful is in the request line.
async fn read_request_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];

    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break; // client closed
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() >= MAX_REQUEST_BYTES {
            break;
        }
    }

    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// ============================================================================
// Request parsing
// ============================================================================

/// Extract the signing outcome from a raw HTTP request, or `None` if this is
/// not a well-formed callback.
///
/// Both parameters are required. A redirect carrying an event but no envelope
/// id identifies no transaction, and one carrying an id but no event says
/// nothing about what happened — neither is something the frontend can act on,
/// so neither is emitted.
pub fn parse_callback(request: &str) -> Option<EmbeddedSigningResult> {
    let request_line = request.lines().next()?;
    let mut parts = request_line.split_whitespace();

    if !parts.next()?.eq_ignore_ascii_case("GET") {
        return None;
    }

    let target = parts.next()?;
    let (path, query) = target.split_once('?')?;
    if path != CALLBACK_PATH {
        return None;
    }

    let mut event = None;
    let mut envelope_id = None;
    for (key, value) in query_pairs(query) {
        match key.as_str() {
            "event" => event = Some(value),
            // DocuSign's own casing. Accept the lowercase spelling too so a
            // hand-built test URL behaves the same as a real redirect.
            "envelopeId" | "envelopeid" => envelope_id = Some(value),
            _ => {}
        }
    }

    let event = event.filter(|e| !e.is_empty())?;
    let envelope_id = envelope_id.filter(|e| !e.is_empty())?;
    Some(EmbeddedSigningResult { envelope_id, event })
}

/// Split a query string into decoded key/value pairs.
fn query_pairs(query: &str) -> impl Iterator<Item = (String, String)> + '_ {
    query.split('&').filter_map(|pair| {
        if pair.is_empty() {
            return None;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        Some((percent_decode(key), percent_decode(value)))
    })
}

/// Minimal `application/x-www-form-urlencoded` decoding.
///
/// Operates on bytes and rebuilds through `from_utf8_lossy`, so a multi-byte
/// UTF-8 character split across several `%XX` escapes reassembles correctly —
/// decoding per-escape into a `char` would not.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(&input[i + 1..i + 3], 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    // A stray '%' that is not an escape is literal.
                    Err(_) => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }

    String::from_utf8_lossy(&out).into_owned()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn get(target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: localhost:55432\r\n\r\n")
    }

    #[test]
    fn parses_a_signing_complete_redirect() {
        let r = parse_callback(&get(
            "/esign-complete?event=signing_complete&envelopeId=DEMO-ENV-1",
        ))
        .unwrap();
        assert_eq!(r.event, "signing_complete");
        assert_eq!(r.envelope_id, "DEMO-ENV-1");
    }

    #[test]
    fn parses_every_docusign_event_value() {
        for event in [
            "signing_complete",
            "cancel",
            "decline",
            "session_timeout",
            "ttl_expired",
            "viewing_complete",
        ] {
            let r = parse_callback(&get(&format!("/esign-complete?event={event}&envelopeId=e1")))
                .unwrap();
            assert_eq!(r.event, event, "event {event} should pass through verbatim");
        }
    }

    #[test]
    fn query_parameter_order_does_not_matter() {
        let r = parse_callback(&get("/esign-complete?envelopeId=e1&event=cancel")).unwrap();
        assert_eq!(r.envelope_id, "e1");
        assert_eq!(r.event, "cancel");
    }

    #[test]
    fn ignores_unrelated_query_parameters() {
        let r = parse_callback(&get(
            "/esign-complete?utm=x&event=decline&envelopeId=e1&extra=",
        ))
        .unwrap();
        assert_eq!(r.event, "decline");
    }

    #[test]
    fn percent_encoded_values_are_decoded() {
        let r = parse_callback(&get(
            "/esign-complete?event=signing_complete&envelopeId=a%2Fb%20c",
        ))
        .unwrap();
        assert_eq!(r.envelope_id, "a/b c");
    }

    #[test]
    fn rejects_other_paths_and_methods() {
        assert!(parse_callback(&get("/other?event=signing_complete&envelopeId=e1")).is_none());
        assert!(parse_callback(
            "POST /esign-complete?event=signing_complete&envelopeId=e1 HTTP/1.1\r\n\r\n"
        )
        .is_none());
    }

    #[test]
    fn rejects_a_callback_missing_either_parameter() {
        // Half a callback identifies no transaction, or reports no outcome.
        assert!(parse_callback(&get("/esign-complete?event=signing_complete")).is_none());
        assert!(parse_callback(&get("/esign-complete?envelopeId=e1")).is_none());
        assert!(parse_callback(&get("/esign-complete?event=&envelopeId=e1")).is_none());
        assert!(parse_callback(&get("/esign-complete?event=cancel&envelopeId=")).is_none());
        assert!(parse_callback(&get("/esign-complete")).is_none());
    }

    #[test]
    fn rejects_junk_without_panicking() {
        assert!(parse_callback("").is_none());
        assert!(parse_callback("\r\n\r\n").is_none());
        assert!(parse_callback("GET").is_none());
        assert!(parse_callback("not an http request at all").is_none());
    }

    #[test]
    fn percent_decode_reassembles_multibyte_sequences() {
        // One character split across three escapes — decoding each escape as a
        // char would produce mojibake here.
        assert_eq!(percent_decode("%E2%9C%85"), "✅");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    // ── Socket round trip ───────────────────────────────────────────────────

    /// Serve exactly one request on an ephemeral port and hand back what the
    /// client received, plus what the server read. Covers the parts the parser
    /// tests cannot reach: the framing, the read loop's terminator, and the
    /// response bytes actually on the wire.
    async fn round_trip(request: &str) -> (String, String) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let received = read_request_head(&mut stream).await.unwrap();
            write_response(&mut stream).await.unwrap();
            received
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();

        (server.await.unwrap(), response)
    }

    #[tokio::test]
    async fn answers_a_redirect_with_the_close_window_page() {
        let (received, response) = round_trip(&get(
            "/esign-complete?event=signing_complete&envelopeId=DEMO-ENV-1",
        ))
        .await;

        // The server read a complete, parseable callback…
        let parsed = parse_callback(&received).unwrap();
        assert_eq!(parsed.envelope_id, "DEMO-ENV-1");
        assert_eq!(parsed.event, "signing_complete");

        // …and the signer got a page telling them they are done.
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Content-Type: text/html"));
        assert!(response.contains("You may close this window and return to LexEscrow."));
    }

    #[tokio::test]
    async fn a_request_that_is_not_a_callback_still_gets_a_page() {
        // Nothing is emitted, but the connection is answered rather than hung:
        // a stray browser hitting the port must not leave a socket dangling.
        let (received, response) = round_trip(&get("/favicon.ico")).await;
        assert!(parse_callback(&received).is_none());
        assert!(response.starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn the_result_serializes_camel_case_for_the_frontend() {
        let json = serde_json::to_string(&EmbeddedSigningResult {
            envelope_id: "e1".into(),
            event: "signing_complete".into(),
        })
        .unwrap();
        assert!(json.contains("\"envelopeId\":\"e1\""));
        assert!(json.contains("\"event\":\"signing_complete\""));
    }
}
