/**
 * The vault password prompt.
 *
 * Asked at the moment a credential is actually needed rather than at launch —
 * an operator who only wants to fingerprint a document never touches a
 * credential and is never asked. Under the OS-keychain backend it never appears
 * at all: the login session already unlocked the store.
 *
 * Two shapes, one form:
 *
 *  * **No `onCancel`** — a hard gate with no way past but the password. This is
 *    the shape Configuration uses to unlock before showing credential fields.
 *  * **With `onCancel`** — the lazy prompt raised by `ensureCredentials`. Here
 *    a way out is required, not optional: the operator arrived by clicking
 *    Parse or Settle, and an accidental click must not trap them behind a
 *    password. Cancelling resolves the waiting action as declined.
 *
 * There is no "skip" in either shape. A lost vault password cannot be recovered
 * or reset by construction — the password *is* the key-derivation input — so an
 * affordance suggesting otherwise would promise a way forward that does not
 * exist.
 */

import { useEffect, useRef, useState } from "react";
import { useSession } from "../store/session";
import { SecretInput } from "../screens/Configuration";
import emblem from "../assets/lexescrow-emblem.png";

export function VaultUnlockGate({ onCancel }: { onCancel?: () => void } = {}) {
  const unlockVault = useSession((s) => s.unlockVault);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);

  // The password field is the only interactive thing on screen; making the
  // operator click it first would be pure ceremony.
  useEffect(() => {
    fieldRef.current?.querySelector("input")?.focus();
  }, []);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await unlockVault(password);
      if (!result.ok) {
        // The vault distinguishes a wrong password from a corrupt file, and
        // those want different reactions from the operator — pass its wording
        // through rather than flattening both to "unlock failed".
        setError(result.message ?? "Could not unlock the vault.");
        setPassword("");
        fieldRef.current?.querySelector("input")?.focus();
      }
      // On success the gate unmounts: `vaultLocked` is what renders it.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-app-bg px-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-gate-title"
    >
      <img
        src={emblem}
        alt=""
        width={96}
        height={96}
        className="h-24 w-24 select-none"
        draggable={false}
      />

      <h1 id="vault-gate-title" className="mt-4 text-xl font-bold tracking-tight text-text-primary">
        Unlock LexEscrow
      </h1>
      <p className="mt-2 max-w-sm text-center text-sm text-text-muted">
        {onCancel
          ? "This step needs a credential from your vault. Enter its password to continue."
          : "This install has a credential vault. Enter its password to reach your AI provider, SMTP and DocuSign settings."}
      </p>

      <div className="card mt-6 w-full max-w-sm p-6">
        {/* A form, so Enter submits the way it does in every other password
            prompt the operator has ever used. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="label" htmlFor="vault-gate-password">
            Vault password
          </label>
          <div ref={fieldRef}>
            <SecretInput
              id="vault-gate-password"
              value={password}
              onChange={setPassword}
              placeholder="Vault password"
            />
          </div>

          {error && (
            <div
              className="mt-3 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-400"
              role="alert"
            >
              {error}
            </div>
          )}

          <button className="btn btn-primary mt-4 w-full" type="submit" disabled={busy || !password}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>

          {onCancel && (
            <button
              className="btn btn-secondary mt-2 w-full"
              type="button"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
        </form>
      </div>

      <p className="mt-4 max-w-sm text-center text-xs text-text-muted">
        The password derives the encryption key — LexEscrow cannot recover it or reset it for you.
      </p>
    </div>
  );
}
