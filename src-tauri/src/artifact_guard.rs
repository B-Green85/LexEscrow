//! ArtifactGuard — the integrity baseline for LexEscrow.
//!
//! Two jobs, both deterministic and both performed in the Rust backend so they
//! can never be tampered with from the WebView:
//!
//!   1. **Hashing.** SHA-256 of every loaded artifact, computed on load and
//!      re-checked at each workflow stage. A final *blocking* re-verify runs the
//!      moment the user presses *Proceed to Execution* (spec edge case #1 — the
//!      artifact-state desynchronization race).
//!   2. **Normalization.** All artifact text is normalized to a clean UTF-8
//!      stream before AI or any LexGuard module touches it — zero-width spaces,
//!      BOMs, soft hyphens, bidi controls and other invisibles are stripped so
//!      AI and LexGuard observe *the same* characters (spec edge case #2 — AI
//!      hallucination via hidden-character splitting).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};

/// SHA-256 registry mapping `filename → "sha256:<hex>"` baseline hash.
#[derive(Default)]
pub struct ArtifactGuard {
    registry: HashMap<String, String>,
}

impl ArtifactGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the integrity baseline for `filename`, returning the hash.
    /// Re-registering the same filename overwrites the baseline (a deliberate
    /// re-load after a detected change).
    pub fn register(&mut self, filename: &str, bytes: &[u8]) -> String {
        let hash = hash_artifact(bytes);
        self.registry.insert(filename.to_string(), hash.clone());
        hash
    }

    /// Byte-level integrity check against the recorded baseline. Returns `false`
    /// if the file was never registered — an unknown artifact is never trusted.
    pub fn verify(&self, filename: &str, bytes: &[u8]) -> bool {
        match self.registry.get(filename) {
            Some(original) => original == &hash_artifact(bytes),
            None => false,
        }
    }

    // Session-lifecycle accessors used by later phases (status surface,
    // session close); retained as public API.
    #[allow(dead_code)]
    pub fn baseline(&self, filename: &str) -> Option<&str> {
        self.registry.get(filename).map(String::as_str)
    }

    #[allow(dead_code)]
    pub fn is_registered(&self, filename: &str) -> bool {
        self.registry.contains_key(filename)
    }

    /// Drop all baselines — called when a session closes.
    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.registry.clear();
    }
}

/// SHA-256 of raw bytes, prefixed `sha256:` to make the algorithm explicit in
/// every stored hash and audit-log entry.
pub fn hash_artifact(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

/// Normalize artifact text to a clean UTF-8 stream before any extraction.
///
/// Removes hidden/invisible characters that let a malicious or badly-encoded
/// document show one thing to a regex and another to an AI tokenizer:
///   * zero-width spaces / joiners / word-joiner / BOM / soft hyphen,
///   * bidirectional format controls (LRM/RLM/embeddings/isolates — the
///     "trojan source" family),
///   * C0/C1 control characters (except the whitespace `\n` and `\t`).
///
/// Unlike a naive "strip every control char" pass, this *preserves* line
/// structure: `\r\n`/`\r` collapse to `\n`, Unicode spaces fold to a plain
/// space, and line/paragraph separators fold to `\n`. Section- and
/// position-inference in the VDB depend on that structure surviving.
pub fn normalize_artifact_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            // Collapse CRLF / lone CR into a single LF.
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            // Structural whitespace we keep verbatim.
            '\n' | '\t' => out.push(c),

            // Explicitly hidden / zero-width / bidi-control characters -> drop.
            '\u{200B}'                    // ZERO WIDTH SPACE
            | '\u{200C}'                  // ZERO WIDTH NON-JOINER
            | '\u{200D}'                  // ZERO WIDTH JOINER
            | '\u{2060}'                  // WORD JOINER
            | '\u{FEFF}'                  // BOM / ZERO WIDTH NO-BREAK SPACE
            | '\u{00AD}'                  // SOFT HYPHEN
            | '\u{180E}'                  // MONGOLIAN VOWEL SEPARATOR
            | '\u{200E}' | '\u{200F}'     // LEFT/RIGHT-TO-LEFT MARK
            | '\u{202A}'..='\u{202E}'     // bidi embeddings/overrides
            | '\u{2066}'..='\u{2069}' => {} // bidi isolates

            // Unicode spaces fold to a plain ASCII space.
            '\u{00A0}'                    // NO-BREAK SPACE
            | '\u{2000}'..='\u{200A}'     // EN QUAD .. HAIR SPACE
            | '\u{202F}'                  // NARROW NO-BREAK SPACE
            | '\u{205F}'                  // MEDIUM MATHEMATICAL SPACE
            | '\u{3000}' => out.push(' '), // IDEOGRAPHIC SPACE

            // Line / paragraph separators fold to a newline.
            '\u{2028}' | '\u{2029}' => out.push('\n'),

            // Any remaining control character -> drop.
            c if c.is_control() => {}

            // Everything visible is kept as-is.
            c => out.push(c),
        }
    }

    out
}

/// Error surfaced when the final blocking re-verify fails. Serializable so it
/// can cross the Tauri IPC boundary directly to the WebView.
#[derive(Debug, Serialize, thiserror::Error)]
#[error("{reason}")]
pub struct ExecutionBlockedError {
    pub reason: String,
}

/// Pure final-verify logic: the artifact must byte-for-byte match the baseline
/// captured at parse time, or execution is blocked.
pub fn verify_or_block(
    guard: &ArtifactGuard,
    filename: &str,
    bytes: &[u8],
) -> Result<(), ExecutionBlockedError> {
    if guard.verify(filename, bytes) {
        Ok(())
    } else {
        Err(ExecutionBlockedError {
            reason: "Artifact modified after parsing — re-review required".into(),
        })
    }
}

// ============================================================================
// Tauri IPC surface
// ============================================================================

/// Shared, session-scoped registry managed by Tauri and guarded by a mutex.
pub struct ArtifactGuardState(pub Mutex<ArtifactGuard>);

impl ArtifactGuardState {
    pub fn new() -> Self {
        Self(Mutex::new(ArtifactGuard::new()))
    }
}

impl Default for ArtifactGuardState {
    fn default() -> Self {
        Self::new()
    }
}

/// Result of loading an artifact: the integrity hash plus the normalized text
/// stream handed to the VDB / AI / LexGuard.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedArtifact {
    pub filename: String,
    pub hash: String,
    pub size: usize,
    pub normalized_text: String,
}

/// Load an artifact in one call: register its SHA-256 baseline and return the
/// normalized UTF-8 text. Hashing happens over the *raw* bytes; normalization
/// applies only to the text stream downstream consumers read.
#[tauri::command]
pub fn load_artifact(
    state: tauri::State<'_, ArtifactGuardState>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<LoadedArtifact, String> {
    let normalized_text = normalize_artifact_text(&String::from_utf8_lossy(&bytes));
    let size = bytes.len();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let hash = guard.register(&filename, &bytes);
    Ok(LoadedArtifact {
        filename,
        hash,
        size,
        normalized_text,
    })
}

/// Register (or re-register) an artifact's SHA-256 baseline. Mirrors the
/// LexGuard `registerArtifact` bridge signature.
#[tauri::command]
pub fn register_artifact(
    state: tauri::State<'_, ArtifactGuardState>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.register(&filename, &bytes))
}

/// Non-blocking integrity check used at intermediate workflow stages.
#[tauri::command]
pub fn verify_artifact(
    state: tauri::State<'_, ArtifactGuardState>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.verify(&filename, &bytes))
}

/// Blocking final re-verify — called synchronously on *Proceed to Execution*.
/// A hash mismatch returns `ExecutionBlockedError` and halts the workflow.
#[tauri::command]
pub fn final_verify_before_execution(
    state: tauri::State<'_, ArtifactGuardState>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<(), ExecutionBlockedError> {
    let guard = state.0.lock().map_err(|e| ExecutionBlockedError {
        reason: format!("integrity registry unavailable: {e}"),
    })?;
    verify_or_block(&guard, &filename, &bytes)
}

/// Expose normalization directly (e.g. for re-normalizing pasted text).
#[tauri::command]
pub fn normalize_text(raw: String) -> String {
    normalize_artifact_text(&raw)
}

// ============================================================================
// AnchorReceipt — HMAC seal (spec §8)
// ============================================================================
//
// ArtifactGuard answers "have these bytes changed this session". The seal
// answers a second, different question: "did *this system* attest this exact
// fingerprint for these exact bytes". A bare SHA-256 travelling between parties
// can be swapped wholesale — substitute both the document and its hash and the
// pair still verifies. Keying the digest defeats that: only a holder of the
// seal key can produce a seal that matches a given (hash, size).
//
// Size is bound into the sealed material alongside the hash because it is the
// cheapest independent check a counterparty can run on a document they hold,
// and sealing it stops a fingerprint being re-pointed at a different artifact
// that happens to share a truncated hash prefix in some downstream display.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use std::sync::OnceLock;

type HmacSha256 = Hmac<Sha256>;

/// V1 application seal secret.
///
/// Deliberately *stable across restarts*, not per-process-random: spec §8's
/// registry claim is "was this exact document version ever registered, and
/// when" — a provenance claim across time. A key regenerated each launch would
/// make every seal issued before the last restart unreproducible, which is
/// exactly the cross-session lookup the layer exists to provide.
///
/// V2 sources this from the AES-256-GCM credential vault (`vault.rs`) so the
/// seal key is per-install and password-gated rather than compiled in. Until
/// then the seal is an integrity primitive, not a secrecy one — it binds a
/// fingerprint to *a LexEscrow build*, and the on-chain registration (which is
/// public and decentralized) carries the stronger trust claim.
const APP_SEAL_SECRET: &[u8] = b"lexescrow.anchor-receipt.seal.v1";

/// Domain separator — keeps this key distinct from any other HMAC LexEscrow
/// might later derive from the same secret.
const SEAL_KEY_DOMAIN: &[u8] = b"lexescrow/anchor-receipt/seal/v1\x1f";

/// Derived once per process; the derivation itself is deterministic.
static SEAL_KEY: OnceLock<[u8; 32]> = OnceLock::new();

fn seal_key() -> &'static [u8; 32] {
    SEAL_KEY.get_or_init(|| {
        let mut hasher = Sha256::new();
        hasher.update(SEAL_KEY_DOMAIN);
        hasher.update(APP_SEAL_SECRET);
        hasher.finalize().into()
    })
}

/// The exact bytes the seal covers: `"{hash}|{size}"`.
///
/// Pulled out as its own function so the canonical form is defined in one
/// place — a seal is only comparable across parties if every implementation
/// agrees on the string byte-for-byte.
pub fn seal_material(hash: &str, size: u64) -> String {
    format!("{hash}|{size}")
}

/// HMAC-SHA256 over the canonical material, base64url-encoded without padding
/// (matching the receipt format in spec §8, which shows an unpadded seal).
pub fn compute_seal(hash: &str, size: u64) -> String {
    // `new_from_slice` only errors for key lengths HMAC cannot accept; a
    // 32-byte key is always valid, so this cannot fail in practice.
    let mut mac = HmacSha256::new_from_slice(seal_key()).expect("HMAC accepts a 32-byte key");
    mac.update(seal_material(hash, size).as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// Seal a fingerprint for AnchorReceipt registration.
///
/// Takes `ArtifactGuardState` so a poisoned registry surfaces here rather than
/// letting a seal be issued by a backend whose integrity baseline has already
/// failed — sealing a fingerprint is an attestation, and attesting from a
/// broken guard is precisely what must not happen.
#[tauri::command]
pub async fn compute_hmac_seal(
    state: tauri::State<'_, ArtifactGuardState>,
    hash: String,
    size: u64,
) -> Result<String, String> {
    // Scoped so the (non-Send) guard is dropped before this future can yield.
    {
        let _guard = state
            .0
            .lock()
            .map_err(|e| format!("integrity registry unavailable: {e}"))?;
    }
    Ok(compute_seal(&hash, size))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic_and_prefixed() {
        let a = hash_artifact(b"retainer agreement");
        let b = hash_artifact(b"retainer agreement");
        assert_eq!(a, b);
        assert!(a.starts_with("sha256:"));
        // 7-char prefix + 64 hex chars
        assert_eq!(a.len(), "sha256:".len() + 64);
    }

    #[test]
    fn different_bytes_hash_differently() {
        assert_ne!(hash_artifact(b"$3,200.00"), hash_artifact(b"$4,200.00"));
    }

    #[test]
    fn verify_matches_only_identical_bytes() {
        let mut g = ArtifactGuard::new();
        g.register("retainer.txt", b"unearned balance: $3,200.00");
        assert!(g.verify("retainer.txt", b"unearned balance: $3,200.00"));
        assert!(!g.verify("retainer.txt", b"unearned balance: $4,200.00"));
    }

    #[test]
    fn verify_unregistered_is_false() {
        let g = ArtifactGuard::new();
        assert!(!g.verify("never-seen.txt", b"anything"));
    }

    #[test]
    fn final_verify_blocks_on_mismatch() {
        let mut g = ArtifactGuard::new();
        g.register("doc.pdf", b"original");
        assert!(verify_or_block(&g, "doc.pdf", b"original").is_ok());
        let err = verify_or_block(&g, "doc.pdf", b"tampered").unwrap_err();
        assert!(err.reason.contains("modified after parsing"));
    }

    #[test]
    fn normalization_strips_zero_width_and_bom() {
        // "$4,200" with a zero-width space hidden inside and a leading BOM.
        let raw = "\u{FEFF}$4,\u{200B}200.00";
        assert_eq!(normalize_artifact_text(raw), "$4,200.00");
    }

    #[test]
    fn normalization_strips_soft_hyphen_and_bidi_controls() {
        let raw = "Cli\u{00AD}ent \u{202E}Name\u{202C}";
        assert_eq!(normalize_artifact_text(raw), "Client Name");
    }

    #[test]
    fn normalization_preserves_newlines_and_folds_crlf() {
        let raw = "Section 1\r\nSection 2\rSection 3\nSection 4";
        assert_eq!(
            normalize_artifact_text(raw),
            "Section 1\nSection 2\nSection 3\nSection 4"
        );
    }

    #[test]
    fn normalization_folds_unicode_spaces() {
        let raw = "earned\u{00A0}fees\u{2003}retained";
        assert_eq!(normalize_artifact_text(raw), "earned fees retained");
    }

    #[test]
    fn normalization_drops_control_but_keeps_tab() {
        let raw = "col1\tcol2\u{0007}end"; // BEL should vanish, tab survives
        assert_eq!(normalize_artifact_text(raw), "col1\tcol2end");
    }

    // ── AnchorReceipt seal (spec §8) ────────────────────────────────────────

    #[test]
    fn seal_material_is_the_canonical_hash_pipe_size() {
        assert_eq!(seal_material("sha256:abc", 1024), "sha256:abc|1024");
    }

    #[test]
    fn seal_is_deterministic_across_calls() {
        let h = hash_artifact(b"retainer agreement");
        assert_eq!(compute_seal(&h, 42), compute_seal(&h, 42));
    }

    #[test]
    fn seal_changes_when_the_hash_changes() {
        let a = compute_seal(&hash_artifact(b"$3,200.00"), 9);
        let b = compute_seal(&hash_artifact(b"$4,200.00"), 9);
        assert_ne!(a, b);
    }

    #[test]
    fn seal_binds_size_not_just_hash() {
        // The whole point of sealing size alongside the digest.
        let h = hash_artifact(b"same bytes");
        assert_ne!(compute_seal(&h, 100), compute_seal(&h, 101));
    }

    #[test]
    fn seal_is_unpadded_base64url() {
        let seal = compute_seal(&hash_artifact(b"doc"), 7);
        // 32 HMAC bytes → 43 base64 chars, no '=' padding.
        assert_eq!(seal.len(), 43);
        assert!(!seal.contains('='));
        assert!(!seal.contains('+') && !seal.contains('/'));
        assert!(seal
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn seal_is_keyed_not_a_bare_digest() {
        // A plain SHA-256 of the material would be forgeable by anyone; the
        // seal must not equal it.
        let h = hash_artifact(b"doc");
        let mut plain = Sha256::new();
        plain.update(seal_material(&h, 5).as_bytes());
        let unkeyed =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(plain.finalize());
        assert_ne!(compute_seal(&h, 5), unkeyed);
    }
}
