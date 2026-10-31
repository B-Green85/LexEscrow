// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Write-authorization prompt for the deployer private key (OS Keychain only).
 *
 * The App Vault backend already asks for the vault password before this write,
 * because writing the deployer key means re-deriving the encryption key from a
 * password only the operator knows. The OS keychain has no such password — the
 * login session opened the store — so this modal supplies the deliberate pause
 * that would otherwise be missing on the one write that moves money.
 *
 * Two shapes, decided by whether a password has been enrolled:
 *
 *  * **Enrolment** — first blockchain save on this install. The password is
 *    typed twice, because there is nothing to check a typo against: whatever is
 *    entered *becomes* the authorization password, and a mistyped one would be
 *    a password nobody knows.
 *  * **Confirmation** — every save after that. One field, checked against the
 *    stored hash.
 *
 * Worth being plain about what this is: an intent confirmation, not a security
 * boundary. It stops an unattended, unlocked LexEscrow window from being a
 * two-click path to swapping the deployer key. It does not stop someone with a
 * shell as this user, who can delete the hash file and re-enrol, or write the
 * keychain entry directly without involving this app at all.
 */

import { useEffect, useRef, useState } from "react";
import { SecretInput } from "../screens/Configuration";

export function BlockchainWriteAuthModal({
  enrolled,
  busy,
  onConfirm,
  onCancel,
}: {
  /** Does an authorization password already exist? Chooses the two shapes. */
  enrolled: boolean;
  /** True while the caller's write is in flight. */
  busy?: boolean;
  /**
   * Submit. Resolves to an error message to display inline, or null on
   * success — the caller owns the write, so it is the only thing that knows
   * whether the password was accepted.
   */
  onConfirm: (password: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fieldRef.current?.querySelector("input")?.focus();
  }, []);

  // Enrolment needs both fields to agree; confirmation has nothing to compare.
  const mismatch = !enrolled && confirm.length > 0 && password !== confirm;
  const ready = password.length > 0 && (enrolled || (confirm.length > 0 && !mismatch));
  const working = submitting || busy;

  const submit = async () => {
    if (!ready || working) return;
    setSubmitting(true);
    setError(null);
    const message = await onConfirm(password);
    if (message) {
      // Wrong password keeps the modal open and clears the field — the
      // operator is retrying one value, not re-entering the whole form.
      setError(message);
      setPassword("");
      setConfirm("");
      fieldRef.current?.querySelector("input")?.focus();
    }
    setSubmitting(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chain-auth-title"
    >
      <div className="card w-full max-w-md p-6">
        <h2 id="chain-auth-title" className="text-base font-semibold text-text-primary">
          {enrolled ? "Confirm deployer key change" : "Set a write authorization password"}
        </h2>
        <p className="mt-1.5 text-sm text-text-muted">
          {enrolled
            ? "Enter your write authorization password to save the new deployer private key."
            : "The deployer private key controls on-chain fund movements. Set a password that will be required every time this key is changed."}
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="mt-4">
            <label className="label" htmlFor="chain-auth-password">
              {enrolled ? "Write authorization password" : "Password"}
            </label>
            <div ref={fieldRef}>
              <SecretInput
                id="chain-auth-password"
                value={password}
                onChange={setPassword}
                placeholder="Write authorization password"
              />
            </div>
          </div>

          {!enrolled && (
            <div className="mt-3">
              <label className="label" htmlFor="chain-auth-confirm">
                Confirm password
              </label>
              <SecretInput
                id="chain-auth-confirm"
                value={confirm}
                onChange={setConfirm}
                placeholder="Confirm password"
              />
              {mismatch && (
                <p className="mt-1 text-[11px] text-amber-500">Passwords do not match.</p>
              )}
            </div>
          )}

          {error && (
            <div
              className="mt-3 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-400"
              role="alert"
            >
              {error}
            </div>
          )}

          {!enrolled && (
            <p className="mt-3 text-[11px] text-text-muted">
              This password is not stored and cannot be recovered — it is hashed, and only the hash
              is kept. It is separate from any vault password.
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <button className="btn btn-primary flex-1" type="submit" disabled={!ready || working}>
              {working ? "Saving…" : enrolled ? "Confirm" : "Set password and save"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={working}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Change the write authorization password.
 *
 * Separate from the modal above because it is a different operation with a
 * different failure: that one gates a credential write, this one only rotates
 * the gate. Requires the current password, so an unattended machine cannot be
 * used to quietly replace the thing standing in the way of the deployer key.
 */
export function ChangeBlockchainWriteAuthModal({
  onSubmit,
  onCancel,
}: {
  onSubmit: (current: string, next: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length > 0 && confirm.length > 0 && !mismatch;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const message = await onSubmit(current, next);
    if (message) {
      setError(message);
      setCurrent("");
    }
    setBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chain-auth-change-title"
    >
      <div className="card w-full max-w-md p-6">
        <h2 id="chain-auth-change-title" className="text-base font-semibold text-text-primary">
          Change write authorization password
        </h2>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="mt-4">
            <label className="label" htmlFor="chain-auth-current">
              Current password
            </label>
            <SecretInput id="chain-auth-current" value={current} onChange={setCurrent} />
          </div>
          <div className="mt-3">
            <label className="label" htmlFor="chain-auth-new">
              New password
            </label>
            <SecretInput id="chain-auth-new" value={next} onChange={setNext} />
          </div>
          <div className="mt-3">
            <label className="label" htmlFor="chain-auth-new-confirm">
              Confirm new password
            </label>
            <SecretInput id="chain-auth-new-confirm" value={confirm} onChange={setConfirm} />
            {mismatch && <p className="mt-1 text-[11px] text-amber-500">Passwords do not match.</p>}
          </div>

          {error && (
            <div
              className="mt-3 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-400"
              role="alert"
            >
              {error}
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button className="btn btn-primary flex-1" type="submit" disabled={!ready || busy}>
              {busy ? "Changing…" : "Change"}
            </button>
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
