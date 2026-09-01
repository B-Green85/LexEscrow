# Claude Code Prompt — Blockchain Credential Write Gate

## Context

LexEscrow now has a dual-backend credential store: OS Keychain or App Vault. The App Vault re-derives the encryption key from a submitted password before writing the deployer private key — so saving that key requires the user to prove they know the vault password. That check does not exist on the OS Keychain backend because there is no vault password.

A deployer private key controls irreversible on-chain fund movements. If someone has physical access to an unlocked machine running the OS Keychain backend, they currently have a path to overwrite that key with no friction. This needs a targeted fix — not a full backend migration requirement, just a one-write-path password gate.

---

## What to build

### The rule

When the active backend is OS Keychain, saving the `blockchain` credential group requires the user to pass a one-time session confirmation before the write is accepted. This confirmation is:

- A modal prompting for a user-chosen "write authorization password"
- This password is NOT the vault password (there is no vault on OS Keychain)
- This password is NOT stored anywhere — it is entered, used to confirm intent, and discarded
- The password must be entered twice (confirm field) to rule out typos
- On confirm, the `blockchain` credential write proceeds
- This gate fires every time the blockchain credential is written — not just the first time

This is an intent confirmation gate, not an encryption mechanism. Its purpose is to prevent an unlocked unattended machine from being used to silently swap the deployer key.

---

## Tauri command changes

Add one new command:

```rust
// Write the blockchain credential group with confirmation gate.
// Under App Vault backend: behavior unchanged — existing password re-derive check applies.
// Under OS Keychain backend: requires confirmation_password to be supplied.
//   confirmation_password is checked against a stored bcrypt hash (see below).
//   If no hash exists yet (first time setting blockchain credential on OS Keychain),
//   treat the supplied password as the new authorization password — hash and store it,
//   then proceed with the write.
//   If a hash exists, verify supplied password matches before writing.
//   On mismatch: return Err("Authorization password incorrect")
// confirmation_password is ignored under App Vault backend.
#[tauri::command]
async fn set_blockchain_credential(
    credential_json: String,
    confirmation_password: Option<String>,
) -> Result<(), String>
```

The bcrypt hash of the authorization password is stored in the app data directory as `blockchain_write_auth.hash` — a plain text file containing only the bcrypt hash string. It is NOT stored in either credential backend. Use `bcrypt` crate, cost factor 12.

Add a second command:

```rust
// Returns true if a blockchain write authorization password has been set.
// Used by the frontend to show "Change authorization password" vs "Set authorization password".
#[tauri::command]
async fn has_blockchain_write_auth() -> bool
```

Add a third command:

```rust
// Change the blockchain write authorization password.
// Requires the current password to be supplied and verified before accepting the new one.
// Returns Err("Current password incorrect") on mismatch.
#[tauri::command]
async fn change_blockchain_write_auth(
    current_password: String,
    new_password: String,
) -> Result<(), String>
```

---

## Frontend changes

### Screen 7 — Blockchain credential section

The blockchain credential group entry in Screen 7 currently has fields for `rpcUrl` and `deployerPrivateKey` with a save button.

Update the save flow:

**App Vault backend:** No change. Existing behavior.

**OS Keychain backend:**

When the user hits save on the blockchain credential group, show `BlockchainWriteAuthModal` before the write is submitted.

### BlockchainWriteAuthModal

Create `src/components/BlockchainWriteAuthModal.tsx`.

**First-time flow** (no auth hash set yet — `has_blockchain_write_auth()` returns false):

> **Set a write authorization password**
>
> The deployer private key controls on-chain fund movements. Set a password that will be required every time this key is changed.
>
> [Password field]
> [Confirm password field]
> [Set password and save] [Cancel]

**Subsequent writes** (auth hash exists):

> **Confirm deployer key change**
>
> Enter your write authorization password to save the new deployer private key.
>
> [Password field]
> [Confirm] [Cancel]

On confirm: call `set_blockchain_credential(credentialJson, password)`.
On success: close modal, show success toast.
On error "Authorization password incorrect": show inline error, clear password field, keep modal open.
On cancel: close modal, do not write.

### Screen 7 — Change authorization password

Below the blockchain credential fields on OS Keychain backend, add a "Change write authorization password" link (only visible when `has_blockchain_write_auth()` is true). Clicking it opens a simple modal:

> [Current password]
> [New password]
> [Confirm new password]
> [Change] [Cancel]

Calls `change_blockchain_write_auth(current, new)`.

---

## What NOT to change

- App Vault backend blockchain write path — untouched
- Any other credential group — this gate applies only to `blockchain`
- `set_credential` generic command — untouched, blockchain writes must go through the new `set_blockchain_credential` command only
- The `blockchain` keyring entry format — still `{"rpcUrl": "…", "deployerPrivateKey": "…"}`

---

## Tests to add

**Rust:**
- `set_blockchain_credential` on OS Keychain: first write sets auth hash and succeeds
- `set_blockchain_credential` on OS Keychain: subsequent write with correct password succeeds
- `set_blockchain_credential` on OS Keychain: subsequent write with wrong password returns error
- `set_blockchain_credential` on App Vault: confirmation_password is ignored, existing behavior unchanged
- `change_blockchain_write_auth`: correct current password updates hash
- `change_blockchain_write_auth`: wrong current password returns error, hash unchanged
- `has_blockchain_write_auth`: returns false before first write, true after

**Frontend:**
- `BlockchainWriteAuthModal` first-time flow renders set-password form
- `BlockchainWriteAuthModal` subsequent flow renders confirm form
- Wrong password shows inline error and keeps modal open
- Cancel does not call `set_blockchain_credential`
- App Vault backend: modal is never shown for blockchain saves

---

## Definition of done

- [ ] `bcrypt` crate added to Cargo.toml
- [ ] `blockchain_write_auth.hash` file written on first blockchain credential save under OS Keychain
- [ ] `set_blockchain_credential` command implemented with correct gate logic for both backends
- [ ] `has_blockchain_write_auth` command implemented
- [ ] `change_blockchain_write_auth` command implemented
- [ ] `BlockchainWriteAuthModal` component implemented, both flows
- [ ] "Change write authorization password" link in Screen 7 for OS Keychain backend
- [ ] Generic `set_credential` command blocked from accepting `blockchain` key — returns Err("Use set_blockchain_credential for the blockchain group")
- [ ] All Rust tests passing
- [ ] All frontend tests passing
- [ ] tsc --noEmit clean
- [ ] Production build succeeds
