//! Which credential backend this install uses.
//!
//! Deliberately plaintext, and deliberately *not* held in either credential
//! store: it is the answer to "which store do I open", so it has to be readable
//! before any store exists. A selection kept inside the vault could only be read
//! by unlocking the vault, which is exactly the question being asked.
//!
//! Nothing secret lives here. The file says which of two backends holds the
//! credentials, not what any of them are — an attacker who reads it learns only
//! what the Configuration screen already displays.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const STORE_CONFIG_FILENAME: &str = "lexescrow_store_config.json";

/// The two credential backends. Serialized as `"os_keychain"` / `"app_vault"`,
/// which is also the wire form the frontend uses, so the string that crosses
/// IPC and the string on disk cannot drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreBackend {
    OsKeychain,
    AppVault,
}

impl StoreBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            StoreBackend::OsKeychain => "os_keychain",
            StoreBackend::AppVault => "app_vault",
        }
    }

    /// Parse the wire form. Returns `None` for anything else, so a hand-edited
    /// config file reads as "not configured" and re-runs the selection flow
    /// rather than silently defaulting to a backend the operator did not pick.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "os_keychain" => Some(StoreBackend::OsKeychain),
            "app_vault" => Some(StoreBackend::AppVault),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct StoreConfigFile {
    backend: StoreBackend,
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join(STORE_CONFIG_FILENAME)
}

/// Read the selected backend. `None` means first launch — no file yet — and is
/// what gates the selection UI.
///
/// An unreadable or malformed file also reads as `None`. That is the safe
/// direction: re-asking costs one click, whereas guessing a backend would point
/// the app at a store that may hold nothing and report the operator's
/// credentials as missing.
pub fn read_store_config(data_dir: &Path) -> Option<StoreBackend> {
    let raw = fs::read_to_string(config_path(data_dir)).ok()?;
    serde_json::from_str::<StoreConfigFile>(&raw).ok().map(|c| c.backend)
}

/// Persist the selected backend.
///
/// Written atomically (temp + rename) for the same reason the vault is: a
/// crash mid-write would otherwise leave a truncated file, and a truncated
/// selection reads as first-launch on the next start — sending an operator with
/// a populated keychain back through onboarding.
pub fn write_store_config(data_dir: &Path, backend: StoreBackend) -> std::io::Result<()> {
    let path = config_path(data_dir);
    let json = serde_json::to_vec_pretty(&StoreConfigFile { backend })
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &json)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lexstorecfg_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn absent_config_reads_as_first_launch() {
        assert_eq!(read_store_config(&temp_dir()), None);
    }

    #[test]
    fn roundtrips_both_backends() {
        let dir = temp_dir();
        write_store_config(&dir, StoreBackend::OsKeychain).unwrap();
        assert_eq!(read_store_config(&dir), Some(StoreBackend::OsKeychain));
        // Switching overwrites rather than appending a second selection.
        write_store_config(&dir, StoreBackend::AppVault).unwrap();
        assert_eq!(read_store_config(&dir), Some(StoreBackend::AppVault));
    }

    #[test]
    fn on_disk_shape_is_the_documented_one() {
        let dir = temp_dir();
        write_store_config(&dir, StoreBackend::OsKeychain).unwrap();
        let raw = fs::read_to_string(config_path(&dir)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["backend"], "os_keychain");
    }

    #[test]
    fn malformed_config_reads_as_first_launch_not_as_a_guess() {
        let dir = temp_dir();
        fs::write(config_path(&dir), r#"{"backend":"typo_backend"}"#).unwrap();
        assert_eq!(read_store_config(&dir), None);
        fs::write(config_path(&dir), "not json at all").unwrap();
        assert_eq!(read_store_config(&dir), None);
    }

    #[test]
    fn parse_and_as_str_agree_on_the_wire_form() {
        for b in [StoreBackend::OsKeychain, StoreBackend::AppVault] {
            assert_eq!(StoreBackend::parse(b.as_str()), Some(b));
        }
        assert_eq!(StoreBackend::parse("keychain"), None);
    }
}
