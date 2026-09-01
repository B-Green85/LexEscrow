// @vitest-environment jsdom
/**
 * Write-authorization gate on the deployer private key.
 *
 * Two things are under test and they are not the same thing:
 *
 *   1. The modal itself — which of its two shapes it takes, and that a rejected
 *      password keeps it open instead of dropping the operator back into a form
 *      they have to refill.
 *   2. That the gate is actually wired to the *backend*, not to a flag. Under
 *      App Vault the modal must never appear, because that path already gates
 *      on the vault password and a second prompt would be friction with nothing
 *      behind it.
 *
 * `setBlockchain` is mocked throughout: what matters here is whether it is
 * called, with what, and how the UI reacts to each answer — not whether a real
 * keychain accepts the write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BlockchainWriteAuthModal } from "./BlockchainWriteAuthModal";
import { BlockchainCard } from "../screens/Configuration";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import type { BlockchainPublic } from "../lib/vaultTypes";

const WRONG = "Authorization password incorrect";

const CONFIGURED: BlockchainPublic = {
  hasConfig: true,
  networkName: "Ethereum Sepolia",
  chainId: 11155111,
  contractAddress: "0xc0",
  deployerAddress: "0xd0",
  usdcAddress: "0xu0",
  forwarderAddress: "0xf0",
  rpcUrlHint: "eth-sepolia.g.alchemy.com",
  hasPrivateKey: true,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── The modal on its own ─────────────────────────────────────────────────────

describe("BlockchainWriteAuthModal", () => {
  it("asks the operator to set a password the first time", () => {
    render(
      <BlockchainWriteAuthModal enrolled={false} onConfirm={async () => null} onCancel={() => {}} />,
    );

    expect(screen.getByText("Set a write authorization password")).toBeTruthy();
    expect(screen.getByText(/controls on-chain fund movements/i)).toBeTruthy();
    // Typed twice, because there is nothing to check a typo against — whatever
    // is entered *becomes* the password.
    expect(screen.getByLabelText("Confirm password")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Set password and save/i })).toBeTruthy();
  });

  it("asks the operator to confirm on every write after that", () => {
    render(
      <BlockchainWriteAuthModal enrolled onConfirm={async () => null} onCancel={() => {}} />,
    );

    expect(screen.getByText("Confirm deployer key change")).toBeTruthy();
    expect(screen.getByText(/save the new deployer private key/i)).toBeTruthy();
    // Nothing to confirm against — the stored hash is the check.
    expect(screen.queryByLabelText("Confirm password")).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });

  it("holds the enrolment submit until both fields agree", () => {
    render(
      <BlockchainWriteAuthModal enrolled={false} onConfirm={async () => null} onCancel={() => {}} />,
    );
    const submit = screen.getByRole("button", { name: /Set password and save/i });

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    expect(submit.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "hunter3" } });
    expect(screen.getByText(/Passwords do not match/i)).toBeTruthy();
    expect(submit.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "hunter2" } });
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  it("passes the password to the caller on confirm", async () => {
    const onConfirm = vi.fn().mockResolvedValue(null);
    render(<BlockchainWriteAuthModal enrolled onConfirm={onConfirm} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText(/Write authorization password/i), {
      target: { value: "the-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("the-password"));
  });

  it("keeps the modal open on a wrong password and clears the field", async () => {
    const onConfirm = vi.fn().mockResolvedValue(WRONG);
    const onCancel = vi.fn();
    render(<BlockchainWriteAuthModal enrolled onConfirm={onConfirm} onCancel={onCancel} />);

    const field = screen.getByLabelText(/Write authorization password/i) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "guessed" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Authorization password incorrect/i);
    // Still open — a retry is one field, not a refilled form.
    expect(screen.getByText("Confirm deployer key change")).toBeTruthy();
    expect(field.value).toBe("");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels without submitting anything", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<BlockchainWriteAuthModal enrolled onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.change(screen.getByLabelText(/Write authorization password/i), {
      target: { value: "typed-then-thought-better" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ── Wired into Screen 7 ──────────────────────────────────────────────────────

describe("the blockchain card, by backend", () => {
  beforeEach(() => {
    vi.spyOn(backend, "setBlockchain").mockResolvedValue(undefined);
    vi.spyOn(backend, "hasBlockchainWriteAuth").mockResolvedValue(true);
  });

  /**
   * Open the edit form and fill the one field Save requires.
   *
   * By id rather than by label: the field's label is paired with an info
   * tooltip that repeats the same words, so a text query matches both.
   */
  function openEdit() {
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const contract = document.getElementById("bc-contract-address") as HTMLInputElement;
    fireEvent.change(contract, { target: { value: "0xcontract" } });
  }

  it("gates the save behind the modal on the OS keychain", async () => {
    useSession.setState({ storeBackend: "os_keychain", storeBackendChecked: true });
    render(<BlockchainCard data={CONFIGURED} refresh={() => {}} />);
    openEdit();

    // There is no vault password to type inline — that field belongs to the
    // other backend.
    expect(screen.queryByLabelText("Vault password")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Confirm deployer key change")).toBeTruthy());
    // Nothing is written until the modal is satisfied.
    expect(backend.setBlockchain).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Write authorization password/i), {
      target: { value: "auth-pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(backend.setBlockchain).toHaveBeenCalled());
    expect(vi.mocked(backend.setBlockchain).mock.calls[0][0]).toBe("auth-pw");
  });

  it("never shows the modal on the app vault backend", async () => {
    // That path re-derives the vault key from the inline password. A second
    // prompt would be friction with nothing behind it.
    useSession.setState({ storeBackend: "app_vault", storeBackendChecked: true });
    render(<BlockchainCard data={CONFIGURED} refresh={() => {}} />);
    openEdit();

    expect(screen.getByLabelText("Vault password")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Vault password"), { target: { value: "vault-pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(backend.setBlockchain).toHaveBeenCalled());
    expect(screen.queryByText("Confirm deployer key change")).toBeNull();
    expect(screen.queryByText("Set a write authorization password")).toBeNull();
    expect(vi.mocked(backend.setBlockchain).mock.calls[0][0]).toBe("vault-pw");
  });

  it("cancelling the modal writes nothing", async () => {
    useSession.setState({ storeBackend: "os_keychain", storeBackendChecked: true });
    render(<BlockchainCard data={CONFIGURED} refresh={() => {}} />);
    openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Confirm deployer key change")).toBeTruthy());

    // Scoped to the modal: the edit form behind it has its own Cancel, and
    // clicking that one would be a different test.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Confirm deployer key change")).toBeNull());
    expect(backend.setBlockchain).not.toHaveBeenCalled();
    // And the edit form is still open, with the operator's work intact.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("offers the enrolment form when no password has been set yet", async () => {
    vi.mocked(backend.hasBlockchainWriteAuth).mockResolvedValue(false);
    useSession.setState({ storeBackend: "os_keychain", storeBackendChecked: true });
    render(<BlockchainCard data={CONFIGURED} refresh={() => {}} />);
    openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Set a write authorization password")).toBeTruthy());
    // And no change link — there is nothing to change yet.
    expect(screen.queryByRole("button", { name: /Change write authorization password/i })).toBeNull();
  });

  it("offers a change link once a password exists, on the keychain only", async () => {
    useSession.setState({ storeBackend: "os_keychain", storeBackendChecked: true });
    const { unmount } = render(<BlockchainCard data={CONFIGURED} refresh={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Change write authorization password/i })).toBeTruthy(),
    );
    unmount();

    useSession.setState({ storeBackend: "app_vault" });
    render(<BlockchainCard data={CONFIGURED} refresh={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Change write authorization password/i })).toBeNull();
  });

  it("changes the authorization password, and reports a wrong current one", async () => {
    const change = vi
      .spyOn(backend, "changeBlockchainWriteAuth")
      .mockRejectedValueOnce(new Error("Current password incorrect"))
      .mockResolvedValueOnce(undefined);

    useSession.setState({ storeBackend: "os_keychain", storeBackendChecked: true });
    render(<BlockchainCard data={CONFIGURED} refresh={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Change write authorization password/i }),
    );
    await screen.findByRole("heading", { name: "Change write authorization password" });

    const fill = (current: string) => {
      fireEvent.change(screen.getByLabelText("Current password"), { target: { value: current } });
      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "next-pw" } });
      fireEvent.change(screen.getByLabelText("Confirm new password"), {
        target: { value: "next-pw" },
      });
    };

    fill("wrong-current");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Current password incorrect/i);
    // Still open — the operator retries the current password, not the whole form.
    expect(
      screen.getByRole("heading", { name: "Change write authorization password" }),
    ).toBeTruthy();

    fill("right-current");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));

    await waitFor(() => expect(change).toHaveBeenLastCalledWith("right-current", "next-pw"));
    await waitFor(() =>
      expect(screen.queryByLabelText("Current password")).toBeNull(),
    );
  });
});
