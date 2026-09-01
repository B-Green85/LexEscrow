// @vitest-environment jsdom
/**
 * First-run onboarding wizard (spec §12 Screen 0).
 *
 * Driven through the real component and the real browser vault rather than a
 * mocked backend, the same way `blockchain-config.test.tsx` is. Two of the
 * claims under test are only meaningful against the genuine article:
 *
 *   1. Step 2 actually creates a vault — after which `checkWizard` must stop
 *      showing the wizard. A mocked `vaultUnlock` would prove the button is
 *      wired to *something*, not that first-run detection ever flips.
 *   2. The gate on the Create Vault button. It is the one control here that
 *      cannot be re-tried later: a weak or mistyped password becomes an
 *      unrecoverable vault, so "disabled until it is safe" is a correctness
 *      property, not a nicety.
 *
 * `passwordStrength` is exercised directly as well as through the bar, because
 * the thresholds are policy and a test that only reads the rendered colour
 * would not notice them moving.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SetupWizard, StepProgress, passwordStrength, TOTAL_STEPS } from "./SetupWizard";
import { Configuration } from "./Configuration";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import * as browserVault from "../lib/browserVault";

/** A password that clears the Fair bar without reaching Strong on length. */
const FAIR_PASSWORD = "abcdefgh";
const STRONG_PASSWORD = "correct-horse-battery";

beforeEach(() => {
  browserVault.lock();
  useSession.setState({ showWizard: false, wizardComplete: false });
});

afterEach(() => {
  cleanup();
  browserVault.lock();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const button = (name: RegExp | string) => screen.getByRole("button", { name });
const isDisabled = (name: RegExp | string) => (button(name) as HTMLButtonElement).disabled;

/** Type a matching password pair into step 2. */
function fillPasswords(password: string, confirmWith = password) {
  fireEvent.change(screen.getByLabelText(/^Vault password$/), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/^Confirm password$/), { target: { value: confirmWith } });
}

/**
 * Walk from step 1 through vault creation, landing on step 3.
 *
 * Settled by waiting for step 3 to appear rather than by `act`: key derivation
 * is real PBKDF2, which resolves off the microtask queue, so an `act` flush can
 * return with the button still reading "Creating…".
 */
async function createVault() {
  fireEvent.click(button(/Get Started/));
  fillPasswords(STRONG_PASSWORD);
  fireEvent.click(button(/Create Vault/));
  await screen.findByText(/Configure AI Provider/);
}

/** Skip every optional step from 3 onward, landing on the step 7 summary. */
function skipToSummary() {
  fireEvent.click(button(/Skip — Use Manual Entry/));
  fireEvent.click(button(/Use Demo Mode/));
  fireEvent.click(button(/^Skip →$/));
  fireEvent.click(button(/^Skip →$/));
}

// ── Mounting ─────────────────────────────────────────────────────────────────

describe("wizard visibility", () => {
  /**
   * The wizard is mounted by App behind `showWizard`, so what is asserted here
   * is the flag's effect, not a self-check inside the component.
   */
  function AppGate() {
    const showWizard = useSession((s) => s.showWizard);
    return showWizard ? <SetupWizard /> : null;
  }

  it("renders when showWizard is true", () => {
    useSession.setState({ showWizard: true });
    render(<AppGate />);
    expect(screen.getByText(/Welcome to LexEscrow/)).toBeTruthy();
  });

  it("does not render when showWizard is false", () => {
    useSession.setState({ showWizard: false });
    render(<AppGate />);
    expect(screen.queryByText(/Welcome to LexEscrow/)).toBeNull();
  });
});

// ── Step 1 ───────────────────────────────────────────────────────────────────

describe("step 1 — welcome", () => {
  it("shows the welcome content and the three feature highlights", () => {
    render(<SetupWizard />);

    expect(screen.getByText(/Welcome to LexEscrow/)).toBeTruthy();
    expect(screen.getByText(/360° AI-Governed Escrow Platform/)).toBeTruthy();
    expect(screen.getByText(/AES-256-GCM encryption/)).toBeTruthy();
    expect(screen.getByText("Sovereign")).toBeTruthy();
    expect(screen.getByText("AI-Governed")).toBeTruthy();
    expect(screen.getByText("On-Chain")).toBeTruthy();
    expect(button(/Get Started/)).toBeTruthy();
  });

  it("offers no way to skip past the vault", () => {
    render(<SetupWizard />);
    expect(screen.queryByRole("button", { name: /Skip/i })).toBeNull();
  });

  it("hides the progress bar until the steps become optional", () => {
    render(<SetupWizard />);
    expect(screen.queryByTestId("wizard-progress")).toBeNull();
  });
});

// ── Step 2 ───────────────────────────────────────────────────────────────────

describe("step 2 — vault password", () => {
  beforeEach(() => {
    render(<SetupWizard />);
    fireEvent.click(button(/Get Started/));
  });

  it("disables Create Vault when the passwords do not match", () => {
    fillPasswords(STRONG_PASSWORD, `${STRONG_PASSWORD}-typo`);
    expect(isDisabled(/Create Vault/)).toBe(true);
    expect(screen.getByText(/Passwords do not match/)).toBeTruthy();
  });

  it("disables Create Vault when the password is too weak", () => {
    // Matching, but under the eight-character floor.
    fillPasswords("short");
    expect(isDisabled(/Create Vault/)).toBe(true);
  });

  it("enables Create Vault once the pair matches and clears Weak", () => {
    fillPasswords(FAIR_PASSWORD);
    expect(isDisabled(/Create Vault/)).toBe(false);
  });

  it("moves the strength indicator through all three levels", () => {
    const bar = () => screen.getByTestId("strength-bar").getAttribute("data-strength");

    fillPasswords("short");
    expect(bar()).toBe("weak");
    expect(screen.getByTestId("strength-label").textContent).toBe("Weak");

    fillPasswords(FAIR_PASSWORD);
    expect(bar()).toBe("fair");
    expect(screen.getByTestId("strength-label").textContent).toBe("Fair");

    fillPasswords(STRONG_PASSWORD);
    expect(bar()).toBe("strong");
    expect(screen.getByTestId("strength-label").textContent).toBe("Strong");
  });

  it("warns that the password cannot be recovered", () => {
    expect(screen.getByText(/There is no recovery mechanism/)).toBeTruthy();
  });

  it("has no Back button — the vault is not optional", () => {
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });

  it("creates the vault and advances to the AI step", async () => {
    expect((await backend.vaultStatus()).exists).toBe(false);

    fillPasswords(STRONG_PASSWORD);
    fireEvent.click(button(/Create Vault/));
    await screen.findByText(/Configure AI Provider/);

    expect((await backend.vaultStatus()).exists).toBe(true);
  });
});

describe("passwordStrength", () => {
  it("calls anything under eight characters weak", () => {
    expect(passwordStrength("")).toBe("weak");
    expect(passwordStrength("Ab1!x")).toBe("weak");
    expect(passwordStrength("Ab1!xyz")).toBe("weak");
  });

  it("calls eight to eleven plain characters fair", () => {
    expect(passwordStrength("abcdefgh")).toBe("fair");
    expect(passwordStrength("abcdefghijk")).toBe("fair");
  });

  it("promotes a short password that mixes all four character classes", () => {
    expect(passwordStrength("Ab1!defg")).toBe("strong");
  });

  it("promotes any password of twelve characters or more on length alone", () => {
    expect(passwordStrength("abcdefghijkl")).toBe("strong");
  });
});

// ── Steps 3–6: skipping ──────────────────────────────────────────────────────

describe("skipping optional steps", () => {
  beforeEach(async () => {
    render(<SetupWizard />);
    await createVault();
  });

  it("skips the AI provider and records it as skipped", () => {
    fireEvent.click(button(/Skip — Use Manual Entry/));

    // On to blockchain...
    expect(screen.getByText(/Configure Blockchain Settlement/)).toBeTruthy();

    // ...and the summary reports 'ai' as skipped, in Manual Entry terms.
    fireEvent.click(button(/Use Demo Mode/));
    fireEvent.click(button(/^Skip →$/));
    fireEvent.click(button(/^Skip →$/));
    expect(screen.getByTestId("summary-ai").textContent).toContain("⚠️");
    expect(screen.getByTestId("summary-ai").textContent).toContain("Manual Entry mode");
  });

  it("skips blockchain into demo mode and records it as skipped", () => {
    fireEvent.click(button(/Skip — Use Manual Entry/));
    fireEvent.click(button(/Use Demo Mode/));

    expect(screen.getByText(/Configure DocuSign eSign/)).toBeTruthy();

    fireEvent.click(button(/^Skip →$/));
    fireEvent.click(button(/^Skip →$/));
    expect(screen.getByTestId("summary-blockchain").textContent).toContain("⚠️ Demo Mode");
  });

  it("explains the cost of each skip rather than just offering it", () => {
    expect(screen.getByText(/you can still use Manual Entry mode/i)).toBeTruthy();
    fireEvent.click(button(/Skip — Use Manual Entry/));
    expect(screen.getByText(/settlements use mock transactions/i)).toBeTruthy();
    fireEvent.click(button(/Use Demo Mode/));
    expect(screen.getByText(/confirmed manually without DocuSign/i)).toBeTruthy();
    fireEvent.click(button(/^Skip →$/));
    expect(screen.getByText(/notifications will be disabled/i)).toBeTruthy();
  });

  it("keeps the deployer private key out of the Sepolia defaults", () => {
    fireEvent.click(button(/Skip — Use Manual Entry/));
    fireEvent.click(button(/Use Sepolia Defaults/));

    const value = (label: RegExp) =>
      (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;

    expect(value(/^Contract address$/)).toBe("0x6f532f0eefc61a5792ad211850a8b48fbc388674");
    expect(value(/^Chain ID$/)).toBe("11155111");
    // The one field a default must never fill.
    expect(value(/^Deployer private key$/)).toBe("");
  });
});

// ── Step 4 under the OS keychain — write authorization gate ──────────────────
//
// On this backend there is no vault password to carry from step 2, so the
// blockchain save must open the same write-auth modal Configuration uses —
// without it, the gated backend command would refuse the write with no way
// for the operator to answer it.

describe("step 4 — blockchain under the OS keychain", () => {
  beforeEach(() => {
    useSession.setState({ storeBackend: "os_keychain", storeBackendChecked: true });
    vi.spyOn(backend, "setBlockchain").mockResolvedValue(undefined);
    vi.spyOn(backend, "hasBlockchainWriteAuth").mockResolvedValue(false);
  });

  afterEach(() => {
    useSession.setState({ storeBackend: null, storeBackendChecked: false });
    vi.restoreAllMocks();
  });

  /** Walk to step 4 — no vault password on this backend, AI skipped. */
  function openBlockchainStep() {
    fireEvent.click(button(/Get Started/));
    fireEvent.click(button(/Continue →/)); // keychain step 2 has nothing to type
    fireEvent.click(button(/Skip — Use Manual Entry/));
    const contract = document.getElementById("wz-bc-contract") as HTMLInputElement;
    fireEvent.change(contract, { target: { value: "0xcontract" } });
  }

  it("gates the save behind the write authorization modal", async () => {
    render(<SetupWizard />);
    openBlockchainStep();

    fireEvent.click(button(/Save & Continue/));

    // First save on this install: the modal asks to *set* a password...
    expect(await screen.findByText(/Set a write authorization password/)).toBeTruthy();
    // ...and nothing is written until it is satisfied.
    expect(backend.setBlockchain).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: "auth-pw" } });
    fireEvent.change(screen.getByLabelText(/^Confirm password$/), { target: { value: "auth-pw" } });
    fireEvent.click(button(/Set password and save/));

    // The write carries the modal's password — there is no vault password on
    // this backend — and the wizard advances.
    await screen.findByText(/Configure DocuSign eSign/);
    expect(vi.mocked(backend.setBlockchain).mock.calls[0][0]).toBe("auth-pw");
  });

  it("asks to confirm rather than to set once a password is enrolled", async () => {
    vi.mocked(backend.hasBlockchainWriteAuth).mockResolvedValue(true);
    render(<SetupWizard />);
    openBlockchainStep();
    fireEvent.click(button(/Save & Continue/));

    expect(await screen.findByText(/Confirm deployer key change/)).toBeTruthy();
  });

  it("cancelling the modal writes nothing and keeps the step open", async () => {
    render(<SetupWizard />);
    openBlockchainStep();
    fireEvent.click(button(/Save & Continue/));
    await screen.findByText(/Set a write authorization password/);

    // The wizard shell is itself a dialog, so scope to the modal by its
    // accessible name before reaching for its Cancel.
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: /Set a write authorization password/ }),
      ).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() =>
      expect(screen.queryByText(/Set a write authorization password/)).toBeNull(),
    );
    expect(backend.setBlockchain).not.toHaveBeenCalled();
    expect(screen.getByText(/Configure Blockchain Settlement/)).toBeTruthy();
  });
});

// ── Navigation ───────────────────────────────────────────────────────────────

describe("back navigation", () => {
  beforeEach(async () => {
    render(<SetupWizard />);
    await createVault();
  });

  it("steps backward from the AI step to a vault step that is already done", () => {
    fireEvent.click(button(/← Back/));

    // Reviewable, but not re-enterable — the form is gone, the outcome is
    // shown. Wording depends on whether this run created the vault or opened
    // an existing one; what must hold either way is that step 2 is settled.
    expect(screen.getByText(/✅ Vault (created|unlocked)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create Vault|Unlock Vault/ })).toBeNull();
    expect(screen.queryByTestId("strength-bar")).toBeNull();

    fireEvent.click(button(/Continue →/));
    expect(screen.getByText(/Configure AI Provider/)).toBeTruthy();
  });

  it("walks back down through the optional steps", () => {
    fireEvent.click(button(/Skip — Use Manual Entry/));
    fireEvent.click(button(/Use Demo Mode/));
    expect(screen.getByText(/Configure DocuSign eSign/)).toBeTruthy();

    fireEvent.click(button(/← Back/));
    expect(screen.getByText(/Configure Blockchain Settlement/)).toBeTruthy();
    fireEvent.click(button(/← Back/));
    expect(screen.getByText(/Configure AI Provider/)).toBeTruthy();
  });
});

// ── Progress indicator ───────────────────────────────────────────────────────

describe("step progress", () => {
  const dotState = (n: number) => screen.getByTestId(`wizard-dot-${n}`).getAttribute("data-state");

  it("marks completed, current and future steps distinctly", () => {
    render(<StepProgress step={4} />);

    expect(dotState(3)).toBe("done");
    expect(dotState(4)).toBe("current");
    expect(dotState(5)).toBe("future");
    expect(screen.getByText(`Step 4 of ${TOTAL_STEPS}`)).toBeTruthy();
  });

  it("reads Complete on the final step rather than counting to it", () => {
    render(<StepProgress step={7} />);
    expect(screen.getByText(/Complete ✅/)).toBeTruthy();
    expect(screen.queryByText(/Step 7 of/)).toBeNull();
  });

  it("advances with the wizard", async () => {
    render(<SetupWizard />);
    await createVault();

    expect(screen.getByText(`Step 3 of ${TOTAL_STEPS}`)).toBeTruthy();
    fireEvent.click(button(/Skip — Use Manual Entry/));
    expect(screen.getByText(`Step 4 of ${TOTAL_STEPS}`)).toBeTruthy();
    expect(dotState(3)).toBe("done");
  });
});

// ── Step 7 summary ───────────────────────────────────────────────────────────

describe("step 7 — summary", () => {
  it("shows ✅ for a step that was configured", async () => {
    render(<SetupWizard />);
    await createVault();

    // Configure AI for real, then skip the rest.
    fireEvent.change(screen.getByLabelText(/^Endpoint URL$/), {
      target: { value: "https://api.anthropic.com/v1/messages" },
    });
    fireEvent.click(button(/Save & Continue/));
    await screen.findByText(/Configure Blockchain Settlement/);

    fireEvent.click(button(/Use Demo Mode/));
    fireEvent.click(button(/^Skip →$/));
    fireEvent.click(button(/^Skip →$/));

    expect(screen.getByTestId("summary-ai").textContent).toContain("✅ Configured");
    // And the vault, which is never skippable, is always reported created.
    expect(screen.getByTestId("summary-vault").textContent).toContain("✅ Created");
  });

  it("shows ⚠️ and a settings pointer for every skipped step", async () => {
    render(<SetupWizard />);
    await createVault();
    skipToSummary();

    for (const key of ["ai", "blockchain", "docusign", "notifications"]) {
      expect(screen.getByTestId(`summary-${key}`).textContent).toContain("⚠️");
    }
    expect(screen.getByTestId("summary-vault").textContent).toContain("✅");
    expect(screen.getAllByText(/Configure anytime in Settings/).length).toBe(4);
  });

  it("closes the wizard when the operator starts using the app", async () => {
    useSession.setState({ showWizard: true });
    render(<SetupWizard />);
    await createVault();
    skipToSummary();

    fireEvent.click(button(/Start Using LexEscrow/));

    expect(useSession.getState().showWizard).toBe(false);
    expect(useSession.getState().wizardComplete).toBe(true);
  });
});

// ── First-run detection ──────────────────────────────────────────────────────

/**
 * The `exists: false` branch is not here — it needs an install with no vault at
 * all, and this file creates one in its very first suite. The browser vault
 * persists into a module-private cell that no test can clear (this jsdom's
 * `localStorage` has no mutators, so the storage fallback is in-memory), and a
 * per-file module registry is the only reset available. So virgin-install
 * detection lives in `setup-wizard-first-run.test.tsx`, which creates no vault
 * before asserting it.
 */
describe("checkWizard", () => {
  it("stays out of the way once a vault exists", async () => {
    await backend.vaultUnlock(STRONG_PASSWORD);
    expect((await backend.vaultStatus()).exists).toBe(true);

    await useSession.getState().checkWizard();

    expect(useSession.getState().showWizard).toBe(false);
    expect(useSession.getState().wizardComplete).toBe(true);
  });

  it("does not re-onboard an install that has just finished the wizard", async () => {
    // The end-to-end version of the promise: run the flow, then re-run the
    // check the way a relaunch would. A vault now exists, so it stays shut.
    useSession.setState({ showWizard: true });
    render(<SetupWizard />);
    await createVault();
    skipToSummary();
    fireEvent.click(button(/Start Using LexEscrow/));

    await useSession.getState().checkWizard();
    expect(useSession.getState().showWizard).toBe(false);
  });
});

describe("openWizard", () => {
  it("re-opens the flow for an install that already has a vault", async () => {
    await backend.vaultUnlock(STRONG_PASSWORD);
    await useSession.getState().checkWizard();
    expect(useSession.getState().showWizard).toBe(false);

    useSession.getState().openWizard();
    expect(useSession.getState().showWizard).toBe(true);
  });

  /**
   * Step 2 on a re-run is a different question from step 2 on a first run, and
   * the flow has to ask the right one. An operator returning to fill in the
   * steps they skipped already has a vault: prompting them to *choose* an
   * unrecoverable password would be false, and holding them to the strength
   * gate could bar a pre-existing weak password from reaching step 3 at all —
   * locking them out of the only thing they came back for.
   */
  it("asks a returning operator to unlock rather than to create", async () => {
    await backend.vaultUnlock(STRONG_PASSWORD);
    render(<SetupWizard />);
    fireEvent.click(button(/Get Started/));

    expect(await screen.findByText(/Unlock Your Vault/)).toBeTruthy();
    expect(screen.queryByText(/Create Your Vault Password/)).toBeNull();

    // None of the choose-a-password apparatus applies to an existing one.
    expect(screen.queryByTestId("strength-bar")).toBeNull();
    expect(screen.queryByLabelText(/^Confirm password$/)).toBeNull();
    expect(screen.queryByText(/no recovery mechanism/)).toBeNull();

    // And a single character is enough to try — the vault itself is the judge.
    expect(isDisabled(/Unlock Vault/)).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Vault password$/), { target: { value: "x" } });
    expect(isDisabled(/Unlock Vault/)).toBe(false);
  });

  it("reports a bad password on re-run instead of advancing", async () => {
    await backend.vaultUnlock(STRONG_PASSWORD);
    render(<SetupWizard />);
    fireEvent.click(button(/Get Started/));
    await screen.findByText(/Unlock Your Vault/);

    fireEvent.change(screen.getByLabelText(/^Vault password$/), {
      target: { value: "not-the-password" },
    });
    fireEvent.click(button(/Unlock Vault/));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/Configure AI Provider/)).toBeNull();
  });

  /**
   * The re-run link sits below the vault gate rather than inside it. An
   * operator who skipped every optional step and then locked the vault is
   * exactly who needs the guided flow back, and Configuration shows them
   * nothing but a password box until they unlock.
   */
  it("is reachable from Configuration even while the vault is locked", async () => {
    render(<Configuration />);

    const link = await screen.findByRole("button", { name: /Re-run setup wizard/i });
    expect(screen.getByText(/Create a vault|Unlock the vault/)).toBeTruthy();

    fireEvent.click(link);
    expect(useSession.getState().showWizard).toBe(true);
  });
});
