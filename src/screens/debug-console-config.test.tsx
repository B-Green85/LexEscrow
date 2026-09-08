// @vitest-environment jsdom
/**
 * LexTrace IT setup — the Configuration card and the credential round-trip.
 *
 * Two halves, and the second is the one that matters:
 *
 *   1. The card states what an operator needs to decide anything — Configured
 *      or Not configured, and who the recorded operator is.
 *   2. The password it writes is a *verifier*, never a stored secret. That half
 *      runs against the real browser vault rather than a mocked `setDebugConsole`,
 *      because a mock would round-trip whatever this file handed it and prove
 *      nothing about the boundary it is supposed to be guarding.
 *
 * The confirm field is not decoration here. Every other secret on the
 * Configuration screen fails visibly on first use when mistyped; this one fails
 * by locking its owner out of the tool they have just set up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DebugConsoleCard } from "./Configuration";
import * as backend from "../lib/backend";
import * as browserVault from "../lib/browserVault";

const OPERATOR = "ops-jordan";
const PASSWORD = "console-pw-9000";

beforeEach(() => {
  browserVault.lock();
});
afterEach(() => {
  cleanup();
  browserVault.lock();
  vi.restoreAllMocks();
});

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

// ── The card ─────────────────────────────────────────────────────────────────

describe("DebugConsoleCard", () => {
  it("reports Not configured and says what that costs", () => {
    render(<DebugConsoleCard data={null} refresh={vi.fn()} />);

    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByText(/the debug icon is visible but will refuse to open/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
  });

  it("reports Configured with the operator name and no password", () => {
    render(
      <DebugConsoleCard data={{ configured: true, operatorId: OPERATOR }} refresh={vi.fn()} />,
    );

    expect(screen.getByText("Configured")).toBeTruthy();
    expect(screen.getByText(OPERATOR)).toBeTruthy();
    // A stored-marker, not the value: there is no plaintext to show even if the
    // screen wanted to.
    expect(screen.getByText("•••••••• stored")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("pre-populates the operator name on edit and leaves the password blank", () => {
    render(
      <DebugConsoleCard data={{ configured: true, operatorId: OPERATOR }} refresh={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(field("IT Operator Name").value).toBe(OPERATOR);
    expect(field("Password").value).toBe("");
    expect(field("Password").placeholder).toBe("leave blank to keep existing");
  });

  it("refuses a first setup with no password", async () => {
    const save = vi.spyOn(backend, "setDebugConsole").mockResolvedValue(undefined);
    render(<DebugConsoleCard data={null} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));

    fireEvent.change(field("IT Operator Name"), { target: { value: OPERATOR } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Set a password — the console is password-gated.")).toBeTruthy();
    // Nothing was written: a name-only group reads as unconfigured, so the
    // operator would have pressed Save, seen success, and still been refused.
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a mismatched confirmation", async () => {
    const save = vi.spyOn(backend, "setDebugConsole").mockResolvedValue(undefined);
    render(<DebugConsoleCard data={null} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));

    fireEvent.change(field("IT Operator Name"), { target: { value: OPERATOR } });
    fireEvent.change(field("Password"), { target: { value: PASSWORD } });
    fireEvent.change(field("Confirm password"), { target: { value: "not-the-same" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("The two passwords do not match.")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("submits a blank password on edit, so the stored one is kept", async () => {
    const save = vi.spyOn(backend, "setDebugConsole").mockResolvedValue(undefined);
    render(
      <DebugConsoleCard data={{ configured: true, operatorId: "ops-jordn" }} refresh={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    fireEvent.change(field("IT Operator Name"), { target: { value: OPERATOR } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ operatorId: OPERATOR, password: undefined }),
    );
  });
});

// ── The credential ───────────────────────────────────────────────────────────

describe("the stored credential", () => {
  it("never holds the password, only a verifier", async () => {
    await backend.vaultUnlock("vault-pw");
    render(<DebugConsoleCard data={null} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));

    fireEvent.change(field("IT Operator Name"), { target: { value: OPERATOR } });
    fireEvent.change(field("Password"), { target: { value: PASSWORD } });
    fireEvent.change(field("Confirm password"), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () =>
      expect((await backend.getDebugConsolePublic()).configured).toBe(true),
    );

    // The public shape is the only thing that crosses the boundary, and it
    // carries the name and a flag — nothing derived from the password.
    const pub = await backend.getDebugConsolePublic();
    expect(pub.operatorId).toBe(OPERATOR);
    expect(JSON.stringify(pub)).not.toContain(PASSWORD);

    expect(await backend.authenticateDebugConsole(PASSWORD)).toBe(true);
    expect(await backend.authenticateDebugConsole("wrong")).toBe(false);
    expect(await backend.authenticateDebugConsole("")).toBe(false);
  });

  it("reports not configured while the vault is sealed", async () => {
    await backend.vaultUnlock("vault-pw");
    await backend.setDebugConsole({ operatorId: OPERATOR, password: PASSWORD });
    expect(await backend.hasDebugConsole()).toBe(true);

    await backend.vaultLock();

    // Sealed is "cannot open the console", which is the same answer the icon
    // acts on — and emphatically not an exception that breaks the screen.
    expect(await backend.hasDebugConsole()).toBe(false);
    expect(await backend.authenticateDebugConsole(PASSWORD)).toBe(false);
  });

  it("keeps the stored password when only the operator name is corrected", async () => {
    await backend.vaultUnlock("vault-pw");
    await backend.setDebugConsole({ operatorId: "ops-jordn", password: PASSWORD });

    await backend.setDebugConsole({ operatorId: OPERATOR });

    expect((await backend.getDebugConsolePublic()).operatorId).toBe(OPERATOR);
    expect(await backend.authenticateDebugConsole(PASSWORD)).toBe(true);
  });

  it("replaces the password when a new one is given", async () => {
    await backend.vaultUnlock("vault-pw");
    await backend.setDebugConsole({ operatorId: OPERATOR, password: PASSWORD });

    await backend.setDebugConsole({ operatorId: OPERATOR, password: "second-password" });

    expect(await backend.authenticateDebugConsole("second-password")).toBe(true);
    expect(await backend.authenticateDebugConsole(PASSWORD)).toBe(false);
  });
});
