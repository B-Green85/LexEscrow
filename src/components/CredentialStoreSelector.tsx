/**
 * First-launch credential backend selection.
 *
 * Shown before the app loads, gated on `getStoreBackend()` returning null. It
 * is a gate rather than a dialog for the same reason the old vault lock screen
 * was: every credential the app would reach for on the other side lives in the
 * store this screen is asking about, so there is nothing useful behind it.
 *
 * Unlike that lock screen, this one is asked exactly once per install. The
 * answer is recorded in a plain config file — not in either store, since it is
 * the question of *which store to open* — and the operator can change it later
 * from Configuration, credentials and all.
 *
 * The Linux failure path is the reason this screen has an error state at all.
 * On a distro with no Secret Service provider, "use the OS keychain" is a
 * selection the machine cannot honour, and the honest response is the command
 * that fixes it plus a way to proceed without it.
 */

import { useEffect, useState } from "react";
import * as backend from "../lib/backend";
import { BACKEND_LABEL, type StoreBackend, type StoreBackendError } from "../lib/vaultTypes";
import emblem from "../assets/lexescrow-emblem.png";

/**
 * Which platform's credential store the OS option would use.
 *
 * `navigator.userAgent` rather than a Tauri plugin: this is display copy, and
 * naming the wrong store is a cosmetic error, whereas adding a native
 * dependency to render one line of text is not a trade worth making. The
 * *behaviour* never depends on this — the backend probes the real keyring.
 */
function osKeychainName(): string {
  if (typeof navigator === "undefined") return "your system keychain";
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return "macOS Keychain";
  if (/Win/.test(ua)) return "Windows Credential Manager";
  if (/Linux|X11/.test(ua)) return "Secret Service (libsecret)";
  return "your system keychain";
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M13 2a5 5 0 00-4.9 6L2 14.1V18h3.9l.9-.9V15h2v-1.8l.9-.9A5 5 0 1013 2zm1.5 4.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M5 9V6a5 5 0 1110 0v3h.5A1.5 1.5 0 0117 10.5v6A1.5 1.5 0 0115.5 18h-11A1.5 1.5 0 013 16.5v-6A1.5 1.5 0 014.5 9H5zm2-3a3 3 0 116 0v3H7V6z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * The install command, copyable.
 *
 * A separate component because it appears in two places — here and in
 * Configuration — and an operator who has hit this wall once should not meet a
 * second, differently-worded version of the same instruction.
 */
export function InstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A denied clipboard permission is not worth an error state: the command
      // is on screen and selectable, which is the fallback anyway.
      setCopied(false);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2">
      <code
        className="flex-1 overflow-x-auto rounded-md bg-black/40 px-3 py-2 font-mono text-xs
          text-text-primary"
        data-testid="install-command"
      >
        {command}
      </code>
      <button className="btn btn-secondary shrink-0 text-xs" onClick={copy} type="button">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function OptionCard({
  icon,
  title,
  recommended,
  points,
  selected,
  onSelect,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  recommended?: boolean;
  points: string[];
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`card flex-1 p-5 text-left transition disabled:opacity-50 ${
        selected ? "ring-2 ring-emerald-500" : "hover:border-text-muted"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-text-muted">{icon}</span>
        <span className="text-base font-semibold text-text-primary">{title}</span>
        {recommended && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold
            uppercase tracking-wide text-emerald-500">
            Recommended
          </span>
        )}
      </div>
      <ul className="mt-3 space-y-1.5">
        {points.map((p) => (
          <li key={p} className="flex gap-2 text-xs text-text-muted">
            <span aria-hidden="true">·</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

export function CredentialStoreSelector({
  onSelected,
}: {
  onSelected: (backend: StoreBackend) => void;
}) {
  const [choice, setChoice] = useState<StoreBackend>("os_keychain");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StoreBackendError | null>(null);
  const [keychainName, setKeychainName] = useState("your system keychain");

  useEffect(() => {
    setKeychainName(osKeychainName());
  }, []);

  const select = async (backendChoice: StoreBackend) => {
    setBusy(true);
    setError(null);
    try {
      await backend.setStoreBackend(backendChoice);
      onSelected(backendChoice);
    } catch (e) {
      // The error state stays on this screen rather than advancing — the app
      // behind it has no credential store to reach.
      const structured = backend.asStoreBackendError(e);
      setError(
        structured ?? {
          code: "OS_ERROR",
          message: e instanceof Error ? e.message : String(e),
          installCommand: null,
        },
      );
      setBusy(false);
    }
  };

  const libsecretMissing = error?.code === "LIBSECRET_NOT_FOUND";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-y-auto
        bg-app-bg px-6 py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="store-selector-title"
    >
      <img src={emblem} alt="" width={72} height={72} className="h-18 w-18 select-none" draggable={false} />

      <h1
        id="store-selector-title"
        className="mt-4 text-xl font-bold tracking-tight text-text-primary"
      >
        Where should LexEscrow keep your credentials?
      </h1>
      <p className="mt-2 max-w-lg text-center text-sm text-text-muted">
        Your AI provider key, SMTP and Twilio credentials, DocuSign signing key and settlement key
        are stored here. Secrets never leave the backend either way — this is about who holds the
        encryption key.
      </p>

      <div className="mt-6 flex w-full max-w-2xl flex-col gap-3 sm:flex-row">
        <OptionCard
          icon={<KeyIcon />}
          title={BACKEND_LABEL.os_keychain}
          recommended
          points={[
            `Uses ${keychainName}`,
            "Unlocked by your login session",
            "No vault password required",
          ]}
          selected={choice === "os_keychain"}
          onSelect={() => {
            setChoice("os_keychain");
            setError(null);
          }}
          disabled={busy}
        />
        <OptionCard
          icon={<LockIcon />}
          title={BACKEND_LABEL.app_vault}
          points={[
            "AES-256-GCM encrypted file",
            "Master password required to read credentials",
            "Works on all systems without dependencies",
          ]}
          selected={choice === "app_vault"}
          onSelect={() => {
            setChoice("app_vault");
            setError(null);
          }}
          disabled={busy}
        />
      </div>

      {error && (
        <div className="mt-4 w-full max-w-2xl rounded-lg bg-red-500/10 p-4" role="alert">
          <div className="text-sm font-medium text-red-400">
            {libsecretMissing
              ? "No system keyring is available on this machine."
              : "Could not open that credential store."}
          </div>
          {libsecretMissing ? (
            <>
              <p className="mt-1 text-xs text-text-muted">
                LexEscrow needs a Secret Service provider to use the OS keychain on Linux.
                {error.installCommand
                  ? " Install one, then try again:"
                  : " Install libsecret with your distribution's package manager, then try again."}
              </p>
              {error.installCommand && <InstallCommand command={error.installCommand} />}
              <button
                type="button"
                className="mt-3 text-xs font-medium text-emerald-500 underline"
                onClick={() => {
                  setChoice("app_vault");
                  setError(null);
                  void select("app_vault");
                }}
              >
                Switch to {BACKEND_LABEL.app_vault}
              </button>
            </>
          ) : (
            <p className="mt-1 text-xs text-text-muted">{error.message}</p>
          )}
        </div>
      )}

      <button
        className="btn btn-primary mt-6 w-full max-w-2xl"
        disabled={busy}
        onClick={() => void select(choice)}
        type="button"
      >
        {busy ? "Setting up…" : `Use ${BACKEND_LABEL[choice]}`}
      </button>

      <p className="mt-4 max-w-lg text-center text-xs text-text-muted">
        You can switch later in Configuration, and your credentials come with you.
      </p>
    </div>
  );
}
