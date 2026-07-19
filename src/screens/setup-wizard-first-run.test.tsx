// @vitest-environment jsdom
/**
 * First-run detection on an install that has never been set up.
 *
 * Separate from `setup-wizard.test.tsx` for one reason: the condition under
 * test is "no vault has ever existed", and that state cannot be restored once
 * any test has left it. The browser vault persists into a module-private cell
 * — this jsdom exposes a `localStorage` object with no `setItem`, so the vault
 * takes its in-memory fallback path — and the product has no "delete vault"
 * operation to reach for, deliberately. Vitest's per-file module registry is
 * therefore the only reset there is, and a file that creates no vault is the
 * only place this assertion means anything.
 *
 * Nothing here may create a vault. That is the whole point of the file.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SetupWizard } from "./SetupWizard";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";

beforeEach(() => {
  useSession.setState({ showWizard: false, wizardComplete: false });
});

describe("checkWizard — no vault yet", () => {
  it("confirms the precondition: this install has no vault", async () => {
    expect((await backend.vaultStatus()).exists).toBe(false);
  });

  it("raises the wizard when the vault does not exist", async () => {
    await useSession.getState().checkWizard();

    expect(useSession.getState().showWizard).toBe(true);
    // Not complete — the operator has not been through the flow, they have
    // only been shown it. `completeWizard` is the only thing that sets this.
    expect(useSession.getState().wizardComplete).toBe(false);
  });

  it("puts the operator on the welcome step, not a bare password prompt", async () => {
    await useSession.getState().checkWizard();
    render(<SetupWizard />);

    // The failure this whole screen exists to prevent: meeting LexEscrow for
    // the first time as an unexplained, unrecoverable password field.
    expect(screen.getByText(/Welcome to LexEscrow/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Get Started/ })).toBeTruthy();
  });
});
