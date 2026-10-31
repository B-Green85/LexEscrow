// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Credential storage — the backend toggle at the top of Configuration.
 *
 * Shows which store holds this install's credentials and offers to move them to
 * the other one. Migration is a copy, not a move: the source keeps its version,
 * so an operator who migrates into a keychain that later proves unreachable can
 * switch back and still have their DocuSign PEM and deployer key. Neither of
 * those can be reconstructed from anything the app knows, which is what makes
 * the destructive version of this feature the wrong one.
 *
 * The Linux libsecret path is the same wall the first-launch selector hits, and
 * shows the same install command through the same component — an operator who
 * has read that instruction once should not meet a differently-worded second
 * version of it here.
 */

import { useEffect, useState } from "react";
import * as backend from "../lib/backend";
import { useSession } from "../store/session";
import {
  BACKEND_LABEL,
  CREDENTIAL_LABEL,
  type MigrateResult,
  type StoreBackend,
  type StoreBackendError,
} from "../lib/vaultTypes";
import { InstallCommand } from "./CredentialStoreSelector";

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`}
      aria-hidden="true"
    />
  );
}

export function CredentialStorageCard() {
  const storeBackend = useSession((s) => s.storeBackend);
  const setStoreBackendLocal = useSession((s) => s.setStoreBackendLocal);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MigrateResult | null>(null);
  const [error, setError] = useState<StoreBackendError | null>(null);
  const [keychainAvailable, setKeychainAvailable] = useState<boolean | null>(null);

  const other: StoreBackend = storeBackend === "os_keychain" ? "app_vault" : "os_keychain";

  // Probed up front so the button can say the keychain is unavailable before
  // the operator commits to a migration, rather than after.
  useEffect(() => {
    if (other !== "os_keychain") {
      setKeychainAvailable(null);
      return;
    }
    let cancelled = false;
    void backend.checkOsKeychain().then((s) => {
      if (!cancelled) setKeychainAvailable(s.available);
    });
    return () => {
      cancelled = true;
    };
  }, [other]);

  const migrate = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await backend.migrateCredentials(other);
      setResult(r);
      // Authoritative rather than assumed: a run with any failure deliberately
      // stays on the current backend, and the result says which one that is.
      setStoreBackendLocal(r.newBackend);
      setConfirming(false);
    } catch (e) {
      setError(
        backend.asStoreBackendError(e) ?? {
          code: "OS_ERROR",
          message: e instanceof Error ? e.message : String(e),
          installCommand: null,
        },
      );
    }
    setBusy(false);
  };

  if (!storeBackend) return null;

  const libsecretMissing = error?.code === "LIBSECRET_NOT_FOUND";
  const blocked = other === "os_keychain" && keychainAvailable === false;

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-text-primary">Credential storage</div>
          <div className="mt-1.5 flex items-center gap-2">
            <StatusDot ok />
            <span className="text-sm text-text-primary">{BACKEND_LABEL[storeBackend]}</span>
            <span className="text-xs text-text-muted">
              {storeBackend === "os_keychain"
                ? "unlocked by your login session"
                : "AES-256-GCM, password on first use"}
            </span>
          </div>
        </div>

        {!confirming && (
          <button
            className="btn btn-secondary shrink-0"
            disabled={busy || blocked}
            onClick={() => {
              setResult(null);
              setError(null);
              setConfirming(true);
            }}
          >
            Switch to {BACKEND_LABEL[other]}
          </button>
        )}
      </div>

      {blocked && (
        <p className="mt-3 text-xs text-amber-500">
          No system keyring is available on this machine, so credentials cannot be moved to the OS
          keychain.
        </p>
      )}

      {confirming && (
        <div className="mt-4 rounded-lg bg-app-bg/60 p-4">
          <p className="text-sm text-text-primary">
            Migrate your existing credentials to {BACKEND_LABEL[other]}?
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Every credential is copied to {BACKEND_LABEL[other]} and it becomes the active store.
            Your {BACKEND_LABEL[storeBackend]} copy is left in place, so you can switch back.
          </p>
          <div className="mt-3 flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={migrate}>
              {busy ? "Migrating…" : `Migrate to ${BACKEND_LABEL[other]}`}
            </button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-lg bg-app-bg/60 p-4" role="status">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Migration result
          </div>
          {result.migrated.length === 0 && result.failed.length === 0 ? (
            <p className="mt-2 text-xs text-text-muted">
              Nothing to move — no credentials were stored.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {result.migrated.map((k) => (
                <li key={k} className="flex items-center gap-2 text-xs text-text-primary">
                  <StatusDot ok />
                  <span>{CREDENTIAL_LABEL[k] ?? k}</span>
                  <span className="text-text-muted">moved</span>
                </li>
              ))}
              {result.failed.map((k) => (
                <li key={k} className="flex items-center gap-2 text-xs text-red-400">
                  <StatusDot ok={false} />
                  <span>{CREDENTIAL_LABEL[k] ?? k}</span>
                  <span className="text-text-muted">could not be moved — re-enter it below</span>
                </li>
              ))}
            </ul>
          )}
          {result.failed.length > 0 && (
            <p className="mt-2 text-xs text-amber-500">
              Still using {BACKEND_LABEL[result.newBackend]} — the switch was held back so nothing
              would be left unreachable.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg bg-red-500/10 p-4" role="alert">
          <div className="text-sm font-medium text-red-400">
            {libsecretMissing
              ? "No system keyring is available on this machine."
              : "Migration failed."}
          </div>
          {libsecretMissing ? (
            <>
              <p className="mt-1 text-xs text-text-muted">
                {error.installCommand
                  ? "Install a Secret Service provider, then try again:"
                  : "Install libsecret with your distribution's package manager, then try again."}
              </p>
              {error.installCommand && <InstallCommand command={error.installCommand} />}
            </>
          ) : (
            <p className="mt-1 text-xs text-text-muted">{error.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
