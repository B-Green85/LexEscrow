// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

//! Write-authorization gate for the deployer private key.
//!
//! The App Vault backend already gates this write: `VaultState::set_blockchain`
//! re-derives the encryption key from a submitted password and compares it in
//! constant time, so writing a deployer key means proving you know the vault
//! password. The OS-keychain backend has no such password — the login session
//! unlocked the store — which left the single most dangerous write in the
//! application with no friction at all on an unattended machine.
//!
//! This module supplies that friction: a bcrypt-hashed confirmation password,
//! stored outside both credential backends, checked on every blockchain write.
//!
//! # What this is, and what it is not
//!
//! It is an **intent confirmation**, not a security boundary. The hash lives in
//! a file the running user owns, and the "no hash yet" path treats the supplied
//! password as the new one — so anyone who can delete that file can set their
//! own password and proceed. Someone with a shell as this user can also write
//! the keyring entry directly (`security add-generic-password` on macOS,
//! `secret-tool store` on Linux) and never involve this code at all.
//!
//! What it does buy is real, and it is what the feature was asked for: an
//! unattended, unlocked LexEscrow window is no longer a two-click path to
//! swapping the key that moves escrowed funds. Someone who wanders past a
//! logged-in machine hits a wall. Someone determined, with a terminal, does not.
//!
//! If the threat model is the second person, the hash has to move somewhere the
//! app user cannot silently rewrite — an OS keychain item with its own ACL, or
//! a hardware token — and the absent-hash case has to fail closed instead of
//! offering enrolment.

use std::fs;
use std::path::{Path, PathBuf};

const AUTH_FILENAME: &str = "blockchain_write_auth.hash";

/// bcrypt work factor. 12 is ~250ms per verify on current hardware — chosen to
/// be felt rather than fast, on a prompt that appears only when a deployer key
/// changes.
const BCRYPT_COST: u32 = 12;

pub const ERR_WRONG_PASSWORD: &str = "Authorization password incorrect";
pub const ERR_WRONG_CURRENT: &str = "Current password incorrect";
pub const ERR_NOT_SET: &str = "No write authorization password has been set";

fn auth_path(data_dir: &Path) -> PathBuf {
    data_dir.join(AUTH_FILENAME)
}

/// The stored hash, if one has been set.
///
/// A blank or whitespace-only file reads as "not set" rather than as a hash
/// that will never match: a truncated write should send the operator back
/// through enrolment, not lock them out of their own settlement config with no
/// way to recover it.
pub fn read_hash(data_dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(auth_path(data_dir)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Hash and persist a new authorization password.
///
/// Written atomically and 0600, matching the vault file. Neither measure
/// defends against the user this app runs as — see the module docs — but a
/// half-written hash file would be a lockout, and a world-readable one would
/// hand an offline cracker the target for free.
pub fn write_hash(data_dir: &Path, password: &str) -> Result<(), String> {
    let hashed = bcrypt::hash(password, BCRYPT_COST).map_err(|e| e.to_string())?;
    let path = auth_path(data_dir);
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, hashed.as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Constant-time-ish verify via bcrypt. A corrupt hash verifies as `false`
/// rather than erroring, so a mangled file behaves like a wrong password.
pub fn verify(password: &str, hash: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}

/// Has an authorization password been enrolled?
pub fn is_set(data_dir: &Path) -> bool {
    read_hash(data_dir).is_some()
}

/// Apply the gate for one blockchain write.
///
/// Enrols on first use — with no hash on file there is nothing to check
/// against, so the supplied password becomes the authorization password. That
/// is what the feature was specified to do, and it is also the reason this is
/// confirmation rather than protection: deleting the hash file returns any
/// caller to this branch.
///
/// An empty password is refused in both branches. Enrolling one would create a
/// gate that opens on a bare Enter keypress, and the modal that calls this
/// already requires the field twice.
pub fn authorize(data_dir: &Path, password: &str) -> Result<(), String> {
    if password.is_empty() {
        return Err(ERR_WRONG_PASSWORD.to_string());
    }
    match read_hash(data_dir) {
        Some(hash) => {
            if verify(password, &hash) {
                Ok(())
            } else {
                Err(ERR_WRONG_PASSWORD.to_string())
            }
        }
        None => write_hash(data_dir, password),
    }
}

/// Replace the authorization password, proving knowledge of the current one.
///
/// Refuses when nothing is enrolled rather than silently enrolling: a "change"
/// that turns out to be a first-time set is a different operation than the one
/// the operator asked for, and quietly widening it is how a UI ends up
/// accepting a password nobody meant to set.
pub fn change(data_dir: &Path, current: &str, next: &str) -> Result<(), String> {
    let Some(hash) = read_hash(data_dir) else {
        return Err(ERR_NOT_SET.to_string());
    };
    if !verify(current, &hash) {
        return Err(ERR_WRONG_CURRENT.to_string());
    }
    if next.is_empty() {
        return Err("New password cannot be empty".to_string());
    }
    write_hash(data_dir, next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lexauth_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn nothing_is_enrolled_before_the_first_write() {
        let dir = temp_dir();
        assert!(!is_set(&dir));
        assert_eq!(read_hash(&dir), None);
    }

    #[test]
    fn the_first_authorize_enrols_the_supplied_password() {
        let dir = temp_dir();
        authorize(&dir, "correct horse").unwrap();
        assert!(is_set(&dir));

        // What landed on disk is a bcrypt hash, not the password.
        let stored = read_hash(&dir).unwrap();
        assert!(stored.starts_with("$2"), "not a bcrypt hash: {stored}");
        assert!(!stored.contains("correct horse"));
        assert!(verify("correct horse", &stored));
    }

    #[test]
    fn a_later_authorize_checks_against_the_enrolled_password() {
        let dir = temp_dir();
        authorize(&dir, "correct horse").unwrap();
        let enrolled = read_hash(&dir).unwrap();

        authorize(&dir, "correct horse").unwrap();
        assert_eq!(read_hash(&dir).unwrap(), enrolled, "a successful check re-wrote the hash");

        assert_eq!(authorize(&dir, "wrong horse").unwrap_err(), ERR_WRONG_PASSWORD);
        // A rejected attempt must not disturb what is enrolled.
        assert_eq!(read_hash(&dir).unwrap(), enrolled);
    }

    #[test]
    fn an_empty_password_is_refused_rather_than_enrolled() {
        // Enrolling one would build a gate that opens on a bare Enter press.
        let dir = temp_dir();
        assert_eq!(authorize(&dir, "").unwrap_err(), ERR_WRONG_PASSWORD);
        assert!(!is_set(&dir));

        authorize(&dir, "real").unwrap();
        assert_eq!(authorize(&dir, "").unwrap_err(), ERR_WRONG_PASSWORD);
    }

    #[test]
    fn change_requires_the_current_password() {
        let dir = temp_dir();
        authorize(&dir, "first").unwrap();
        let before = read_hash(&dir).unwrap();

        assert_eq!(change(&dir, "not-it", "second").unwrap_err(), ERR_WRONG_CURRENT);
        assert_eq!(read_hash(&dir).unwrap(), before, "a failed change altered the hash");
        // And the original still works.
        authorize(&dir, "first").unwrap();

        change(&dir, "first", "second").unwrap();
        assert_ne!(read_hash(&dir).unwrap(), before);
        authorize(&dir, "second").unwrap();
        assert_eq!(authorize(&dir, "first").unwrap_err(), ERR_WRONG_PASSWORD);
    }

    #[test]
    fn change_refuses_when_nothing_is_enrolled() {
        // Silently turning a change into a first-time set would accept a
        // password the operator never meant to establish.
        let dir = temp_dir();
        assert_eq!(change(&dir, "anything", "new").unwrap_err(), ERR_NOT_SET);
        assert!(!is_set(&dir));
    }

    #[test]
    fn change_refuses_an_empty_new_password() {
        let dir = temp_dir();
        authorize(&dir, "first").unwrap();
        assert!(change(&dir, "first", "").is_err());
        authorize(&dir, "first").unwrap();
    }

    #[test]
    fn a_truncated_hash_file_reads_as_unenrolled_rather_than_locking_the_operator_out() {
        let dir = temp_dir();
        authorize(&dir, "first").unwrap();
        fs::write(auth_path(&dir), "   \n").unwrap();

        assert!(!is_set(&dir));
        // Back through enrolment, not into a gate nothing can open.
        authorize(&dir, "recovered").unwrap();
        assert!(verify("recovered", &read_hash(&dir).unwrap()));
    }

    #[test]
    fn a_corrupt_hash_behaves_like_a_wrong_password_not_a_crash() {
        let dir = temp_dir();
        fs::write(auth_path(&dir), "not-a-bcrypt-hash").unwrap();
        assert!(is_set(&dir));
        assert!(!verify("anything", "not-a-bcrypt-hash"));
        assert_eq!(authorize(&dir, "anything").unwrap_err(), ERR_WRONG_PASSWORD);
    }

    #[test]
    fn the_hash_is_salted_so_two_installs_sharing_a_password_do_not_share_a_hash() {
        let (a, b) = (temp_dir(), temp_dir());
        authorize(&a, "same password").unwrap();
        authorize(&b, "same password").unwrap();
        assert_ne!(read_hash(&a).unwrap(), read_hash(&b).unwrap());
    }

    #[test]
    fn deleting_the_hash_file_reopens_enrolment() {
        // Documenting the known bypass rather than pretending it is absent:
        // anyone who can remove this file can set their own password. The gate
        // is intent confirmation against a passer-by, not a defence against
        // someone holding a shell as this user.
        let dir = temp_dir();
        authorize(&dir, "original").unwrap();
        fs::remove_file(auth_path(&dir)).unwrap();

        assert!(!is_set(&dir));
        authorize(&dir, "attacker-chosen").unwrap();
        assert!(verify("attacker-chosen", &read_hash(&dir).unwrap()));
    }
}
