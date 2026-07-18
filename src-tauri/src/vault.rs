//! Credential vault — AES-256-GCM encrypted store.
//!
//! Ported from TrueLink's Electron/Node-crypto engine to Tauri + Rust. The
//! crypto design is identical:
//!  - Key: scrypt(password, per-vault salt) → 32 bytes.
//!  - Cipher: AES-256-GCM, fresh 12-byte IV per write, 16-byte auth tag.
//!  - A wrong password derives a wrong key, so GCM authentication fails on
//!    decrypt — that is how wrong passwords are detected.
//!  - On-disk file is a JSON envelope; the payload inside it is ciphertext.
//!  - Written atomically (temp + rename, mode 0600) in the app data dir.
//!  - Decrypted contents live in backend memory only; the derived key is
//!    zeroized on lock. Secrets never cross IPC to the WebView — only the
//!    secret-free `*Public` shapes and `has_*` presence flags do.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use scrypt::{scrypt, Params};
use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const VAULT_FILENAME: &str = "credentials.vault";
const KEY_BYTES: usize = 32;
const SALT_BYTES: usize = 16;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
// scrypt cost: N = 2^15, r = 8, p = 1.
const SCRYPT_LOG_N: u8 = 15;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

// ============================================================================
// Errors
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault is locked")]
    Locked,
    #[error("incorrect password")]
    WrongPassword,
    #[error("vault file is unreadable")]
    Corrupt,
    #[error("crypto failure")]
    Crypto,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn err(e: VaultError) -> String {
    e.to_string()
}

// ============================================================================
// Secret-bearing data (in memory only, serialized before encryption)
// ============================================================================

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEntry {
    pub provider_name: String,
    pub api_key: String,
    pub endpoint: String,
    pub connection_type: String, // "http" | "websocket"
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpEntry {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwilioEntry {
    pub account_sid: String,
    pub auth_token: String,
    pub from_number: String,
}

/// DocuSign JWT-Grant credentials (spec §18 / §24).
///
/// `jwt_private_key` is the most sensitive value the vault holds — an RSA PEM
/// that can mint access tokens impersonating the account user. `Zeroize` +
/// `ZeroizeOnDrop` wipe every field from memory when the struct is dropped, so a
/// resolved copy handed to `docusign.rs` leaves nothing behind after the request
/// completes. Like every other entry, it never crosses IPC — only
/// `DocuSignPublic` does.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct DocuSignSecret {
    pub integration_key: String,
    pub user_id: String,
    pub account_id: String,
    pub base_uri: String, // https://demo.docusign.net for sandbox
    pub jwt_private_key: String, // RSA PEM — most sensitive field
    pub environment: String, // "sandbox" | "production"
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct VaultData {
    #[serde(default)]
    ai: Option<AiEntry>,
    #[serde(default)]
    smtp: Option<SmtpEntry>,
    #[serde(default)]
    twilio: Option<TwilioEntry>,
    #[serde(default)]
    docusign: Option<DocuSignSecret>,
}

// ============================================================================
// Secret-free public shapes (cross IPC)
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPublic {
    provider_name: String,
    endpoint: String,
    connection_type: String,
    has_api_key: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpPublic {
    host: String,
    port: u16,
    username: String,
    has_password: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwilioPublic {
    account_sid: String,
    from_number: String,
    has_auth_token: bool,
}

/// Secret-free DocuSign view. Deliberately narrower than the other `*Public`
/// shapes: neither the integration key nor the user ID is echoed back, and the
/// account ID is reduced to its last four characters — just enough for an
/// operator to confirm *which* DocuSign account is wired up.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocuSignPublic {
    pub has_credentials: bool,
    pub environment: String,
    pub account_id_hint: String, // last 4 chars of account_id only
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultPublic {
    ai: Option<AiPublic>,
    smtp: Option<SmtpPublic>,
    twilio: Option<TwilioPublic>,
}

// ============================================================================
// Renderer inputs (secret optional — omitted keeps the existing secret)
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiInput {
    provider_name: String,
    endpoint: String,
    connection_type: String,
    #[serde(default)]
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpInput {
    host: String,
    port: u16,
    username: String,
    #[serde(default)]
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwilioInput {
    account_sid: String,
    from_number: String,
    #[serde(default)]
    auth_token: Option<String>,
}

/// DocuSign setter payload. Every field is a plain `String` (the whole entry is
/// secret-bearing), but the two secrets follow the same edit semantics as the
/// other groups: submitting them blank keeps whatever is already stored, so an
/// operator can flip Sandbox → Production without re-pasting a 1,700-character
/// RSA PEM.
#[derive(Debug, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct DocuSignInput {
    integration_key: String,
    user_id: String,
    account_id: String,
    base_uri: String,
    jwt_private_key: String,
    environment: String,
}

// ============================================================================
// Command result shapes
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    exists: bool,
    unlocked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockResult {
    ok: bool,
    created: bool,
    reason: Option<String>,
    message: Option<String>,
}

// ============================================================================
// Envelope
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
struct VaultEnvelope {
    v: u8,
    kdf: String,
    salt: String, // base64
    iv: String,   // base64
    tag: String,  // base64
    data: String, // base64 ciphertext
}

// ============================================================================
// Vault state
// ============================================================================

struct Unlocked {
    data: VaultData,
    key: Zeroizing<[u8; KEY_BYTES]>,
    salt: [u8; SALT_BYTES],
}

pub struct VaultState {
    path: PathBuf,
    inner: Mutex<Option<Unlocked>>,
}

impl VaultState {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(VAULT_FILENAME),
            inner: Mutex::new(None),
        }
    }

    fn status(&self) -> VaultStatus {
        VaultStatus {
            exists: self.path.exists(),
            unlocked: self.inner.lock().unwrap().is_some(),
        }
    }

    fn unlock(&self, password: &str) -> UnlockResult {
        if password.is_empty() {
            return UnlockResult {
                ok: false,
                created: false,
                reason: Some("error".into()),
                message: Some("Password is required.".into()),
            };
        }
        let mut guard = self.inner.lock().unwrap();

        if !self.path.exists() {
            // First run — create a fresh vault.
            let mut salt = [0u8; SALT_BYTES];
            OsRng.fill_bytes(&mut salt);
            let key = derive_key(password, &salt);
            let data = VaultData::default();
            if let Err(e) = persist(&data, &key, &salt, &self.path) {
                return UnlockResult {
                    ok: false,
                    created: false,
                    reason: Some("error".into()),
                    message: Some(err(e)),
                };
            }
            *guard = Some(Unlocked { data, key, salt });
            return UnlockResult { ok: true, created: true, reason: None, message: None };
        }

        let envelope: VaultEnvelope = match fs::read_to_string(&self.path)
            .map_err(VaultError::from)
            .and_then(|s| serde_json::from_str(&s).map_err(VaultError::from))
        {
            Ok(e) => e,
            Err(_) => {
                return UnlockResult {
                    ok: false,
                    created: false,
                    reason: Some("corrupt".into()),
                    message: Some("Vault file is unreadable.".into()),
                }
            }
        };

        let salt_vec = match B64.decode(&envelope.salt) {
            Ok(s) if s.len() == SALT_BYTES => s,
            _ => {
                return UnlockResult {
                    ok: false,
                    created: false,
                    reason: Some("corrupt".into()),
                    message: Some("Vault salt is invalid.".into()),
                }
            }
        };
        let mut salt = [0u8; SALT_BYTES];
        salt.copy_from_slice(&salt_vec);

        let key = derive_key(password, &salt);
        match decrypt(&envelope, &key) {
            Ok(data) => {
                *guard = Some(Unlocked { data, key, salt });
                UnlockResult { ok: true, created: false, reason: None, message: None }
            }
            Err(_) => UnlockResult {
                ok: false,
                created: false,
                reason: Some("wrong_password".into()),
                message: Some("Incorrect password.".into()),
            },
        }
    }

    fn lock(&self) {
        // Dropping Unlocked zeroizes the key (Zeroizing).
        *self.inner.lock().unwrap() = None;
    }

    fn get_public(&self) -> Result<VaultPublic, VaultError> {
        let guard = self.inner.lock().unwrap();
        let data = &guard.as_ref().ok_or(VaultError::Locked)?.data;
        Ok(VaultPublic {
            ai: data.ai.as_ref().map(|e| AiPublic {
                provider_name: e.provider_name.clone(),
                endpoint: e.endpoint.clone(),
                connection_type: e.connection_type.clone(),
                has_api_key: !e.api_key.is_empty(),
            }),
            smtp: data.smtp.as_ref().map(|e| SmtpPublic {
                host: e.host.clone(),
                port: e.port,
                username: e.username.clone(),
                has_password: !e.password.is_empty(),
            }),
            twilio: data.twilio.as_ref().map(|e| TwilioPublic {
                account_sid: e.account_sid.clone(),
                from_number: e.from_number.clone(),
                has_auth_token: !e.auth_token.is_empty(),
            }),
        })
    }

    /// Mutate the unlocked data under lock, then persist.
    fn mutate<F: FnOnce(&mut VaultData)>(&self, f: F) -> Result<(), VaultError> {
        let mut guard = self.inner.lock().unwrap();
        let state = guard.as_mut().ok_or(VaultError::Locked)?;
        f(&mut state.data);
        persist(&state.data, &state.key, &state.salt, &self.path)
    }

    fn set_ai(&self, input: AiInput) -> Result<(), VaultError> {
        self.mutate(|data| {
            let api_key = input
                .api_key
                .filter(|s| !s.is_empty())
                .or_else(|| data.ai.as_ref().map(|e| e.api_key.clone()))
                .unwrap_or_default();
            data.ai = Some(AiEntry {
                provider_name: input.provider_name.trim().to_string(),
                endpoint: input.endpoint.trim().to_string(),
                connection_type: input.connection_type,
                api_key,
            });
        })
    }

    fn set_smtp(&self, input: SmtpInput) -> Result<(), VaultError> {
        self.mutate(|data| {
            let password = input
                .password
                .filter(|s| !s.is_empty())
                .or_else(|| data.smtp.as_ref().map(|e| e.password.clone()))
                .unwrap_or_default();
            data.smtp = Some(SmtpEntry {
                host: input.host.trim().to_string(),
                port: input.port,
                username: input.username.trim().to_string(),
                password,
            });
        })
    }

    fn set_twilio(&self, input: TwilioInput) -> Result<(), VaultError> {
        self.mutate(|data| {
            let auth_token = input
                .auth_token
                .filter(|s| !s.is_empty())
                .or_else(|| data.twilio.as_ref().map(|e| e.auth_token.clone()))
                .unwrap_or_default();
            data.twilio = Some(TwilioEntry {
                account_sid: input.account_sid.trim().to_string(),
                from_number: input.from_number.trim().to_string(),
                auth_token,
            });
        })
    }

    fn set_docusign(&self, input: DocuSignInput) -> Result<(), VaultError> {
        self.mutate(|data| {
            let existing = data.docusign.as_ref();
            // Blank secret on edit → keep the stored one (same rule as AI/SMTP).
            let keep = |submitted: &str, current: Option<&String>| -> String {
                if submitted.is_empty() {
                    current.cloned().unwrap_or_default()
                } else {
                    submitted.to_string()
                }
            };
            data.docusign = Some(DocuSignSecret {
                integration_key: keep(
                    input.integration_key.trim(),
                    existing.map(|e| &e.integration_key),
                ),
                user_id: input.user_id.trim().to_string(),
                account_id: input.account_id.trim().to_string(),
                base_uri: input.base_uri.trim().trim_end_matches('/').to_string(),
                // The PEM is *not* trimmed per-line — only outer whitespace —
                // because its internal newlines are load-bearing for parsing.
                jwt_private_key: keep(
                    input.jwt_private_key.trim(),
                    existing.map(|e| &e.jwt_private_key),
                ),
                environment: input.environment.trim().to_string(),
            });
        })
    }

    fn get_docusign_public(&self) -> Result<DocuSignPublic, VaultError> {
        let guard = self.inner.lock().unwrap();
        let data = &guard.as_ref().ok_or(VaultError::Locked)?.data;
        Ok(match data.docusign.as_ref() {
            Some(e) => DocuSignPublic {
                // "Configured" means it could actually authenticate — metadata
                // alone with no signing key is not a usable credential.
                has_credentials: !e.integration_key.is_empty()
                    && !e.jwt_private_key.is_empty()
                    && !e.account_id.is_empty(),
                environment: e.environment.clone(),
                account_id_hint: last4(&e.account_id),
            },
            None => DocuSignPublic {
                has_credentials: false,
                environment: String::new(),
                account_id_hint: String::new(),
            },
        })
    }

    fn has_docusign(&self) -> bool {
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|s| s.data.docusign.as_ref())
            .is_some_and(|e| {
                !e.integration_key.is_empty()
                    && !e.jwt_private_key.is_empty()
                    && !e.account_id.is_empty()
            })
    }

    fn delete_group(&self, group: &str) -> Result<(), VaultError> {
        self.mutate(|data| match group {
            "ai" => data.ai = None,
            "smtp" => data.smtp = None,
            "twilio" => data.twilio = None,
            "docusign" => data.docusign = None,
            _ => {}
        })
    }

    fn change_password(&self, current: &str, next: &str) -> Result<(), VaultError> {
        if next.is_empty() {
            return Err(VaultError::Crypto);
        }
        let mut guard = self.inner.lock().unwrap();
        let state = guard.as_mut().ok_or(VaultError::Locked)?;
        let candidate = derive_key(current, &state.salt);
        if !ct_eq(candidate.as_ref(), state.key.as_ref()) {
            return Err(VaultError::WrongPassword);
        }
        let mut new_salt = [0u8; SALT_BYTES];
        OsRng.fill_bytes(&mut new_salt);
        let new_key = derive_key(next, &new_salt);
        persist(&state.data, &new_key, &new_salt, &self.path)?;
        state.key = new_key;
        state.salt = new_salt;
        Ok(())
    }

    // ---- internal resolvers (never cross IPC) ----------------------------

    pub fn resolve_ai(&self) -> Option<AiEntry> {
        self.inner.lock().unwrap().as_ref().and_then(|s| s.data.ai.clone())
    }

    pub fn resolve_smtp(&self) -> Option<SmtpEntry> {
        self.inner.lock().unwrap().as_ref().and_then(|s| s.data.smtp.clone())
    }

    pub fn resolve_twilio(&self) -> Option<TwilioEntry> {
        self.inner.lock().unwrap().as_ref().and_then(|s| s.data.twilio.clone())
    }

    /// DocuSign credentials for `docusign.rs`. The returned clone zeroizes
    /// itself on drop, so the caller must not stash it beyond the request.
    pub fn resolve_docusign(&self) -> Option<DocuSignSecret> {
        self.inner.lock().unwrap().as_ref().and_then(|s| s.data.docusign.clone())
    }
}

/// Last four characters of an identifier, for display hints. Short values are
/// returned whole rather than padded — there is nothing to hide in "42".
fn last4(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 4 {
        return s.to_string();
    }
    chars[chars.len() - 4..].iter().collect()
}

// ============================================================================
// Crypto
// ============================================================================

fn derive_key(password: &str, salt: &[u8]) -> Zeroizing<[u8; KEY_BYTES]> {
    let params = Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_BYTES)
        .expect("valid scrypt params");
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    scrypt(password.as_bytes(), salt, &params, key.as_mut()).expect("scrypt derivation");
    key
}

fn encrypt(data: &VaultData, key: &[u8; KEY_BYTES], salt: &[u8; SALT_BYTES]) -> Result<VaultEnvelope, VaultError> {
    let mut iv = [0u8; IV_BYTES];
    OsRng.fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plaintext = serde_json::to_vec(data)?;
    let mut combined = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext.as_slice())
        .map_err(|_| VaultError::Crypto)?;
    // aes-gcm appends the 16-byte tag; split it out to match the envelope shape.
    let tag = combined.split_off(combined.len() - TAG_BYTES);
    Ok(VaultEnvelope {
        v: 1,
        kdf: "scrypt".into(),
        salt: B64.encode(salt),
        iv: B64.encode(iv),
        tag: B64.encode(tag),
        data: B64.encode(combined),
    })
}

fn decrypt(envelope: &VaultEnvelope, key: &[u8; KEY_BYTES]) -> Result<VaultData, VaultError> {
    let iv = B64.decode(&envelope.iv).map_err(|_| VaultError::Corrupt)?;
    let tag = B64.decode(&envelope.tag).map_err(|_| VaultError::Corrupt)?;
    let mut combined = B64.decode(&envelope.data).map_err(|_| VaultError::Corrupt)?;
    combined.extend_from_slice(&tag); // ciphertext || tag
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&iv), combined.as_slice())
        .map_err(|_| VaultError::WrongPassword)?;
    Ok(serde_json::from_slice(&plaintext)?)
}

fn persist(data: &VaultData, key: &[u8; KEY_BYTES], salt: &[u8; SALT_BYTES], path: &Path) -> Result<(), VaultError> {
    let envelope = encrypt(data, key, salt)?;
    let json = serde_json::to_vec(&envelope)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ============================================================================
// Tauri commands
// ============================================================================

#[tauri::command]
pub fn vault_status(state: State<'_, VaultState>) -> VaultStatus {
    state.status()
}

#[tauri::command]
pub fn vault_unlock(state: State<'_, VaultState>, password: String) -> UnlockResult {
    state.unlock(&password)
}

#[tauri::command]
pub fn vault_lock(state: State<'_, VaultState>) {
    state.lock();
}

#[tauri::command]
pub fn vault_get_public(state: State<'_, VaultState>) -> Result<VaultPublic, String> {
    state.get_public().map_err(err)
}

#[tauri::command]
pub fn vault_set_ai(state: State<'_, VaultState>, input: AiInput) -> Result<(), String> {
    state.set_ai(input).map_err(err)
}

#[tauri::command]
pub fn vault_set_smtp(state: State<'_, VaultState>, input: SmtpInput) -> Result<(), String> {
    state.set_smtp(input).map_err(err)
}

#[tauri::command]
pub fn vault_set_twilio(state: State<'_, VaultState>, input: TwilioInput) -> Result<(), String> {
    state.set_twilio(input).map_err(err)
}

#[tauri::command]
pub fn vault_set_docusign(state: State<'_, VaultState>, input: DocuSignInput) -> Result<(), String> {
    state.set_docusign(input).map_err(err)
}

#[tauri::command]
pub fn vault_get_docusign_public(state: State<'_, VaultState>) -> Result<DocuSignPublic, String> {
    state.get_docusign_public().map_err(err)
}

/// Presence flag for the frontend provider resolver. A locked vault reports
/// `false` rather than erroring — "not available right now" is the honest
/// answer, and the caller falls back to the mock provider.
#[tauri::command]
pub fn vault_has_docusign(state: State<'_, VaultState>) -> bool {
    state.has_docusign()
}

#[tauri::command]
pub fn vault_delete(state: State<'_, VaultState>, group: String) -> Result<(), String> {
    state.delete_group(&group).map_err(err)
}

#[tauri::command]
pub fn vault_change_password(
    state: State<'_, VaultState>,
    current: String,
    next: String,
) -> Result<(), String> {
    state.change_password(&current, &next).map_err(err)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_state() -> VaultState {
        let dir = std::env::temp_dir().join(format!("lexvault_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        VaultState::new(&dir)
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let salt = [7u8; SALT_BYTES];
        let key = derive_key("hunter2", &salt);
        let mut data = VaultData::default();
        data.ai = Some(AiEntry {
            provider_name: "Claude".into(),
            api_key: "sk-secret".into(),
            endpoint: "https://api.anthropic.com".into(),
            connection_type: "http".into(),
        });
        let env = encrypt(&data, &key, &salt).unwrap();
        let back = decrypt(&env, &key).unwrap();
        assert_eq!(back.ai.unwrap().api_key, "sk-secret");
    }

    #[test]
    fn wrong_key_fails_decrypt() {
        let salt = [1u8; SALT_BYTES];
        let key = derive_key("right", &salt);
        let env = encrypt(&VaultData::default(), &key, &salt).unwrap();
        let wrong = derive_key("wrong", &salt);
        assert!(decrypt(&env, &wrong).is_err());
    }

    #[test]
    fn unlock_creates_then_persists_and_hides_secrets() {
        let v = temp_state();
        assert!(!v.status().exists);

        let r = v.unlock("pw");
        assert!(r.ok && r.created);

        v.set_ai(AiInput {
            provider_name: "Claude".into(),
            endpoint: "https://api.anthropic.com/v1/messages".into(),
            connection_type: "http".into(),
            api_key: Some("sk-123".into()),
        })
        .unwrap();

        // Public shape carries metadata but not the secret.
        let pubv = v.get_public().unwrap();
        let ai = pubv.ai.unwrap();
        assert_eq!(ai.provider_name, "Claude");
        assert!(ai.has_api_key);

        // Internal resolver still has the secret for backend use.
        assert_eq!(v.resolve_ai().unwrap().api_key, "sk-123");

        // Lock + reopen with the right password.
        v.lock();
        assert!(v.get_public().is_err());
        let r2 = v.unlock("pw");
        assert!(r2.ok && !r2.created);
        assert_eq!(v.resolve_ai().unwrap().api_key, "sk-123");
    }

    #[test]
    fn wrong_password_rejected() {
        let v = temp_state();
        v.unlock("correct");
        v.lock();
        let r = v.unlock("incorrect");
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("wrong_password"));
    }

    #[test]
    fn edit_without_secret_keeps_existing() {
        let v = temp_state();
        v.unlock("pw");
        v.set_smtp(SmtpInput {
            host: "smtp.example.com".into(),
            port: 587,
            username: "u".into(),
            password: Some("p".into()),
        })
        .unwrap();
        // Edit metadata, omit the password → secret preserved.
        v.set_smtp(SmtpInput {
            host: "smtp2.example.com".into(),
            port: 465,
            username: "u2".into(),
            password: None,
        })
        .unwrap();
        assert_eq!(v.resolve_smtp().unwrap().password, "p");
        assert_eq!(v.resolve_smtp().unwrap().host, "smtp2.example.com");
    }

    fn ds_input(env: &str, key: &str) -> DocuSignInput {
        DocuSignInput {
            integration_key: "ik-abc".into(),
            user_id: "user-123".into(),
            account_id: "acct-987654".into(),
            base_uri: "https://demo.docusign.net/".into(),
            jwt_private_key: key.into(),
            environment: env.into(),
        }
    }

    #[test]
    fn docusign_roundtrip_hides_secrets() {
        let v = temp_state();
        v.unlock("pw");
        assert!(!v.has_docusign());

        v.set_docusign(ds_input("sandbox", "-----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY-----"))
            .unwrap();
        assert!(v.has_docusign());

        // Public shape carries no key material and only hints the account.
        let p = v.get_docusign_public().unwrap();
        assert!(p.has_credentials);
        assert_eq!(p.environment, "sandbox");
        assert_eq!(p.account_id_hint, "7654");

        // Trailing slash stripped so base_uri joins cleanly with /restapi/...
        let s = v.resolve_docusign().unwrap();
        assert_eq!(s.base_uri, "https://demo.docusign.net");
        assert!(s.jwt_private_key.contains("BEGIN RSA PRIVATE KEY"));

        // Survives a lock/unlock cycle.
        v.lock();
        assert!(!v.has_docusign());
        assert!(v.unlock("pw").ok);
        assert!(v.resolve_docusign().unwrap().jwt_private_key.contains("MII"));
    }

    #[test]
    fn docusign_blank_key_on_edit_keeps_existing() {
        let v = temp_state();
        v.unlock("pw");
        v.set_docusign(ds_input("sandbox", "PEM-ORIGINAL")).unwrap();
        // Flip environment without re-pasting the PEM.
        v.set_docusign(ds_input("production", "")).unwrap();
        let s = v.resolve_docusign().unwrap();
        assert_eq!(s.jwt_private_key, "PEM-ORIGINAL");
        assert_eq!(s.environment, "production");
    }

    #[test]
    fn docusign_metadata_without_key_is_not_configured() {
        let v = temp_state();
        v.unlock("pw");
        // A fresh entry whose PEM was never supplied cannot authenticate.
        v.set_docusign(ds_input("sandbox", "")).unwrap();
        assert!(!v.has_docusign());
        assert!(!v.get_docusign_public().unwrap().has_credentials);
    }

    #[test]
    fn docusign_delete_clears_entry() {
        let v = temp_state();
        v.unlock("pw");
        v.set_docusign(ds_input("sandbox", "PEM")).unwrap();
        v.delete_group("docusign").unwrap();
        assert!(!v.has_docusign());
        assert!(v.resolve_docusign().is_none());
    }

    #[test]
    fn change_password_rekeys() {
        let v = temp_state();
        v.unlock("old");
        v.set_twilio(TwilioInput {
            account_sid: "AC1".into(),
            from_number: "+15550000000".into(),
            auth_token: Some("tok".into()),
        })
        .unwrap();
        assert!(v.change_password("wrong", "new").is_err());
        v.change_password("old", "new").unwrap();
        v.lock();
        assert!(!v.unlock("old").ok);
        assert!(v.unlock("new").ok);
        assert_eq!(v.resolve_twilio().unwrap().auth_token, "tok");
    }
}
