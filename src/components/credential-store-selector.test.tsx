// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

// @vitest-environment jsdom
/**
 * First-launch credential backend selection.
 *
 * What matters here is not that two cards render, but that the one failure an
 * operator can actually fix is presented as fixable. On a Linux box with no
 * Secret Service provider, "use the OS keychain" is a choice the machine cannot
 * honour, and the difference between a usable app and a dead end is whether the
 * screen shows the install command, keeps the operator on this screen instead
 * of advancing into an app with no reachable credentials, and offers the other
 * backend as a way forward.
 *
 * `setStoreBackend` is mocked rather than run against a real keyring: the point
 * under test is how the UI reacts to each outcome, and a real keychain would
 * report whatever the machine running the suite happens to have.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CredentialStoreSelector } from "./CredentialStoreSelector";
import * as backend from "../lib/backend";
import type { StoreBackendError } from "../lib/vaultTypes";

const APT = "sudo apt install libsecret-1-0";

const libsecretMissing: StoreBackendError = {
  code: "LIBSECRET_NOT_FOUND",
  message: "No system keyring (Secret Service) is available.",
  installCommand: APT,
};

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the two options", () => {
  it("presents the OS keychain as recommended", () => {
    render(<CredentialStoreSelector onSelected={() => {}} />);

    expect(screen.getByText("OS Keychain")).toBeTruthy();
    expect(screen.getByText("App Vault")).toBeTruthy();
    expect(screen.getByText(/recommended/i)).toBeTruthy();

    // Recommended *and* preselected — a recommendation the operator has to act
    // on to accept is not much of a default.
    const osCard = screen.getByText("OS Keychain").closest("button")!;
    expect(osCard.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Use OS Keychain/i })).toBeTruthy();
  });

  it("names what each option costs the operator", () => {
    render(<CredentialStoreSelector onSelected={() => {}} />);
    expect(screen.getByText(/No vault password required/i)).toBeTruthy();
    expect(screen.getByText(/AES-256-GCM encrypted file/i)).toBeTruthy();
    expect(screen.getByText(/Master password required/i)).toBeTruthy();
    expect(screen.getByText(/Works on all systems without dependencies/i)).toBeTruthy();
  });

  it("advances once a backend is accepted", async () => {
    vi.spyOn(backend, "setStoreBackend").mockResolvedValue(undefined);
    const onSelected = vi.fn();
    render(<CredentialStoreSelector onSelected={onSelected} />);

    fireEvent.click(screen.getByRole("button", { name: /Use OS Keychain/i }));

    await waitFor(() => expect(onSelected).toHaveBeenCalledWith("os_keychain"));
    expect(backend.setStoreBackend).toHaveBeenCalledWith("os_keychain");
  });

  it("selects the app vault when that is the card chosen", async () => {
    vi.spyOn(backend, "setStoreBackend").mockResolvedValue(undefined);
    const onSelected = vi.fn();
    render(<CredentialStoreSelector onSelected={onSelected} />);

    fireEvent.click(screen.getByText("App Vault"));
    fireEvent.click(screen.getByRole("button", { name: /Use App Vault/i }));

    await waitFor(() => expect(onSelected).toHaveBeenCalledWith("app_vault"));
  });
});

describe("Linux with no Secret Service provider", () => {
  async function failSelection(error: StoreBackendError = libsecretMissing) {
    vi.spyOn(backend, "setStoreBackend").mockRejectedValue(error);
    const onSelected = vi.fn();
    render(<CredentialStoreSelector onSelected={onSelected} />);
    fireEvent.click(screen.getByRole("button", { name: /Use OS Keychain/i }));
    await screen.findByRole("alert");
    return onSelected;
  }

  it("shows the error inline and does not advance", async () => {
    const onSelected = await failSelection();

    expect(screen.getByRole("alert").textContent).toMatch(/No system keyring is available/i);
    // Advancing would drop the operator into an app with no reachable
    // credential store at all — the error has to hold the screen.
    expect(onSelected).not.toHaveBeenCalled();
  });

  it("shows the install command in a monospace block", async () => {
    await failSelection();

    const block = screen.getByTestId("install-command");
    expect(block.textContent).toBe(APT);
    expect(block.tagName).toBe("CODE");
    expect(block.className).toMatch(/font-mono/);
  });

  it("copies the install command to the clipboard", async () => {
    await failSelection();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(APT));
    // Confirmed back to the operator — a copy button that looks identical
    // before and after is indistinguishable from one that did nothing.
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  });

  it("offers the app vault as the way forward", async () => {
    vi.spyOn(backend, "setStoreBackend")
      .mockRejectedValueOnce(libsecretMissing)
      .mockResolvedValueOnce(undefined);
    const onSelected = vi.fn();
    render(<CredentialStoreSelector onSelected={onSelected} />);

    fireEvent.click(screen.getByRole("button", { name: /Use OS Keychain/i }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: /Switch to App Vault/i }));

    await waitFor(() => expect(onSelected).toHaveBeenCalledWith("app_vault"));
  });

  it("omits the command block entirely for an unrecognised distro", async () => {
    // A wrong `sudo` line is worse than none, so the backend sends null rather
    // than guessing — and the UI must not render an empty box with a Copy
    // button that copies nothing.
    await failSelection({ ...libsecretMissing, installCommand: null });

    expect(screen.queryByTestId("install-command")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/package manager/i);
    // The way out is still offered.
    expect(screen.getByRole("button", { name: /Switch to App Vault/i })).toBeTruthy();
  });

  it("reports other failures without the libsecret remedy", async () => {
    await failSelection({
      code: "OS_ERROR",
      message: "keychain access was denied",
      installCommand: null,
    });

    expect(screen.getByRole("alert").textContent).toMatch(/keychain access was denied/i);
    expect(screen.queryByRole("button", { name: /Switch to App Vault/i })).toBeNull();
  });

  it("survives a denied clipboard permission", async () => {
    // The command is on screen and selectable either way; a permission prompt
    // the operator declined is not an error state worth showing.
    writeText.mockRejectedValue(new Error("denied"));
    await failSelection();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.getByTestId("install-command").textContent).toBe(APT);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});
