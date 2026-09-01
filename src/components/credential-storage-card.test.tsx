// @vitest-environment jsdom
/**
 * Screen 7's Credential Storage section.
 *
 * The interesting cases are the ones where migration does not fully succeed.
 * A partial copy that silently flipped the active backend would leave the app
 * pointed at a store missing exactly the credentials that failed to write —
 * so the backend holds the switch back, and this screen has to report the
 * backend actually in use rather than the one that was requested.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CredentialStorageCard } from "./CredentialStorageCard";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import type { StoreBackendError } from "../lib/vaultTypes";

const ALL_KEYS = [
  "ai",
  "smtp",
  "twilio",
  "docusign",
  "clio",
  "practice-panther",
  "blockchain",
  "hmac-vault-key",
];

beforeEach(() => {
  useSession.setState({ storeBackend: "app_vault", storeBackendChecked: true });
  vi.spyOn(backend, "checkOsKeychain").mockResolvedValue({
    available: true,
    installCommand: null,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Open the confirm step and accept it. */
async function migrate() {
  fireEvent.click(screen.getByRole("button", { name: /Switch to/i }));
  const confirm = await screen.findByRole("button", { name: /^Migrate to/i });
  fireEvent.click(confirm);
}

describe("current backend", () => {
  it("names the active store and offers the other one", () => {
    render(<CredentialStorageCard />);
    expect(screen.getByText("App Vault")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Switch to OS Keychain/i })).toBeTruthy();
  });

  it("offers the app vault when the keychain is active", () => {
    useSession.setState({ storeBackend: "os_keychain" });
    render(<CredentialStorageCard />);
    expect(screen.getByRole("button", { name: /Switch to App Vault/i })).toBeTruthy();
  });

  it("confirms before migrating, and says the originals stay put", async () => {
    render(<CredentialStorageCard />);
    fireEvent.click(screen.getByRole("button", { name: /Switch to OS Keychain/i }));

    expect(
      await screen.findByText(/Migrate your existing credentials to OS Keychain\?/i),
    ).toBeTruthy();
    // Non-destructive, and said so — an operator deciding whether to move a
    // DocuSign PEM needs to know they are not about to lose it.
    expect(screen.getByText(/App Vault copy is left in place/i)).toBeTruthy();
  });

  it("does not migrate when the confirm is declined", async () => {
    const spy = vi.spyOn(backend, "migrateCredentials");
    render(<CredentialStorageCard />);
    fireEvent.click(screen.getByRole("button", { name: /Switch to OS Keychain/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByText(/Migrate your existing credentials/i)).toBeNull(),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("migration results", () => {
  it("reports every key that moved and switches the active backend", async () => {
    vi.spyOn(backend, "migrateCredentials").mockResolvedValue({
      migrated: ALL_KEYS,
      failed: [],
      newBackend: "os_keychain",
    });
    render(<CredentialStorageCard />);
    await migrate();

    await screen.findByRole("status");
    // Named by what the operator calls them, not by the wire key.
    expect(screen.getByText("AI provider")).toBeTruthy();
    expect(screen.getByText("DocuSign")).toBeTruthy();
    expect(screen.getByText("AnchorReceipt seal key")).toBeTruthy();
    expect(screen.getAllByText("moved")).toHaveLength(ALL_KEYS.length);

    expect(useSession.getState().storeBackend).toBe("os_keychain");
  });

  it("names what failed and stays on the backend that still has it", async () => {
    // The backend holds the switch back on any failure, and reports the
    // backend actually in use. Trusting the requested target here would tell
    // the operator they are on a store that cannot read their DocuSign key.
    vi.spyOn(backend, "migrateCredentials").mockResolvedValue({
      migrated: ["ai", "smtp"],
      failed: ["docusign"],
      newBackend: "app_vault",
    });
    render(<CredentialStorageCard />);
    await migrate();

    await screen.findByRole("status");
    expect(screen.getByText("DocuSign")).toBeTruthy();
    expect(screen.getByText(/could not be moved — re-enter it below/i)).toBeTruthy();
    expect(screen.getByText(/Still using App Vault/i)).toBeTruthy();
    expect(useSession.getState().storeBackend).toBe("app_vault");
  });

  it("says so plainly when there was nothing to move", async () => {
    vi.spyOn(backend, "migrateCredentials").mockResolvedValue({
      migrated: [],
      failed: [],
      newBackend: "os_keychain",
    });
    render(<CredentialStorageCard />);
    await migrate();

    expect(await screen.findByText(/Nothing to move/i)).toBeTruthy();
  });
});

describe("Linux with no Secret Service provider", () => {
  it("shows the install command inline, with a copy button", async () => {
    const err: StoreBackendError = {
      code: "LIBSECRET_NOT_FOUND",
      message: "No system keyring (Secret Service) is available.",
      installCommand: "sudo dnf install libsecret",
    };
    vi.spyOn(backend, "migrateCredentials").mockRejectedValue(err);
    render(<CredentialStorageCard />);
    await migrate();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/No system keyring is available/i);
    // Same component, same wording as the first-launch flow.
    expect(screen.getByTestId("install-command").textContent).toBe("sudo dnf install libsecret");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("sudo dnf install libsecret"),
    );
  });

  it("disables the switch up front when the keychain is unreachable", async () => {
    // Probed before the operator commits, rather than failing after they do.
    vi.spyOn(backend, "checkOsKeychain").mockResolvedValue({
      available: false,
      installCommand: "sudo apt install libsecret-1-0",
    });
    render(<CredentialStorageCard />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Switch to OS Keychain/i }).hasAttribute("disabled")).toBe(true),
    );
    expect(screen.getByText(/No system keyring is available on this machine/i)).toBeTruthy();
  });
});
