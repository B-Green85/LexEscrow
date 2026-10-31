// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * The LexTrace password gate.
 *
 * Asked once per app session, on the first open of the debug panel. Not on
 * every cycle — the operator is repositioning a window at that point, not
 * re-authorising — and not at launch, since an officer who never opens the
 * console should never be asked about it.
 *
 * Distinct from `VaultUnlockGate`, which it may appear immediately after, and
 * the difference is worth keeping visible to the operator: the vault password
 * decrypts credentials, while this one authorises watching a machine. They are
 * different questions with different answers, so they get different prompts
 * rather than one prompt that means whichever thing happens to be pending.
 *
 * Overlays rather than replaces the app: the operator was in the middle of
 * something, clicked an icon, and must be able to change their mind.
 */

import { useEffect, useRef, useState } from "react";
import { useSession } from "../store/session";
import { SecretInput } from "../screens/Configuration";

export function DebugPasswordPrompt() {
  const submitDebugPassword = useSession((s) => s.submitDebugPassword);
  const cancelDebugPrompt = useSession((s) => s.cancelDebugPrompt);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fieldRef.current?.querySelector("input")?.focus();
  }, []);

  // Escape closes it. The prompt appeared in response to a single click and
  // must not feel like something the operator is now stuck inside.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelDebugPrompt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelDebugPrompt]);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await submitDebugPassword(password);
      if (!ok) {
        // One message for every failure. The backend deliberately answers this
        // in a single bit, so inventing a distinction here — "wrong password"
        // versus "vault unreadable" — would be the UI guessing.
        setError("Incorrect debug console password.");
        setPassword("");
        fieldRef.current?.querySelector("input")?.focus();
      }
      // On success the prompt unmounts: `debugPromptOpen` is what renders it.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="debug-gate-title"
    >
      <div className="card w-full max-w-sm p-6">
        <h2 id="debug-gate-title" className="text-base font-semibold text-text-primary">
          LexTrace Debug Console
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          Debug access is privileged. Enter the IT operator password to open the console.
        </p>

        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="label" htmlFor="debug-gate-password">
            Debug console password
          </label>
          <div ref={fieldRef}>
            <SecretInput
              id="debug-gate-password"
              value={password}
              onChange={setPassword}
              placeholder="Debug console password"
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
            {busy ? "Checking…" : "Open console"}
          </button>
          <button
            className="btn btn-secondary mt-2 w-full"
            type="button"
            disabled={busy}
            onClick={cancelDebugPrompt}
          >
            Cancel
          </button>
        </form>

        <p className="mt-4 text-center text-[11px] text-text-muted">
          The console is read-only. Every line it shows is recorded in the debug audit trail.
        </p>
      </div>
    </div>
  );
}
