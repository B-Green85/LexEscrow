// @vitest-environment jsdom
/**
 * Launch lock gate — an install that has been set up, started with its vault
 * sealed.
 *
 * Three things are under test and they are not the same thing:
 *
 *   1. `checkWizard` reads the gate off the vault's real status, not a flag.
 *   2. The gate takes a password and lifts, and does not lift on a wrong one.
 *   3. The main UI is *absent* while gated, not merely covered — the point of
 *      the feature. An overlay with the app still mounted behind it would keep
 *      firing screen effects and stay reachable by keyboard, which is a lock
 *      screen in appearance only.
 *
 * Run against the real browser vault rather than a mocked `vaultStatus`: a mock
 * would return whatever shape this file expected and prove nothing about the
 * condition the gate actually keys on. The first-run half of the decision —
 * *no* vault, so no gate — cannot be asserted here, because this file has to
 * create a vault to have one to lock. It lives in
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
  useSession.setState({ vaultLocked: false, showWizard: false, wizardComplete: false });
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

  it("shows the lock screen instead of the app, not on top of it", async () => {
    await sealedVault();
    await launch();

    await waitFor(() => expect(screen.getByText("Unlock LexEscrow")).toBeTruthy());

    // The main UI is not rendered at all — no header, no workflow chrome. A
    // covered-but-mounted app would still answer these.
    expect(screen.queryByLabelText("Configuration")).toBeNull();
    expect(screen.queryByLabelText("Batch Processing")).toBeNull();
    expect(screen.queryByText(/AI parses\. LexGuard validates\./)).toBeNull();
  });

  it("reveals the app once the vault is open", async () => {
    await sealedVault();
    await launch();
    await waitFor(() => expect(screen.getByText("Unlock LexEscrow")).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/Vault password/i), {
      target: { value: PASSWORD },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    });

    await waitFor(() => expect(screen.queryByText("Unlock LexEscrow")).toBeNull());
    expect(screen.getByLabelText("Configuration")).toBeTruthy();
  });
});
