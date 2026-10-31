// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

// @vitest-environment jsdom
/**
 * The vault password prompt — an install that has been set up, started with its
 * vault sealed.
 *
 * Three things are under test and they are not the same thing:
 *
 *   1. `checkWizard` reads the vault's real status, not a flag.
 *   2. The prompt takes a password and clears, and does not clear on a wrong
 *      one.
 *   3. A sealed vault no longer gates *launch*. The app opens straight into the
 *      workflow; the password is asked for at the moment a credential is
 *      actually needed. An operator who only fingerprints a document never
 *      touches a credential and is never asked — which is the whole point of
 *      moving the prompt off the launch path.
 *
 * Run against the real browser vault rather than a mocked `vaultStatus`: a mock
 * would return whatever shape this file expected and prove nothing about the
 * condition the prompt actually keys on. The first-run half of the decision —
 * *no* vault, so nothing to unlock — cannot be asserted here, because this file
 * has to create a vault to have one to lock. It lives in
 * `setup-wizard-first-run.test.tsx`, the one file that never creates one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VaultUnlockGate } from "./VaultUnlockGate";
import App from "../App";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import * as browserVault from "../lib/browserVault";

// The 2.5s launch animation is not what any of this is about, and waiting it
// out would put every App case over the default timeout. Fake timers are not
// the alternative: RTL's `waitFor` polls on real timers and does not drive
// vitest's fake ones, so the two together deadlock.
vi.mock("./Splash", async () => {
  const { useEffect } = await import("react");
  return {
    Splash: ({ onFinish }: { onFinish: () => void }) => {
      useEffect(() => onFinish(), [onFinish]);
      return null;
    },
  };
});

const PASSWORD = "correct-horse-battery-staple";

/** Create the vault (first unlock creates it), then seal it again. */
async function sealedVault() {
  await backend.vaultUnlock(PASSWORD);
  await backend.vaultLock();
}

beforeEach(() => {
  // No storage reset: this jsdom lacks `localStorage.clear`, so the browser
  // vault takes its in-memory fallback. Vitest's per-file module registry is
  // the reset — the cell starts empty in this file and persists across its
  // tests, which is exactly what "an install that has been set up" needs.
  useSession.setState({
    vaultLocked: false,
    showWizard: false,
    wizardComplete: false,
    credentialPromptOpen: false,
    // A backend is already chosen, so the first-launch selector stays down and
    // these cases exercise the vault path rather than the selection flow.
    storeBackend: "app_vault",
    storeBackendChecked: true,
  });
});

afterEach(() => {
  cleanup();
  browserVault.lock();
  vi.restoreAllMocks();
});

// ── The decision ─────────────────────────────────────────────────────────────

describe("checkWizard — an install that has been set up", () => {
  it("raises the gate for a vault that exists but is sealed", async () => {
    await sealedVault();

    await useSession.getState().checkWizard();

    expect(useSession.getState().vaultLocked).toBe(true);
    // And emphatically not onboarding: these credentials already exist.
    expect(useSession.getState().showWizard).toBe(false);
    expect(useSession.getState().wizardComplete).toBe(true);
  });

  it("leaves the gate down when the vault is already open", async () => {
    await backend.vaultUnlock(PASSWORD);

    await useSession.getState().checkWizard();

    expect(useSession.getState().vaultLocked).toBe(false);
  });

  it("fails open when the vault status cannot be read", async () => {
    // An unreadable status is not evidence of a configured install, and
    // trapping the operator behind a password for a vault we cannot confirm
    // exists would have no way out.
    vi.spyOn(backend, "vaultStatus").mockRejectedValue(new Error("io error"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await useSession.getState().checkWizard();

    expect(useSession.getState().vaultLocked).toBe(false);
  });
});

// ── The gate itself ──────────────────────────────────────────────────────────

describe("VaultUnlockGate", () => {
  beforeEach(async () => {
    await sealedVault();
    useSession.setState({ vaultLocked: true });
  });

  it("unlocks on the right password and lifts the gate", async () => {
    render(<VaultUnlockGate />);

    fireEvent.change(screen.getByLabelText(/Vault password/i), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(useSession.getState().vaultLocked).toBe(false));
    expect((await backend.vaultStatus()).unlocked).toBe(true);
  });

  it("holds the gate up on a wrong password, and says why", async () => {
    render(<VaultUnlockGate />);

    fireEvent.change(screen.getByLabelText(/Vault password/i), {
      target: { value: "not-the-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    // The vault's own wording, which distinguishes a wrong password from a
    // corrupt file — the two want different reactions from the operator.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/incorrect password/i);
    expect(useSession.getState().vaultLocked).toBe(true);
    expect((await backend.vaultStatus()).unlocked).toBe(false);
  });

  it("submits on Enter, the way every other password prompt does", async () => {
    const { container } = render(<VaultUnlockGate />);

    fireEvent.change(screen.getByLabelText(/Vault password/i), {
      target: { value: PASSWORD },
    });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(useSession.getState().vaultLocked).toBe(false));
  });

  it("offers no way past it but the password", () => {
    render(<VaultUnlockGate />);

    // A skip or dismiss would promise a way forward that does not exist: the
    // password is the key-derivation input and cannot be recovered or reset.
    expect(screen.queryByRole("button", { name: /skip|cancel|later|dismiss|close/i })).toBeNull();

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
});

// ── What the operator can actually reach ─────────────────────────────────────

describe("App at launch, vault sealed", () => {
  /** Mount and let the (stubbed) splash finish. */
  async function launch() {
    await act(async () => {
      render(<App />);
    });
  }

  it("opens into the app rather than a lock screen", async () => {
    await sealedVault();
    await launch();

    // The password moved off the launch path. A sealed vault is no longer a
    // reason to withhold the whole application: the operator may only want to
    // fingerprint a document, which needs no credential at all.
    await waitFor(() => expect(screen.getByLabelText("Configuration")).toBeTruthy());
    expect(screen.queryByText("Unlock LexEscrow")).toBeNull();
    expect(screen.getByLabelText("Batch Processing")).toBeTruthy();
  });

  it("asks for the password at the moment a credential is needed", async () => {
    await sealedVault();
    await launch();
    await waitFor(() => expect(screen.getByLabelText("Configuration")).toBeTruthy());

    // Nothing has needed a credential yet, so nothing has been asked.
    expect(screen.queryByText("Unlock LexEscrow")).toBeNull();

    // `ensureCredentials` is the seam every credential-consuming action goes
    // through. Awaiting it is what an action does; the prompt appears in
    // response to that, not to launching.
    let granted: boolean | undefined;
    void useSession
      .getState()
      .ensureCredentials()
      .then((ok) => {
        granted = ok;
      });

    await waitFor(() => expect(screen.getByText("Unlock LexEscrow")).toBeTruthy());
    // The app is still there behind it — this overlays, it does not replace.
    expect(screen.getByLabelText("Configuration")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Vault password/i), {
      target: { value: PASSWORD },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    });

    await waitFor(() => expect(screen.queryByText("Unlock LexEscrow")).toBeNull());
    // The waiting action is released, and released as granted.
    await waitFor(() => expect(granted).toBe(true));
  });

  it("lets the operator back out of a prompt they did not mean to raise", async () => {
    await sealedVault();
    await launch();
    await waitFor(() => expect(screen.getByLabelText("Configuration")).toBeTruthy());

    let granted: boolean | undefined;
    void useSession
      .getState()
      .ensureCredentials()
      .then((ok) => {
        granted = ok;
      });
    await waitFor(() => expect(screen.getByText("Unlock LexEscrow")).toBeTruthy());

    // A misclick on Parse must not trap an operator behind a password. The
    // waiting action is told it was declined rather than left hanging.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    await waitFor(() => expect(screen.queryByText("Unlock LexEscrow")).toBeNull());
    await waitFor(() => expect(granted).toBe(false));
    expect(screen.getByLabelText("Configuration")).toBeTruthy();
  });
});
