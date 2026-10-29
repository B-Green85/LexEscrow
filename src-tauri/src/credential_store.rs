//! Credential storage — one trait, two backends.
//!
//! LexEscrow holds credentials the operator cannot afford to lose and cannot
//! afford to leak: an RSA PEM that mints DocuSign tokens, a deployer key that
//! moves escrowed funds irreversibly, and the per-install HMAC key that every
//! AnchorReceipt this install has ever issued is sealed with. Where those live
//! is the operator's decision, not ours:
//!
//!  * [`OsKeychainStore`] delegates to the platform — macOS Keychain, Windows
//!    Credential Manager, Linux Secret Service. The OS owns the key material
//!    and unlocks it with the login session, so there is no second password.
//!  * [`VaultStore`] wraps the existing AES-256-GCM + scrypt vault. Portable,
//!    dependency-free, and password-gated.
//!
//! Both address the same ten credentials by the same names ([`CREDENTIAL_KEYS`]),
//! so migrating between them is a copy, not a translation.
//!
//! The IPC rule is unchanged and absolute: credential *values* never cross to
//! the WebView. This module hands the renderer presence flags, masked strings
//! and addressing metadata — never a secret. The one deliberate exception is
//! `get_credential_masked`, which returns a fixed bullet string, not a
//! truncation of the real value.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use zeroize::Zeroizing;

use crate::store_config::{read_store_config, write_store_config, StoreBackend};
use crate::vault::{
    can_settle, has_debug_console, has_docusign_credentials, merge_ai, merge_blockchain, merge_clio,
    merge_apify, merge_debug_console, merge_docusign, merge_practice_panther, merge_smtp,
    merge_twilio, new_seal_key_b64, verify_debug_password, AiEntry, AiInput, ApifyEntry, ApifyInput,
    BlockchainConfig, BlockchainInput,
    BlockchainPublic, ClioConfig, ClioConfigInput, ClioPublic, DebugConsoleEntry, DebugConsoleInput,
    DebugConsolePublic, DocuSignInput, DocuSignPublic, DocuSignSecret, PracticePantherConfig,
    PracticePantherConfigInput, PracticePantherPublic, SmtpEntry, SmtpInput, TwilioEntry,
    TwilioInput, UnlockResult, VaultError, VaultPublic, VaultState, VaultStatus,
};

/// Service name for every keyring entry. The username field carries the
/// credential key, so one LexEscrow install occupies ten entries under one
/// service — which is what makes them findable in Keychain Access and
/// `secret-tool` without guessing.
const KEYRING_SERVICE: &str = "lexescrow";

/// The seal key, spelled once. It is the only credential that is minted rather
/// than typed, and the only one that must never be deleted.
pub const KEY_SEAL: &str = "hmac-vault-key";

/// Every credential this app stores, in migration order.
///
/// Order matters: the seal key goes last so that a migration interrupted
/// partway has already moved the credentials an operator would have to retype,
/// and left behind only the one that can be re-minted. Losing the seal is worse
/// than losing an API key — an API key can be reissued, whereas the seal is
/// what makes last month's AnchorReceipt reproducible — but a *half*-migrated
/// seal is not a risk here, because migration never deletes from the source.
pub const CREDENTIAL_KEYS: &[&str] = &[
    "ai",
    "smtp",
    "twilio",
    "docusign",
    "clio",
    "practice-panther",
    "blockchain",
    "debug-console",
    "apify",
    KEY_SEAL,
];

// ============================================================================
// Errors
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum CredentialStoreError {
    #[error("credential not set")]
    NotFound,
    #[error("OS credential store error: {0}")]
    OsError(String),
    #[error("{0}")]
    VaultError(String),
    /// Linux only: no Secret Service implementation is reachable on the D-Bus
    /// session. Carries the install command for the detected distro so the UI
    /// can show something actionable instead of "keyring unavailable".
    ///
    /// Constructed only under `cfg(target_os = "linux")`, hence the allow —
    /// macOS and Windows have no equivalent missing-provider state, but the
    /// variant stays in the shared error type so the wire shape the frontend
    /// branches on is identical on every platform.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    #[error("no Secret Service provider (libsecret) is available")]
    LibsecretNotFound { install_command: Option<&'static str> },
}

impl From<VaultError> for CredentialStoreError {
    fn from(e: VaultError) -> Self {
        match e {
            VaultError::NotFound => CredentialStoreError::NotFound,
            other => CredentialStoreError::VaultError(other.to_string()),
        }
    }
}

/// Structured error for the renderer.
///
/// `code` is a stable machine token the UI branches on; `message` is for
/// display. `LIBSECRET_NOT_FOUND` is the only variant the UI treats specially —
/// it is the one failure with a fix the operator can carry out themselves, so
/// it carries the command to run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreBackendError {
    pub code: String,
    pub message: String,
    pub install_command: Option<String>,
}

impl From<CredentialStoreError> for StoreBackendError {
    fn from(e: CredentialStoreError) -> Self {
        match e {
            CredentialStoreError::LibsecretNotFound { install_command } => StoreBackendError {
                code: "LIBSECRET_NOT_FOUND".into(),
                message: "No system keyring (Secret Service) is available.".into(),
                install_command: install_command.map(String::from),
            },
            CredentialStoreError::NotFound => StoreBackendError {
                code: "NOT_FOUND".into(),
                message: e.to_string(),
                install_command: None,
            },
            CredentialStoreError::OsError(ref m) => StoreBackendError {
                code: "OS_ERROR".into(),
                message: m.clone(),
                install_command: None,
            },
            CredentialStoreError::VaultError(ref m) => StoreBackendError {
                code: "VAULT_ERROR".into(),
                message: m.clone(),
                install_command: None,
            },
        }
    }
}

// ============================================================================
// The trait
// ============================================================================

pub trait CredentialStore: Send + Sync {
    fn get(&self, key: &str) -> Result<String, CredentialStoreError>;
    fn set(&self, key: &str, value: &str) -> Result<(), CredentialStoreError>;
    fn delete(&self, key: &str) -> Result<(), CredentialStoreError>;
    fn backend_name(&self) -> &'static str;
}

// ============================================================================
// Linux distro detection
// ============================================================================

/// The command that installs a Secret Service provider on this distro.
///
/// Reads `/etc/os-release`, which is the one identification file every
/// systemd-era distribution ships. `None` means "we don't recognise this
/// system" — the UI then says the keyring is unavailable without inventing a
/// package manager, because a wrong `sudo` command is worse than no command.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn get_libsecret_install_command() -> Option<&'static str> {
    let os_release = std::fs::read_to_string("/etc/os-release").ok()?;
    install_command_for(&os_release)
}

/// One `KEY=value` field from an os-release file, unquoted.
///
/// os-release values may be quoted, and in practice the ones that matter here
/// are: `ID_LIKE` holds a space-separated list, so it is nearly always written
/// `ID_LIKE="rhel centos fedora"`, and openSUSE ships `ID="opensuse-tumbleweed"`.
/// Matching raw substrings against those files silently fails — `ID=opensuse`
/// does not occur in `ID="opensuse-tumbleweed"` — which is a miss that reads to
/// the operator as "your distro is unsupported" on two of the six families
/// below. Parsing the field is what makes the table actually fire.
///
/// The prefix check also stops `ID` from matching the `ID_LIKE` line: stripping
/// `ID` leaves `_LIKE=…`, which has no leading `=` and is skipped.
fn os_release_field<'a>(os_release: &'a str, key: &str) -> Option<&'a str> {
    os_release.lines().find_map(|line| {
        let value = line.trim().strip_prefix(key)?.strip_prefix('=')?;
        Some(value.trim().trim_matches(['"', '\'']))
    })
}

/// Split out from the file read so the distro table is testable without an
/// `/etc/os-release` to stand on — every branch below is exercised on macOS.
fn install_command_for(os_release: &str) -> Option<&'static str> {
    let id = os_release_field(os_release, "ID").unwrap_or_default();
    let id_like = os_release_field(os_release, "ID_LIKE").unwrap_or_default();
    // ID_LIKE is a space-separated list of families, most-specific first.
    let like = |family: &str| id_like.split_whitespace().any(|f| f == family);

    if id == "ubuntu" || id == "debian" || like("debian") {
        Some("sudo apt install libsecret-1-0")
    } else if id == "fedora" {
        Some("sudo dnf install libsecret")
    } else if id == "rhel" || like("rhel") {
        // RHEL 7 predates dnf. Version-gated rather than distro-gated, because
        // the same `ID=rhel` covers both sides of that change.
        let version = os_release_field(os_release, "VERSION_ID").unwrap_or_default();
        if version.starts_with('7') {
            Some("sudo yum install libsecret")
        } else {
            Some("sudo dnf install libsecret")
        }
    } else if id == "arch" || like("arch") {
        Some("sudo pacman -S libsecret")
    } else if id.starts_with("opensuse") || like("opensuse") || like("suse") {
        Some("sudo zypper install libsecret")
    } else if id == "nixos" {
        Some("nix-env -iA nixpkgs.libsecret")
    } else {
        None
    }
}

// ============================================================================
// OS keychain backend
// ============================================================================

pub struct OsKeychainStore {
    service: String,
}

impl OsKeychainStore {
    /// Build the store, failing if the platform keyring cannot be reached.
    ///
    /// The probe is a real round-trip, not a capability check: on Linux the
    /// `Entry::new` call is what actually contacts the Secret Service over
    /// D-Bus, so anything short of touching an entry would report success on a
    /// system where the first credential write is about to fail.
    pub fn open() -> Result<Self, CredentialStoreError> {
        Self::open_with_service(KEYRING_SERVICE)
    }

    /// Open against an arbitrary service name.
    ///
    /// Exists for the round-trip tests, which must not touch `lexescrow`: these
    /// tests write and delete under the real credential key names, and on a
    /// developer machine actually using the OS-keychain backend that would
    /// destroy the operator's stored DocuSign PEM and deployer key. Tests pass
    /// a per-run unique service instead, so they exercise the real platform
    /// keychain without sharing a namespace with real credentials.
    pub fn open_with_service(service: &str) -> Result<Self, CredentialStoreError> {
        let entry =
            keyring::Entry::new(service, "__lexescrow_probe__").map_err(map_keyring_error)?;
        // NoEntry is the expected answer and means the service answered us.
        match entry.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(OsKeychainStore {
                service: service.to_string(),
            }),
            Err(e) => Err(map_keyring_error(e)),
        }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, CredentialStoreError> {
        keyring::Entry::new(&self.service, key).map_err(map_keyring_error)
    }
}

/// Translate a keyring failure into our error space.
///
/// The Linux no-Secret-Service case is separated out because it is the only
/// one with an operator-actionable fix, and it arrives in two shapes depending
/// on whether D-Bus itself is missing or is running with nothing registered on
/// the Secret Service name.
fn map_keyring_error(e: keyring::Error) -> CredentialStoreError {
    #[cfg(target_os = "linux")]
    {
        let text = e.to_string().to_lowercase();
        if matches!(e, keyring::Error::NoStorageAccess(_))
            || text.contains("secret service")
            || text.contains("dbus")
            || text.contains("d-bus")
        {
            return CredentialStoreError::LibsecretNotFound {
                install_command: get_libsecret_install_command(),
            };
        }
    }
    match e {
        keyring::Error::NoEntry => CredentialStoreError::NotFound,
        other => CredentialStoreError::OsError(other.to_string()),
    }
}

impl CredentialStore for OsKeychainStore {
    fn get(&self, key: &str) -> Result<String, CredentialStoreError> {
        match self.entry(key)?.get_password() {
            Ok(v) => Ok(v),
            Err(keyring::Error::NoEntry) => Err(CredentialStoreError::NotFound),
            Err(e) => Err(map_keyring_error(e)),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), CredentialStoreError> {
        self.entry(key)?.set_password(value).map_err(map_keyring_error)
    }

    fn delete(&self, key: &str) -> Result<(), CredentialStoreError> {
        if key == KEY_SEAL {
            return Err(CredentialStoreError::OsError(
                "hmac-vault-key is not deletable — it anchors every issued AnchorReceipt".into(),
            ));
        }
        match self.entry(key)?.delete_password() {
            // Deleting what is already absent is the requested end state.
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_keyring_error(e)),
        }
    }

    fn backend_name(&self) -> &'static str {
        "os_keychain"
    }
}

// ============================================================================
// App vault backend
// ============================================================================

/// Adapter over the existing AES-256-GCM vault. Holds no crypto of its own —
/// every call forwards to `VaultState`, which still owns the key derivation,
/// the atomic write and the zeroizing.
pub struct VaultStore {
    vault: Arc<VaultState>,
}

impl VaultStore {
    pub fn new(vault: Arc<VaultState>) -> Self {
        Self { vault }
    }
}

impl CredentialStore for VaultStore {
    fn get(&self, key: &str) -> Result<String, CredentialStoreError> {
        self.vault.get_group_json(key).map_err(Into::into)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), CredentialStoreError> {
        self.vault.set_group_json(key, value).map_err(Into::into)
    }

    fn delete(&self, key: &str) -> Result<(), CredentialStoreError> {
        self.vault.delete_group_json(key).map_err(Into::into)
    }

    fn backend_name(&self) -> &'static str {
        "app_vault"
    }
}

// ============================================================================
// Managed state
// ============================================================================

/// The active store, plus the vault it may or may not be using.
///
/// The vault is constructed unconditionally even when the OS keychain is
/// selected. It costs nothing unopened — `VaultState::new` only records a path
/// — and it means switching backends, or migrating away from a vault an earlier
/// launch created, never has to build one mid-flight.
///
/// `active` is `None` before the operator has chosen. That is a real state, not
/// an error: it is what the first-launch selector is gated on.
pub struct CredentialStoreState {
    active: Mutex<Option<Arc<dyn CredentialStore>>>,
    vault: Arc<VaultState>,
}

impl CredentialStoreState {
    pub fn new(vault: Arc<VaultState>) -> Self {
        Self {
            active: Mutex::new(None),
            vault: vault.clone(),
        }
    }

    pub fn vault(&self) -> Arc<VaultState> {
        self.vault.clone()
    }

    /// Build a store for `backend`, without installing it.
    fn build(&self, backend: StoreBackend) -> Result<Arc<dyn CredentialStore>, CredentialStoreError> {
        match backend {
            StoreBackend::OsKeychain => Ok(Arc::new(OsKeychainStore::open()?)),
            StoreBackend::AppVault => Ok(Arc::new(VaultStore::new(self.vault.clone()))),
        }
    }

    /// Build and install. Failure leaves the previous store in place — a failed
    /// switch must not strand the app with no backend at all.
    pub fn activate(&self, backend: StoreBackend) -> Result<(), CredentialStoreError> {
        let store = self.build(backend)?;
        *self.active.lock().unwrap() = Some(store);
        Ok(())
    }

    pub fn current(&self) -> Option<Arc<dyn CredentialStore>> {
        self.active.lock().unwrap().clone()
    }

    pub fn backend_name(&self) -> Option<&'static str> {
        self.current().map(|s| s.backend_name())
    }

    /// Read and deserialize one group.
    ///
    /// Every failure collapses to `None` — unconfigured, locked vault, absent
    /// keyring entry, corrupt JSON. That is deliberate and matches what the
    /// resolvers promised before this layer existed: callers ask "do I have a
    /// usable credential", and every one of those answers is "no". A locked
    /// vault in particular must not become a thrown error, or opening the app
    /// before unlocking would fail screens rather than degrade them.
    fn resolve<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        let store = self.current()?;
        let raw = store.get(key).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn resolve_ai(&self) -> Option<AiEntry> {
        self.resolve("ai")
    }

    pub fn resolve_smtp(&self) -> Option<SmtpEntry> {
        self.resolve("smtp")
    }

    pub fn resolve_twilio(&self) -> Option<TwilioEntry> {
        self.resolve("twilio")
    }

    pub fn resolve_docusign(&self) -> Option<DocuSignSecret> {
        self.resolve("docusign")
    }

    pub fn resolve_clio(&self) -> Option<ClioConfig> {
        self.resolve("clio")
    }

    pub fn resolve_practice_panther(&self) -> Option<PracticePantherConfig> {
        self.resolve("practice-panther")
    }

    pub fn resolve_blockchain(&self) -> Option<BlockchainConfig> {
        self.resolve("blockchain")
    }

    pub fn resolve_debug_console(&self) -> Option<DebugConsoleEntry> {
        self.resolve("debug-console")
    }

    pub fn resolve_apify(&self) -> Option<ApifyEntry> {
        self.resolve("apify")
    }

    /// The per-install AnchorReceipt seal key, minting it on first use.
    ///
    /// Minting here rather than at unlock is what lets the OS-keychain backend
    /// work at all: there is no unlock event to hang it off. The property that
    /// actually matters is unchanged — the key is written back immediately, so
    /// it is stable for the life of the install and a seal issued today stays
    /// reproducible. A mint that cannot be persisted returns `None` rather than
    /// sealing with a key that will not survive the session, which would turn a
    /// visible "not registered" into an invisible "registered wrong".
    pub fn resolve_seal_key(&self) -> Option<Zeroizing<[u8; 32]>> {
        let store = self.current()?;
        let b64 = match store.get(KEY_SEAL) {
            Ok(v) if !v.is_empty() => v,
            Ok(_) | Err(CredentialStoreError::NotFound) => {
                let minted = new_seal_key_b64();
                store.set(KEY_SEAL, &minted).ok()?;
                minted
            }
            Err(_) => return None,
        };
        decode_seal_key(&b64)
    }

    // ---- Group setters (identical semantics on both backends) -------------

    fn write<T: Serialize>(&self, key: &str, value: &T) -> Result<(), CredentialStoreError> {
        let store = self
            .current()
            .ok_or_else(|| CredentialStoreError::VaultError("no credential store selected".into()))?;
        let json = serde_json::to_string(value)
            .map_err(|e| CredentialStoreError::VaultError(e.to_string()))?;
        store.set(key, &json)
    }

    pub fn set_ai(&self, input: AiInput) -> Result<(), CredentialStoreError> {
        let merged = merge_ai(self.resolve_ai().as_ref(), input);
        self.write("ai", &merged)
    }

    pub fn set_smtp(&self, input: SmtpInput) -> Result<(), CredentialStoreError> {
        let merged = merge_smtp(self.resolve_smtp().as_ref(), input);
        self.write("smtp", &merged)
    }

    pub fn set_twilio(&self, input: TwilioInput) -> Result<(), CredentialStoreError> {
        let merged = merge_twilio(self.resolve_twilio().as_ref(), input);
        self.write("twilio", &merged)
    }

    pub fn set_apify(&self, input: ApifyInput) -> Result<(), CredentialStoreError> {
        let merged = merge_apify(self.resolve_apify().as_ref(), input);
        self.write("apify", &merged)
    }

    pub fn set_docusign(&self, input: DocuSignInput) -> Result<(), CredentialStoreError> {
        let merged = merge_docusign(self.resolve_docusign().as_ref(), input);
        self.write("docusign", &merged)
    }

    /// A blank client ID clears the entry — the Configuration screen's delete
    /// affordance, and the reason a removed integration leaves no refresh token
    /// behind.
    pub fn set_clio(&self, input: ClioConfigInput) -> Result<(), CredentialStoreError> {
        match merge_clio(self.resolve_clio().as_ref(), input) {
            Some(c) => self.write("clio", &c),
            None => self.delete_key("clio"),
        }
    }

    /// Write a whole Clio config back, tokens included.
    ///
    /// The token half of the group is written by the OAuth flow in `clio.rs`
    /// and by nothing else — it is not something an operator types, so it has
    /// no place in `ClioConfigInput` and no route in from the WebView. This is
    /// that flow's one seam, deliberately narrow: read the config, set the
    /// three token fields, write it back.
    pub fn write_clio(&self, config: &ClioConfig) -> Result<(), CredentialStoreError> {
        self.write("clio", config)
    }

    pub fn set_practice_panther(
        &self,
        input: PracticePantherConfigInput,
    ) -> Result<(), CredentialStoreError> {
        match merge_practice_panther(self.resolve_practice_panther().as_ref(), input) {
            Some(c) => self.write("practice-panther", &c),
            None => self.delete_key("practice-panther"),
        }
    }

    /// Write the settlement config.
    ///
    /// The vault backend keeps its second factor: `VaultState::set_blockchain`
    /// re-derives the key from the submitted password before writing, because
    /// the deployer key is the one credential in this app that cannot be
    /// revoked after it leaks, and an unlocked vault on an unattended machine
    /// is not sufficient authority to write one.
    ///
    /// The OS-keychain backend has no such password to check — the OS has
    /// already authenticated the login session, and inventing a LexEscrow
    /// password just to re-ask would be security theatre over a keyring the
    /// user's session already unlocked. The consequence is real and worth
    /// naming: on that backend, physical access to an unlocked machine is
    /// enough to write a deployer key.
    pub fn set_blockchain(
        &self,
        password: &str,
        input: BlockchainInput,
    ) -> Result<(), CredentialStoreError> {
        let store = self
            .current()
            .ok_or_else(|| CredentialStoreError::VaultError("no credential store selected".into()))?;
        if store.backend_name() == "app_vault" {
            return self.vault.set_blockchain(password, input).map_err(Into::into);
        }
        let merged = merge_blockchain(self.resolve_blockchain().as_ref(), input);
        self.write("blockchain", &merged)
    }

    /// Write the LexTrace credentials.
    ///
    /// No second password gate, unlike `set_blockchain`. The two are not
    /// comparable: writing a deployer key hands over irrevocable authority to
    /// move money, whereas this writes the verifier for a read-only console
    /// whose worst outcome is that somebody watches CLI output they were
    /// already able to run themselves in a terminal. An unlocked vault is
    /// sufficient authority for that.
    pub fn set_debug_console(&self, input: DebugConsoleInput) -> Result<(), CredentialStoreError> {
        let merged = merge_debug_console(self.resolve_debug_console().as_ref(), input);
        self.write("debug-console", &merged)
    }

    pub fn delete_key(&self, key: &str) -> Result<(), CredentialStoreError> {
        let store = self
            .current()
            .ok_or_else(|| CredentialStoreError::VaultError("no credential store selected".into()))?;
        store.delete(key)
    }

    // ---- Public shapes ----------------------------------------------------

    pub fn get_public(&self) -> VaultPublic {
        VaultPublic::build(
            self.resolve_ai().as_ref(),
            self.resolve_smtp().as_ref(),
            self.resolve_twilio().as_ref(),
            self.resolve_apify().as_ref(),
        )
    }

    pub fn get_docusign_public(&self) -> DocuSignPublic {
        DocuSignPublic::build(self.resolve_docusign().as_ref())
    }

    pub fn has_docusign(&self) -> bool {
        self.resolve_docusign().as_ref().is_some_and(has_docusign_credentials)
    }

    pub fn get_clio_public(&self) -> ClioPublic {
        ClioPublic::build(self.resolve_clio().as_ref())
    }

    pub fn get_practice_panther_public(&self) -> PracticePantherPublic {
        PracticePantherPublic::build(self.resolve_practice_panther().as_ref())
    }

    pub fn get_blockchain_public(&self) -> BlockchainPublic {
        BlockchainPublic::build(self.resolve_blockchain().as_ref())
    }

    pub fn has_blockchain(&self) -> bool {
        self.resolve_blockchain().as_ref().is_some_and(can_settle)
    }

    pub fn get_debug_console_public(&self) -> DebugConsolePublic {
        DebugConsolePublic::build(self.resolve_debug_console().as_ref())
    }

    pub fn has_debug_console(&self) -> bool {
        self.resolve_debug_console().as_ref().is_some_and(has_debug_console)
    }

    /// Check a submitted debug password against the stored hash.
    ///
    /// An unconfigured console answers `false` rather than "not found", and it
    /// takes the same scrypt-shaped time to say so is *not* something this can
    /// promise — the hash is simply absent, so there is nothing to derive
    /// against. That is an acceptable oracle here: whether an install has its
    /// debug console set up is already visible in the Configuration screen and
    /// in the icon's own refusal message.
    pub fn verify_debug_console(&self, password: &str) -> bool {
        match self.resolve_debug_console() {
            Some(e) if has_debug_console(&e) => verify_debug_password(&e.password_hash, password),
            _ => false,
        }
    }

    /// The operator name recorded against debug audit entries.
    ///
    /// `None` when the console is not configured, which is the same condition
    /// that refuses to run a command at all — so a debug row can never be
    /// written with an anonymous operator.
    pub fn debug_operator_id(&self) -> Option<String> {
        self.resolve_debug_console()
            .filter(has_debug_console)
            .map(|e| e.operator_id.clone())
    }
}

/// Decode a base64 seal key into fixed-size zeroizing storage. Wrong-length
/// input is rejected rather than padded — a short key is a corrupt key, and
/// sealing with it would produce receipts that verify against nothing.
fn decode_seal_key(b64: &str) -> Option<Zeroizing<[u8; 32]>> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    let bytes = B64.decode(b64).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&bytes);
    Some(key)
}

// ============================================================================
// Command result shapes
// ============================================================================

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrateResult {
    pub migrated: Vec<String>,
    pub failed: Vec<String>,
    pub new_backend: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsKeychainStatus {
    pub available: bool,
    pub install_command: Option<String>,
}

/// What the renderer is shown in place of a credential value.
///
/// A fixed-width bullet run, not a truncation: showing the first or last few
/// characters of an API key is a meaningful fraction of a secret, and the
/// screen already carries the metadata (endpoint, host, account) an operator
/// needs to recognise *which* credential is stored.
const MASKED: &str = "••••••••";

// ============================================================================
// Tauri commands
// ============================================================================

#[tauri::command]
pub fn get_store_backend(state: State<'_, CredentialStoreState>) -> Option<String> {
    state.backend_name().map(String::from)
}

/// Select a backend and persist the choice.
///
/// The config file is written only after the store opens. Ordering matters on
/// Linux: recording "os_keychain" for a machine with no Secret Service would
/// make the next launch skip the selector and come up with no reachable
/// credentials at all.
#[tauri::command]
pub fn set_store_backend(
    app: tauri::AppHandle,
    state: State<'_, CredentialStoreState>,
    backend: String,
) -> Result<(), StoreBackendError> {
    let target = StoreBackend::parse(&backend).ok_or_else(|| StoreBackendError {
        code: "UNKNOWN_BACKEND".into(),
        message: format!("Unknown credential backend '{backend}'."),
        install_command: None,
    })?;
    state.activate(target)?;
    let data_dir = app.path().app_data_dir().map_err(|e| StoreBackendError {
        code: "IO_ERROR".into(),
        message: e.to_string(),
        install_command: None,
    })?;
    write_store_config(&data_dir, target).map_err(|e| StoreBackendError {
        code: "IO_ERROR".into(),
        message: e.to_string(),
        install_command: None,
    })
}

/// Masked presence check for a single credential key.
///
/// Returns the bullet string when a value is stored and `None` when it is not,
/// so the renderer can render "configured" without ever holding the secret.
#[tauri::command]
pub fn get_credential_masked(state: State<'_, CredentialStoreState>, key: String) -> Option<String> {
    let store = state.current()?;
    match store.get(&key) {
        Ok(v) if !v.is_empty() => Some(MASKED.to_string()),
        _ => None,
    }
}

/// Generic credential write.
///
/// `blockchain` is refused here. It is the one group with a write gate in front
/// of it — the vault password on App Vault, the confirmation password on OS
/// Keychain — and a generic setter that also reached it would be an
/// unauthenticated path around both. Everything else in the table is a
/// revocable credential; the deployer key is not.
///
/// The seal key is refused too. It is minted by the backend, never typed, and
/// overwriting it from the WebView would silently orphan every AnchorReceipt
/// this install has issued.
/// Which keys the generic setter will accept. Split out so the refusal is
/// testable without standing up a Tauri app — the guard is the whole point of
/// the command, and an untested guard is a guard that regresses.
fn guard_generic_key(key: &str) -> Result<(), String> {
    if key == "blockchain" {
        return Err("Use set_blockchain_credential for the blockchain group".to_string());
    }
    if key == KEY_SEAL {
        return Err(format!("{KEY_SEAL} is minted by the backend and cannot be set"));
    }
    if !CREDENTIAL_KEYS.contains(&key) {
        return Err(format!("Unknown credential key '{key}'."));
    }
    Ok(())
}

#[tauri::command]
pub fn set_credential(
    state: State<'_, CredentialStoreState>,
    key: String,
    value: String,
) -> Result<(), String> {
    guard_generic_key(&key)?;
    let store = state.current().ok_or("No credential store selected.")?;
    store.set(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_credential(state: State<'_, CredentialStoreState>, key: String) -> Result<(), String> {
    if !CREDENTIAL_KEYS.contains(&key.as_str()) {
        return Err(format!("Unknown credential key '{key}'."));
    }
    state.delete_key(&key).map_err(|e| e.to_string())
}

/// Copy every credential from one store to another, returning
/// `(migrated, failed)` key lists.
///
/// Split from the command so it is testable without a running Tauri app, and
/// so the "which keys moved" logic is exercised directly rather than inferred
/// from a command's return value.
fn copy_all(
    source: &dyn CredentialStore,
    target: &dyn CredentialStore,
) -> (Vec<String>, Vec<String>) {
    let (mut migrated, mut failed) = (Vec::new(), Vec::new());
    for key in CREDENTIAL_KEYS {
        match source.get(key) {
            // Nothing stored under this key is not a failure — most installs
            // configure a subset, and listing unset keys as "failed" would
            // send operators hunting for credentials they never had.
            Err(CredentialStoreError::NotFound) => continue,
            Err(_) => failed.push((*key).to_string()),
            Ok(value) => match target.set(key, &value) {
                Ok(()) => migrated.push((*key).to_string()),
                Err(_) => failed.push((*key).to_string()),
            },
        }
    }
    (migrated, failed)
}

/// Copy every credential to the other backend, then switch to it.
///
/// **Non-destructive by design.** The source keeps its copy. If the target
/// turns out to be unreadable on the next launch — a keychain that prompts and
/// is denied, a vault whose password is forgotten — the operator's credentials
/// still exist somewhere, and switching back recovers them. Deleting the source
/// would buy tidiness at the price of making a bad migration unrecoverable, and
/// two of these credentials (the DocuSign PEM, the deployer key) cannot be
/// reconstructed from anything the app knows.
///
/// Per-key failures are collected rather than aborting the run: a Clio token
/// that fails to copy should not strand the DocuSign PEM, and the operator gets
/// a list of exactly what to re-enter.
#[tauri::command]
pub fn migrate_credentials(
    app: tauri::AppHandle,
    state: State<'_, CredentialStoreState>,
    target_backend: String,
) -> Result<MigrateResult, String> {
    let target = StoreBackend::parse(&target_backend)
        .ok_or_else(|| format!("Unknown credential backend '{target_backend}'."))?;
    let source = state.current().ok_or("No credential store selected.")?;
    if source.backend_name() == target.as_str() {
        return Err("Already using that credential store.".to_string());
    }

    let target_store: Arc<dyn CredentialStore> = match target {
        StoreBackend::OsKeychain => Arc::new(OsKeychainStore::open().map_err(|e| e.to_string())?),
        StoreBackend::AppVault => Arc::new(VaultStore::new(state.vault())),
    };

    let (migrated, failed) = copy_all(source.as_ref(), target_store.as_ref());

    // Switch only if nothing failed. A partial copy that also flipped the
    // active backend would leave the app pointed at a store missing exactly the
    // credentials that could not be written — the worst of both.
    if !failed.is_empty() {
        return Ok(MigrateResult {
            migrated,
            failed,
            new_backend: source.backend_name().to_string(),
        });
    }

    state.activate(target).map_err(|e| e.to_string())?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    write_store_config(&data_dir, target).map_err(|e| e.to_string())?;

    Ok(MigrateResult {
        migrated,
        failed,
        new_backend: target.as_str().to_string(),
    })
}

#[tauri::command]
pub fn check_os_keychain() -> OsKeychainStatus {
    match OsKeychainStore::open() {
        Ok(_) => OsKeychainStatus {
            available: true,
            install_command: None,
        },
        Err(CredentialStoreError::LibsecretNotFound { install_command }) => OsKeychainStatus {
            available: false,
            install_command: install_command.map(String::from),
        },
        Err(_) => OsKeychainStatus {
            available: false,
            install_command: None,
        },
    }
}

// ---- Credential group commands (names unchanged — routed through the store) -

#[tauri::command]
pub fn vault_get_public(state: State<'_, CredentialStoreState>) -> Result<VaultPublic, String> {
    Ok(state.get_public())
}

#[tauri::command]
pub fn vault_set_ai(state: State<'_, CredentialStoreState>, input: AiInput) -> Result<(), String> {
    state.set_ai(input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_set_smtp(
    state: State<'_, CredentialStoreState>,
    input: SmtpInput,
) -> Result<(), String> {
    state.set_smtp(input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_set_twilio(
    state: State<'_, CredentialStoreState>,
    input: TwilioInput,
) -> Result<(), String> {
    state.set_twilio(input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_set_apify(
    state: State<'_, CredentialStoreState>,
    input: ApifyInput,
) -> Result<(), String> {
    state.set_apify(input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_set_docusign(
    state: State<'_, CredentialStoreState>,
    input: DocuSignInput,
) -> Result<(), String> {
    state.set_docusign(input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_get_docusign_public(
    state: State<'_, CredentialStoreState>,
) -> Result<DocuSignPublic, String> {
    Ok(state.get_docusign_public())
}

#[tauri::command]
pub fn vault_has_docusign(state: State<'_, CredentialStoreState>) -> bool {
    state.has_docusign()
}

#[tauri::command]
pub fn vault_delete(state: State<'_, CredentialStoreState>, group: String) -> Result<(), String> {
    state.delete_key(&group).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_set_clio(
    state: State<'_, CredentialStoreState>,
    input: ClioConfigInput,
) -> Result<(), String> {
    state.set_clio(input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_get_clio_public(
    state: State<'_, CredentialStoreState>,
) -> Result<ClioPublic, String> {
    Ok(state.get_clio_public())
}

#[tauri::command]
pub fn vault_set_practice_panther(
    state: State<'_, CredentialStoreState>,
    input: PracticePantherConfigInput,
) -> Result<(), String> {
    state.set_practice_panther(input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_get_practice_panther_public(
    state: State<'_, CredentialStoreState>,
) -> Result<PracticePantherPublic, String> {
    Ok(state.get_practice_panther_public())
}

// ---- LexTrace debug console -------------------------------------------------

#[tauri::command]
pub fn vault_set_debug_console(
    state: State<'_, CredentialStoreState>,
    input: DebugConsoleInput,
) -> Result<(), String> {
    if input.operator_id.trim().is_empty() {
        return Err("An IT operator name is required.".to_string());
    }
    // A first write with no password would store a half-configured group that
    // `has_debug_console` reports as unconfigured — the operator would press
    // Save, see success, and still be refused by the icon.
    let first_write = !state.has_debug_console();
    let blank_password = input.password.as_deref().map(str::trim).unwrap_or("").is_empty();
    if first_write && blank_password {
        return Err("A debug console password is required.".to_string());
    }
    state.set_debug_console(input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_get_debug_console_public(
    state: State<'_, CredentialStoreState>,
) -> Result<DebugConsolePublic, String> {
    Ok(state.get_debug_console_public())
}

#[tauri::command]
pub fn vault_has_debug_console(state: State<'_, CredentialStoreState>) -> bool {
    state.has_debug_console()
}

/// The debug console's password gate.
///
/// Returns a bare bool, and deliberately not the operator name or anything else
/// on success: the panel reads those from `vault_get_debug_console_public`,
/// which is not gated because it holds nothing secret. Keeping this command's
/// answer to one bit means a wrong password and a locked vault are
/// indistinguishable from the WebView, which is what they should be.
#[tauri::command]
pub fn debug_console_authenticate(
    state: State<'_, CredentialStoreState>,
    password: String,
) -> bool {
    state.verify_debug_console(&password)
}

/// Write the settlement config, through whichever gate the active backend has.
///
/// The single IPC entry point for this group — `set_credential` refuses it, so
/// there is one authenticated path rather than two paths with one gate between
/// them.
///
/// The two backends gate differently because they have different things to
/// prove against:
///
///  * **App Vault** — unchanged. `confirmation_password` carries the vault
///    password to `VaultState::set_blockchain`, which re-derives the encryption
///    key from it and compares in constant time. That check is the App Vault
///    second factor and is not weakened here.
///  * **OS Keychain** — there is no vault password to re-derive, so the
///    confirmation password is checked against a bcrypt hash held outside both
///    credential stores. First write enrols it. See `blockchain_write_auth` for
///    what that does and does not defend against.
///
/// `credential_json` is the `BlockchainInput` shape rather than a typed
/// argument, matching the command contract the frontend was built against. The
/// blank-keeps-existing merge rules still apply once it is parsed, so an
/// operator can correct a USDC address without re-pasting a deployer key.
#[tauri::command]
pub fn set_blockchain_credential(
    app: tauri::AppHandle,
    state: State<'_, CredentialStoreState>,
    credential_json: String,
    confirmation_password: Option<String>,
) -> Result<(), String> {
    let input: BlockchainInput = serde_json::from_str(&credential_json)
        .map_err(|e| format!("Malformed blockchain credential: {e}"))?;
    let password = confirmation_password.unwrap_or_default();

    let backend = state
        .current()
        .ok_or("No credential store selected.")?
        .backend_name();

    if backend == "os_keychain" {
        // Authorize before writing: a rejected password must leave the stored
        // key exactly as it was.
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        crate::blockchain_write_auth::authorize(&data_dir, &password)?;
    }

    state.set_blockchain(&password, input).map_err(|e| e.to_string())
}

/// Has a write authorization password been enrolled?
///
/// Drives the difference between "set a password" and "confirm your password"
/// in the modal, and whether Configuration offers a change link at all.
#[tauri::command]
pub fn has_blockchain_write_auth(app: tauri::AppHandle) -> bool {
    app.path()
        .app_data_dir()
        .map(|dir| crate::blockchain_write_auth::is_set(&dir))
        .unwrap_or(false)
}

/// Replace the write authorization password, proving the current one first.
#[tauri::command]
pub fn change_blockchain_write_auth(
    app: tauri::AppHandle,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::blockchain_write_auth::change(&data_dir, &current_password, &new_password)
}

#[tauri::command]
pub fn vault_get_blockchain_public(
    state: State<'_, CredentialStoreState>,
) -> Result<BlockchainPublic, String> {
    Ok(state.get_blockchain_public())
}

#[tauri::command]
pub fn vault_has_blockchain(state: State<'_, CredentialStoreState>) -> bool {
    state.has_blockchain()
}

// ---- Vault lifecycle (App Vault backend only) -----------------------------
//
// These stay meaningful under the OS-keychain backend too, because an install
// that used to be on App Vault still has a vault file on disk — and the
// Configuration screen has to be able to say so.

#[tauri::command]
pub fn vault_status(state: State<'_, CredentialStoreState>) -> VaultStatus {
    state.vault().status()
}

/// Open the vault.
///
/// Under the lazy-unlock flow this is no longer a launch gate: it is called at
/// the moment a credential is first needed, or when the operator opens
/// Configuration. On a first-run install it still creates the vault.
#[tauri::command]
pub fn vault_unlock(state: State<'_, CredentialStoreState>, password: String) -> UnlockResult {
    state.vault().unlock(&password)
}

#[tauri::command]
pub fn vault_lock(state: State<'_, CredentialStoreState>) {
    state.vault().lock();
}

#[tauri::command]
pub fn vault_change_password(
    state: State<'_, CredentialStoreState>,
    current: String,
    next: String,
) -> Result<(), String> {
    state
        .vault()
        .change_password(&current, &next)
        .map_err(|e| e.to_string())
}

// ============================================================================
// Startup
// ============================================================================

/// Install the backend recorded on disk, if there is one.
///
/// A recorded selection that fails to open — an OS keychain that has become
/// unreachable since last launch — leaves `active` as `None`, which puts the
/// operator back in front of the selector. That is the honest outcome: the app
/// genuinely cannot reach their credentials, and the selector is where the
/// "install libsecret" instructions live.
pub fn init_from_config(state: &CredentialStoreState, data_dir: &std::path::Path) {
    let Some(backend) = read_store_config(data_dir) else {
        return; // First launch — the frontend runs the selection flow.
    };
    if let Err(e) = state.activate(backend) {
        eprintln!("[credential_store] recorded backend {backend:?} failed to open: {e}");
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Distro detection -------------------------------------------------

    #[test]
    fn ubuntu_and_debian_get_apt() {
        assert_eq!(
            install_command_for("NAME=\"Ubuntu\"\nID=ubuntu\nVERSION_ID=\"22.04\"\n"),
            Some("sudo apt install libsecret-1-0")
        );
        assert_eq!(
            install_command_for("ID=debian\nVERSION_ID=\"12\"\n"),
            Some("sudo apt install libsecret-1-0")
        );
        // Derivatives (Mint, Pop!_OS, Raspbian) identify through ID_LIKE.
        assert_eq!(
            install_command_for("ID=linuxmint\nID_LIKE=debian\n"),
            Some("sudo apt install libsecret-1-0")
        );
    }

    #[test]
    fn fedora_gets_dnf() {
        assert_eq!(
            install_command_for("ID=fedora\nVERSION_ID=39\n"),
            Some("sudo dnf install libsecret")
        );
    }

    #[test]
    fn rhel_splits_on_major_version() {
        // 7 predates dnf; 8 and 9 ship it.
        assert_eq!(
            install_command_for("ID=\"rhel\"\nVERSION_ID=\"7.9\"\n"),
            Some("sudo yum install libsecret")
        );
        assert_eq!(
            install_command_for("ID=rhel\nVERSION_ID=\"9.3\"\n"),
            Some("sudo dnf install libsecret")
        );
        // CentOS/Rocky/Alma identify as rhel-like.
        assert_eq!(
            install_command_for("ID=rocky\nID_LIKE=\"rhel centos fedora\"\n"),
            Some("sudo dnf install libsecret")
        );
    }

    #[test]
    fn arch_gets_pacman() {
        assert_eq!(
            install_command_for("ID=arch\n"),
            Some("sudo pacman -S libsecret")
        );
        assert_eq!(
            install_command_for("ID=manjaro\nID_LIKE=arch\n"),
            Some("sudo pacman -S libsecret")
        );
    }

    #[test]
    fn opensuse_gets_zypper() {
        assert_eq!(
            install_command_for("ID=\"opensuse-tumbleweed\"\nID_LIKE=\"opensuse suse\"\n"),
            Some("sudo zypper install libsecret")
        );
    }

    #[test]
    fn nixos_gets_nix_env() {
        assert_eq!(
            install_command_for("ID=nixos\nVERSION_ID=\"23.11\"\n"),
            Some("nix-env -iA nixpkgs.libsecret")
        );
    }

    #[test]
    fn an_unrecognised_distro_gets_no_command_rather_than_a_guess() {
        // A wrong `sudo` line is worse than none — the UI says "unavailable"
        // and offers App Vault instead.
        assert_eq!(install_command_for("ID=plan9\nNAME=\"Plan 9\"\n"), None);
        assert_eq!(install_command_for(""), None);
    }

    #[test]
    fn quoted_values_are_matched_the_same_as_bare_ones() {
        // Real os-release files quote freely, and `ID_LIKE` almost always is
        // (it holds a list). Substring matching missed both openSUSE and the
        // RHEL rebuilds entirely; this is the regression guard for that.
        assert_eq!(
            install_command_for("ID=\"debian\"\n"),
            Some("sudo apt install libsecret-1-0")
        );
        assert_eq!(
            install_command_for("ID=almalinux\nID_LIKE=\"rhel centos fedora\"\nVERSION_ID=\"9.2\"\n"),
            Some("sudo dnf install libsecret")
        );
        assert_eq!(
            install_command_for("ID=\"opensuse-leap\"\nID_LIKE=\"suse opensuse\"\n"),
            Some("sudo zypper install libsecret")
        );
    }

    #[test]
    fn id_like_does_not_leak_into_the_id_lookup() {
        // `ID_LIKE=debian` on a distro whose own ID is unrelated must still
        // resolve through the ID_LIKE branch, not by accidentally reading the
        // ID_LIKE line as ID.
        assert_eq!(os_release_field("ID_LIKE=debian\nID=pop\n", "ID"), Some("pop"));
        assert_eq!(
            os_release_field("ID_LIKE=\"debian ubuntu\"\n", "ID_LIKE"),
            Some("debian ubuntu")
        );
        // A family list must match on whole tokens, not substrings: a distro
        // that is `suse`-like is not `arch`-like just because the letters occur.
        assert_eq!(install_command_for("ID=foo\nID_LIKE=\"hierarchy\"\n"), None);
    }

    #[test]
    fn debian_is_matched_before_rhel_so_ordering_cannot_regress() {
        // A file naming both (unusual, but ID_LIKE is free-form) must resolve
        // deterministically rather than by table order accident.
        let both = "ID=ubuntu\nID_LIKE=\"debian rhel\"\n";
        assert_eq!(install_command_for(both), Some("sudo apt install libsecret-1-0"));
    }

    // ---- Error mapping ----------------------------------------------------

    #[test]
    fn libsecret_error_carries_the_install_command_to_the_renderer() {
        let e = CredentialStoreError::LibsecretNotFound {
            install_command: Some("sudo apt install libsecret-1-0"),
        };
        let wire: StoreBackendError = e.into();
        assert_eq!(wire.code, "LIBSECRET_NOT_FOUND");
        assert_eq!(wire.install_command.as_deref(), Some("sudo apt install libsecret-1-0"));
    }

    #[test]
    fn an_unknown_distro_yields_a_null_install_command_not_an_empty_string() {
        // The UI branches on null to hide the code block entirely; an empty
        // string would render an empty box with a Copy button that copies "".
        let wire: StoreBackendError = CredentialStoreError::LibsecretNotFound {
            install_command: None,
        }
        .into();
        assert_eq!(wire.code, "LIBSECRET_NOT_FOUND");
        assert_eq!(wire.install_command, None);
    }

    #[test]
    fn a_locked_vault_maps_to_a_vault_error_not_to_not_found() {
        // These mean different things to the caller: NotFound is "you never
        // configured this", Locked is "unlock and ask again".
        let wire: StoreBackendError = CredentialStoreError::from(VaultError::Locked).into();
        assert_eq!(wire.code, "VAULT_ERROR");
        assert!(wire.message.contains("locked"));

        let wire: StoreBackendError = CredentialStoreError::from(VaultError::NotFound).into();
        assert_eq!(wire.code, "NOT_FOUND");
    }

    // ---- Key table --------------------------------------------------------

    // ---- Test doubles and fixtures ----------------------------------------

    /// In-memory store, for exercising migration without touching a keychain or
    /// a vault file.
    #[derive(Default)]
    struct MemoryStore {
        map: Mutex<std::collections::HashMap<String, String>>,
        name: &'static str,
    }

    impl MemoryStore {
        fn named(name: &'static str) -> Self {
            Self { map: Mutex::new(std::collections::HashMap::new()), name }
        }
    }

    impl CredentialStore for MemoryStore {
        fn get(&self, key: &str) -> Result<String, CredentialStoreError> {
            self.map
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .ok_or(CredentialStoreError::NotFound)
        }
        fn set(&self, key: &str, value: &str) -> Result<(), CredentialStoreError> {
            self.map.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), CredentialStoreError> {
            self.map.lock().unwrap().remove(key);
            Ok(())
        }
        fn backend_name(&self) -> &'static str {
            self.name
        }
    }

    /// A store whose writes always fail — stands in for a keychain that denies
    /// access partway through a migration.
    struct FailingStore;

    impl CredentialStore for FailingStore {
        fn get(&self, _: &str) -> Result<String, CredentialStoreError> {
            Err(CredentialStoreError::NotFound)
        }
        fn set(&self, _: &str, _: &str) -> Result<(), CredentialStoreError> {
            Err(CredentialStoreError::OsError("denied".into()))
        }
        fn delete(&self, _: &str) -> Result<(), CredentialStoreError> {
            Ok(())
        }
        fn backend_name(&self) -> &'static str {
            "failing"
        }
    }

    /// A representative value per credential key — real shapes, so a store that
    /// mangles JSON or truncates a PEM is caught.
    fn fixture(key: &str) -> String {
        match key {
            "ai" => r#"{"providerName":"Claude","apiKey":"sk-ant-secret","endpoint":"https://api.anthropic.com/v1/messages","connectionType":"http"}"#,
            "smtp" => r#"{"host":"smtp.example.com","port":587,"username":"clerk","password":"smtp-pw"}"#,
            "twilio" => r#"{"accountSid":"AC1","authToken":"twilio-tok","fromNumber":"+15550000000"}"#,
            "docusign" => r#"{"integrationKey":"ik-abc","userId":"u-1","accountId":"acct-987654","baseUri":"https://demo.docusign.net","jwtPrivateKey":"-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----","environment":"sandbox"}"#,
            "clio" => r#"{"appId":"app-1234","clientId":"client-abc","clientSecret":"clio-secret","redirectUri":"http://127.0.0.1:8080/callback","accessToken":"at-live","refreshToken":"rt-live","tokenExpiresAt":"2026-09-05T13:00:00Z"}"#,
            "practice-panther" => r#"{"webhookUrl":"https://example.test/pp","matterId":null,"apiKey":"pp-tok"}"#,
            "blockchain" => r#"{"rpcUrl":"https://eth-sepolia.g.alchemy.com/v2/SECRET","chainId":11155111,"contractAddress":"0xc0","deployerAddress":"0xd0","deployerPrivateKey":"0xdeadbeef","usdcAddress":"0xu0","forwarderAddress":"0xf0","networkName":"Ethereum Sepolia"}"#,
            "debug-console" => r#"{"operatorId":"ops-jordan","passwordHash":"scrypt$15$8$1$AAAAAAAAAAAAAAAAAAAAAA==$3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+7w4="}"#,
            "apify" => r#"{"apiToken":"apify_api_secret"}"#,
            KEY_SEAL => "3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+7w4=",
            other => panic!("no fixture for {other}"),
        }
        .to_string()
    }

    fn populated() -> MemoryStore {
        let s = MemoryStore::named("source");
        for k in CREDENTIAL_KEYS {
            s.set(k, &fixture(k)).unwrap();
        }
        s
    }

    // ---- Migration --------------------------------------------------------

    #[test]
    fn migration_transfers_every_credential_verbatim() {
        let (source, target) = (populated(), MemoryStore::named("target"));
        let (migrated, failed) = copy_all(&source, &target);

        assert!(failed.is_empty(), "unexpected failures: {failed:?}");
        assert_eq!(migrated.len(), CREDENTIAL_KEYS.len());
        for k in CREDENTIAL_KEYS {
            assert_eq!(target.get(k).unwrap(), fixture(k), "key {k} did not transfer intact");
        }
        // The PEM's internal newlines are load-bearing for parsing — a copy
        // that normalised them would authenticate against nothing.
        assert!(target.get("docusign").unwrap().contains("\\n-----END RSA PRIVATE KEY-----"));
    }

    #[test]
    fn migration_leaves_the_source_intact() {
        // Non-destructive by design: if the target turns out to be unreadable
        // on the next launch, switching back has to recover everything. Two of
        // these (the PEM, the deployer key) cannot be reconstructed.
        let (source, target) = (populated(), MemoryStore::named("target"));
        copy_all(&source, &target);
        for k in CREDENTIAL_KEYS {
            assert_eq!(source.get(k).unwrap(), fixture(k), "key {k} was removed from the source");
        }
    }

    #[test]
    fn migration_skips_unset_keys_without_reporting_them_as_failures() {
        // Most installs configure a subset. Listing the rest as "failed" would
        // send an operator hunting for credentials they never had.
        let source = MemoryStore::named("source");
        source.set("ai", &fixture("ai")).unwrap();
        source.set(KEY_SEAL, &fixture(KEY_SEAL)).unwrap();
        let target = MemoryStore::named("target");

        let (migrated, failed) = copy_all(&source, &target);
        assert_eq!(migrated, vec!["ai".to_string(), KEY_SEAL.to_string()]);
        assert!(failed.is_empty());
        assert!(matches!(target.get("docusign"), Err(CredentialStoreError::NotFound)));
    }

    #[test]
    fn migration_collects_every_failure_rather_than_stopping_at_the_first() {
        // A Clio token that will not copy must not strand the DocuSign PEM —
        // the operator needs the full list of what to re-enter.
        let (migrated, failed) = copy_all(&populated(), &FailingStore);
        assert!(migrated.is_empty());
        assert_eq!(failed.len(), CREDENTIAL_KEYS.len());
    }

    #[test]
    fn the_seal_key_migrates_last_so_an_interruption_costs_the_least() {
        let (source, target) = (populated(), MemoryStore::named("target"));
        let (migrated, _) = copy_all(&source, &target);
        assert_eq!(migrated.last().map(String::as_str), Some(KEY_SEAL));
    }

    // ---- VaultStore through the trait -------------------------------------

    fn temp_vault() -> Arc<VaultState> {
        let dir = std::env::temp_dir().join(format!("lexstore_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(VaultState::new(&dir))
    }

    #[test]
    fn vault_store_round_trips_every_credential_key() {
        let vault = temp_vault();
        vault.unlock("pw");
        let store = VaultStore::new(vault.clone());
        assert_eq!(store.backend_name(), "app_vault");

        for k in CREDENTIAL_KEYS {
            store.set(k, &fixture(k)).unwrap();
            let back: serde_json::Value = serde_json::from_str(&store.get(k).unwrap())
                .unwrap_or_else(|_| serde_json::Value::String(store.get(k).unwrap()));
            let want: serde_json::Value = serde_json::from_str(&fixture(k))
                .unwrap_or_else(|_| serde_json::Value::String(fixture(k)));
            assert_eq!(back, want, "key {k} did not round-trip");
        }

        // Survives the encrypt/decrypt cycle, not just the in-memory copy.
        vault.lock();
        assert!(vault.unlock("pw").ok);
        assert!(store.get("docusign").unwrap().contains("BEGIN RSA PRIVATE KEY"));
    }

    #[test]
    fn a_locked_vault_store_reports_locked_rather_than_not_found() {
        // The distinction drives the UI: NotFound means "configure this",
        // Locked means "unlock and ask again".
        let vault = temp_vault();
        vault.unlock("pw");
        let store = VaultStore::new(vault.clone());
        store.set("ai", &fixture("ai")).unwrap();

        vault.lock();
        assert!(matches!(store.get("ai"), Err(CredentialStoreError::VaultError(_))));
    }

    #[test]
    fn the_seal_key_cannot_be_deleted_through_either_backend() {
        // Dropping it orphans every AnchorReceipt this install has issued, so
        // both backends refuse rather than silently no-op.
        let vault = temp_vault();
        vault.unlock("pw");
        let store = VaultStore::new(vault);
        store.set(KEY_SEAL, &fixture(KEY_SEAL)).unwrap();
        assert!(store.delete(KEY_SEAL).is_err());
        assert_eq!(store.get(KEY_SEAL).unwrap(), fixture(KEY_SEAL));
    }

    #[test]
    fn store_state_mints_a_stable_seal_key_on_first_use() {
        // Minting moves from vault-unlock to first-use so the OS-keychain
        // backend — which has no unlock event — gets one at all. The property
        // that matters is unchanged: stable for the life of the install.
        let vault = temp_vault();
        vault.unlock("pw");
        let state = CredentialStoreState::new(vault);
        state.activate(StoreBackend::AppVault).unwrap();

        let first = state.resolve_seal_key().expect("minted on first use").to_vec();
        assert_eq!(first.len(), 32);
        assert_eq!(state.resolve_seal_key().unwrap().to_vec(), first, "seal key is not stable");
    }

    #[test]
    fn store_state_applies_the_blank_keeps_existing_rule() {
        // The house rule, now enforced one level up so both backends share it.
        let vault = temp_vault();
        vault.unlock("pw");
        let state = CredentialStoreState::new(vault);
        state.activate(StoreBackend::AppVault).unwrap();

        state
            .set_smtp(serde_json::from_str(
                r#"{"host":"smtp.a.test","port":587,"username":"u","password":"secret"}"#,
            ).unwrap())
            .unwrap();
        // Edit the host, omit the password.
        state
            .set_smtp(serde_json::from_str(
                r#"{"host":"smtp.b.test","port":465,"username":"u2"}"#,
            ).unwrap())
            .unwrap();

        let smtp = state.resolve_smtp().unwrap();
        assert_eq!(smtp.password, "secret", "blank password cleared the stored one");
        assert_eq!(smtp.host, "smtp.b.test");

        // And the public shape still carries no secret.
        let json = serde_json::to_string(&state.get_public()).unwrap();
        assert!(!json.contains("secret"), "password leaked into the public shape: {json}");
    }

    // ---- OS keychain round-trip -------------------------------------------
    //
    // These touch the real platform keychain. They run under a per-run unique
    // service name rather than "lexescrow", so they cannot disturb credentials
    // a developer actually has stored. Where no keychain is reachable — a
    // headless Linux CI box with no Secret Service — they report that and
    // return rather than failing a suite that has nothing to do with the
    // platform's keyring being absent.

    fn os_store_or_skip() -> Option<OsKeychainStore> {
        let service = format!("lexescrow-test-{}", uuid::Uuid::new_v4());
        match OsKeychainStore::open_with_service(&service) {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("skipping OS keychain test — no reachable keyring: {e}");
                None
            }
        }
    }

    #[test]
    fn os_keychain_round_trips_every_credential_key() {
        let Some(store) = os_store_or_skip() else { return };
        assert_eq!(store.backend_name(), "os_keychain");

        for k in CREDENTIAL_KEYS {
            assert!(
                matches!(store.get(k), Err(CredentialStoreError::NotFound)),
                "key {k} was already present in a fresh service"
            );
            store.set(k, &fixture(k)).unwrap();
            assert_eq!(store.get(k).unwrap(), fixture(k), "key {k} did not round-trip");
        }

        // Delete every key the operator can delete, then confirm it is gone.
        for k in CREDENTIAL_KEYS.iter().filter(|k| **k != KEY_SEAL) {
            store.delete(k).unwrap();
            assert!(
                matches!(store.get(k), Err(CredentialStoreError::NotFound)),
                "key {k} survived deletion"
            );
            // Deleting an absent entry is the requested end state, not an error.
            store.delete(k).unwrap();
        }

        // The seal is refused here exactly as it is in the vault backend.
        assert!(store.delete(KEY_SEAL).is_err());
        assert_eq!(store.get(KEY_SEAL).unwrap(), fixture(KEY_SEAL));
        let entry = keyring::Entry::new(&store.service, KEY_SEAL).unwrap();
        let _ = entry.delete_password(); // housekeeping — leave no test entries
    }

    #[test]
    fn os_keychain_overwrites_rather_than_duplicating_on_reset() {
        let Some(store) = os_store_or_skip() else { return };
        store.set("ai", "first").unwrap();
        store.set("ai", "second").unwrap();
        assert_eq!(store.get("ai").unwrap(), "second");
        store.delete("ai").unwrap();
    }

    #[test]
    fn migration_into_the_real_os_keychain_transfers_everything() {
        let Some(target) = os_store_or_skip() else { return };
        let vault = temp_vault();
        vault.unlock("pw");
        let source = VaultStore::new(vault);
        for k in CREDENTIAL_KEYS {
            source.set(k, &fixture(k)).unwrap();
        }

        let (migrated, failed) = copy_all(&source, &target);
        assert!(failed.is_empty(), "failures: {failed:?}");
        assert_eq!(migrated.len(), CREDENTIAL_KEYS.len());
        for k in CREDENTIAL_KEYS {
            let got: serde_json::Value = serde_json::from_str(&target.get(k).unwrap())
                .unwrap_or_else(|_| serde_json::Value::String(target.get(k).unwrap()));
            let want: serde_json::Value = serde_json::from_str(&fixture(k))
                .unwrap_or_else(|_| serde_json::Value::String(fixture(k)));
            assert_eq!(got, want, "key {k} did not survive migration to the keychain");
            let entry = keyring::Entry::new(&target.service, k).unwrap();
            let _ = entry.delete_password();
        }
    }

    // ---- Blockchain write gate --------------------------------------------
    //
    // Exercised against `CredentialStoreState` plus the auth module directly
    // rather than through the `#[tauri::command]` wrapper, which needs a live
    // `AppHandle` for the data directory. The wrapper is three lines — parse,
    // authorize, delegate — and everything under test here is what those three
    // lines call.

    use crate::blockchain_write_auth as auth;

    const CHAIN_JSON: &str = r#"{"rpcUrl":"https://eth-sepolia.g.alchemy.com/v2/SECRET","chainId":11155111,"contractAddress":"0xc0","deployerAddress":"0xd0","deployerPrivateKey":"0xdeadbeef","usdcAddress":"0xu0","forwarderAddress":"0xf0","networkName":"Ethereum Sepolia"}"#;

    fn chain_input(private_key: &str) -> BlockchainInput {
        let mut v: serde_json::Value = serde_json::from_str(CHAIN_JSON).unwrap();
        v["deployerPrivateKey"] = serde_json::Value::String(private_key.into());
        serde_json::from_value(v).unwrap()
    }

    /// The gate, as `set_blockchain_credential` applies it: authorize under the
    /// OS keychain, then write. Mirrors the command body without the AppHandle.
    fn gated_write(
        state: &CredentialStoreState,
        data_dir: &std::path::Path,
        password: &str,
        input: BlockchainInput,
    ) -> Result<(), String> {
        let backend = state.current().unwrap().backend_name();
        if backend == "os_keychain" {
            auth::authorize(data_dir, password)?;
        }
        state.set_blockchain(password, input).map_err(|e| e.to_string())
    }

    /// A store state backed by the real platform keychain, or `None` to skip.
    fn keychain_state() -> Option<(CredentialStoreState, String)> {
        let service = format!("lexescrow-test-{}", uuid::Uuid::new_v4());
        let store = OsKeychainStore::open_with_service(&service).ok()?;
        let state = CredentialStoreState::new(temp_vault());
        *state.active.lock().unwrap() = Some(Arc::new(store));
        Some((state, service))
    }

    fn purge(service: &str) {
        for k in CREDENTIAL_KEYS {
            if let Ok(e) = keyring::Entry::new(service, k) {
                let _ = e.delete_password();
            }
        }
    }

    #[test]
    fn os_keychain_first_blockchain_write_enrols_the_password_and_succeeds() {
        let Some((state, service)) = keychain_state() else { return };
        let dir = temp_dir_for_auth();
        assert!(!auth::is_set(&dir));

        gated_write(&state, &dir, "write-auth-pw", chain_input("0xfirst")).unwrap();

        assert!(auth::is_set(&dir), "first write did not enrol a password");
        assert_eq!(state.resolve_blockchain().unwrap().deployer_private_key, "0xfirst");
        purge(&service);
    }

    #[test]
    fn os_keychain_later_write_succeeds_with_the_enrolled_password() {
        let Some((state, service)) = keychain_state() else { return };
        let dir = temp_dir_for_auth();
        gated_write(&state, &dir, "write-auth-pw", chain_input("0xfirst")).unwrap();

        gated_write(&state, &dir, "write-auth-pw", chain_input("0xsecond")).unwrap();

        assert_eq!(state.resolve_blockchain().unwrap().deployer_private_key, "0xsecond");
        purge(&service);
    }

    #[test]
    fn os_keychain_write_with_the_wrong_password_is_refused_and_changes_nothing() {
        let Some((state, service)) = keychain_state() else { return };
        let dir = temp_dir_for_auth();
        gated_write(&state, &dir, "write-auth-pw", chain_input("0xoriginal")).unwrap();

        let err = gated_write(&state, &dir, "guessed", chain_input("0xattacker")).unwrap_err();
        assert_eq!(err, auth::ERR_WRONG_PASSWORD);

        // The point of authorizing before writing: a rejected attempt must
        // leave the stored key exactly as it was.
        assert_eq!(state.resolve_blockchain().unwrap().deployer_private_key, "0xoriginal");
        purge(&service);
    }

    #[test]
    fn app_vault_still_gates_on_the_vault_password_not_on_the_bcrypt_hash() {
        // "Unchanged" means the vault's own re-derive check is what runs. No
        // hash file is consulted, and none is written.
        let vault = temp_vault();
        vault.unlock("vault-pw");
        let state = CredentialStoreState::new(vault);
        state.activate(StoreBackend::AppVault).unwrap();
        let dir = temp_dir_for_auth();

        assert!(gated_write(&state, &dir, "not-the-vault-password", chain_input("0xk")).is_err());
        assert!(state.resolve_blockchain().is_none());

        gated_write(&state, &dir, "vault-pw", chain_input("0xk")).unwrap();
        assert_eq!(state.resolve_blockchain().unwrap().deployer_private_key, "0xk");

        // The OS-keychain gate never engaged, so nothing was enrolled.
        assert!(!auth::is_set(&dir), "app vault wrote a write-auth hash");
    }

    #[test]
    fn the_generic_setter_refuses_the_blockchain_group() {
        // The gate is only a gate if there is no way around it.
        let err = guard_generic_key("blockchain").unwrap_err();
        assert_eq!(err, "Use set_blockchain_credential for the blockchain group");

        // Every other group stays reachable — they are revocable credentials,
        // and routing them through a confirmation prompt would be friction
        // with nothing behind it.
        for k in CREDENTIAL_KEYS.iter().filter(|k| **k != "blockchain" && **k != KEY_SEAL) {
            assert!(guard_generic_key(k).is_ok(), "generic setter refused {k}");
        }
        assert!(guard_generic_key("not-a-key").is_err());
    }

    #[test]
    fn the_generic_setter_refuses_the_seal_key() {
        // Minted, never typed: a WebView write would orphan every issued receipt.
        assert!(guard_generic_key(KEY_SEAL).is_err());
    }

    #[test]
    fn a_malformed_credential_payload_is_rejected_before_the_gate_is_touched() {
        let dir = temp_dir_for_auth();
        assert!(serde_json::from_str::<BlockchainInput>("{\"nope\":1}").is_err());
        assert!(!auth::is_set(&dir));
    }

    fn temp_dir_for_auth() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lexauthcmd_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn every_credential_key_is_unique_and_the_seal_migrates_last() {
        let mut seen = std::collections::HashSet::new();
        for k in CREDENTIAL_KEYS {
            assert!(seen.insert(*k), "duplicate credential key {k}");
        }
        assert_eq!(CREDENTIAL_KEYS.len(), 10);
        assert_eq!(*CREDENTIAL_KEYS.last().unwrap(), KEY_SEAL);
    }

    // ---- LexTrace debug console -------------------------------------------

    /// A store state backed by an unlocked App Vault — the backend the debug
    /// console is normally configured under.
    fn vault_backed_state() -> CredentialStoreState {
        let vault = temp_vault();
        vault.unlock("vault-pw");
        let state = CredentialStoreState::new(vault);
        state.activate(StoreBackend::AppVault).unwrap();
        state
    }

    fn debug_input(operator: &str, password: Option<&str>) -> DebugConsoleInput {
        DebugConsoleInput {
            operator_id: operator.to_string(),
            password: password.map(str::to_string),
        }
    }

    #[test]
    fn the_debug_group_routes_through_the_active_store() {
        let state = vault_backed_state();
        assert!(!state.has_debug_console());
        assert!(state.debug_operator_id().is_none());

        state.set_debug_console(debug_input("ops-jordan", Some("console-pw"))).unwrap();

        assert!(state.has_debug_console());
        assert_eq!(state.debug_operator_id().as_deref(), Some("ops-jordan"));
        assert!(state.verify_debug_console("console-pw"));
        assert!(!state.verify_debug_console("wrong"));

        let pubv = state.get_debug_console_public();
        assert!(pubv.configured);
        assert_eq!(pubv.operator_id, "ops-jordan");
    }

    #[test]
    fn an_unconfigured_console_verifies_nothing_and_names_nobody() {
        // `debug_operator_id` is what stamps the audit trail, so "not
        // configured" has to mean "no run, no row" rather than an anonymous one.
        let state = vault_backed_state();
        assert!(!state.verify_debug_console(""));
        assert!(!state.verify_debug_console("anything"));
        assert!(state.debug_operator_id().is_none());
    }

    #[test]
    fn a_half_configured_console_is_not_configured() {
        // Written straight through the generic setter, which is the one path
        // that can produce a group the typed setter would have refused.
        let state = vault_backed_state();
        state
            .current()
            .unwrap()
            .set("debug-console", r#"{"operatorId":"ops","passwordHash":""}"#)
            .unwrap();

        assert!(!state.has_debug_console());
        assert!(state.debug_operator_id().is_none());
        assert!(!state.verify_debug_console(""));
    }

    #[test]
    fn the_debug_group_is_deletable_through_the_store() {
        let state = vault_backed_state();
        state.set_debug_console(debug_input("ops", Some("pw"))).unwrap();
        state.delete_key("debug-console").unwrap();
        assert!(!state.has_debug_console());
    }

    #[test]
    fn the_debug_group_migrates_between_backends_like_any_other() {
        // The reason it belongs in CREDENTIAL_KEYS at all: an operator who
        // switches stores should not have to re-enrol the console.
        let (source, target) = (MemoryStore::named("source"), MemoryStore::named("target"));
        source.set("debug-console", &fixture("debug-console")).unwrap();

        let (migrated, failed) = copy_all(&source, &target);
        assert!(failed.is_empty());
        assert_eq!(migrated, vec!["debug-console".to_string()]);
        assert_eq!(target.get("debug-console").unwrap(), fixture("debug-console"));
    }
}
