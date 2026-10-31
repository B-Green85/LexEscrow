// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

// @vitest-environment jsdom
/**
 * Blockchain settlement config — Configuration card + settle gate.
 *
 * Two things are under test here and they are not the same thing:
 *
 *   1. The card behaves like every other vault card (renders empty, renders a
 *      configured summary, pre-fills defaults) — ordinary UI.
 *   2. The private key does not leak, and an unconfigured install cannot
 *      settle — the reason this feature exists. Those are asserted against the
 *      real vault round-trip rather than a mock, because a mock of
 *      `getBlockchainPublic` would happily return whatever shape the test
 *      author expected and prove nothing about the actual boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BlockchainCard, SEPOLIA_DEFAULTS } from "./Configuration";
import { EscrowMonitorView, type EscrowMonitorViewProps } from "./EscrowMonitor";
import { evaluateSummary, type Condition } from "../lib/conditions";
import { ExecutionPath } from "../lexguard/types";
import type { BlockchainPublic } from "../lib/vaultTypes";
import * as backend from "../lib/backend";
import * as browserVault from "../lib/browserVault";

afterEach(cleanup);

const WARNING = /most sensitive credential in LexEscrow/i;

/** A fully configured public shape, as the vault would return it. */
function configured(extra: Partial<BlockchainPublic> = {}): BlockchainPublic {
  return {
    hasConfig: true,
    networkName: "Ethereum Sepolia",
    chainId: 11155111,
    contractAddress: SEPOLIA_DEFAULTS.contractAddress,
    deployerAddress: SEPOLIA_DEFAULTS.deployerAddress,
    usdcAddress: SEPOLIA_DEFAULTS.usdcAddress,
    forwarderAddress: SEPOLIA_DEFAULTS.forwarderAddress,
    rpcUrlHint: "eth-sepolia.g.alchemy.com",
    hasPrivateKey: true,
    ...extra,
  };
}

// ── The card ─────────────────────────────────────────────────────────────────

describe("BlockchainCard", () => {
  it("renders an unconfigured state that says settlement is disabled", () => {
    render(<BlockchainCard data={null} refresh={vi.fn()} />);

    expect(screen.getByText(/No blockchain configured/i)).toBeTruthy();
    // The rest of the workflow is explicitly unaffected — graceful degradation
    // is a promise to the operator, so the card has to make it.
    expect(screen.getByText(/Parsing, LexGuard and the condition engine are unaffected/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("shows the configured summary, with the RPC reduced to its host", () => {
    render(<BlockchainCard data={configured()} refresh={vi.fn()} />);

    expect(screen.getByText("Ethereum Sepolia")).toBeTruthy();
    expect(screen.getByText("11155111")).toBeTruthy();
    expect(screen.getByText(SEPOLIA_DEFAULTS.contractAddress)).toBeTruthy();
    expect(screen.getByText("•••••••• stored")).toBeTruthy();
    // The host, never a full URL that could carry an API key.
    expect(screen.getByText("eth-sepolia.g.alchemy.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("flags network config that has no signing key as unable to settle", () => {
    render(<BlockchainCard data={configured({ hasPrivateKey: false })} refresh={vi.fn()} />);
    expect(screen.getByText(/cannot submit a settlement/i)).toBeTruthy();
  });

  it("keeps the warning banner visible in both the summary and the edit view", () => {
    const { rerender } = render(<BlockchainCard data={null} refresh={vi.fn()} />);
    expect(screen.getByText(WARNING)).toBeTruthy();

    // Configured summary.
    rerender(<BlockchainCard data={configured()} refresh={vi.fn()} />);
    expect(screen.getByText(WARNING)).toBeTruthy();

    // And while editing — the moment a key is actually about to be pasted.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText(WARNING)).toBeTruthy();
  });

  it("pre-fills every non-secret field and leaves the private key blank", () => {
    render(<BlockchainCard data={null} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: /Pre-fill Sepolia defaults/i }));

    const value = (label: RegExp | string) =>
      (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;

    expect(value(/^Network name$/)).toBe(SEPOLIA_DEFAULTS.networkName);
    expect(value(/^Chain ID$/)).toBe(String(SEPOLIA_DEFAULTS.chainId));
    expect(value(/^RPC URL$/)).toBe(SEPOLIA_DEFAULTS.rpcUrl);
    expect(value(/Contract address/)).toBe(SEPOLIA_DEFAULTS.contractAddress);
    expect(value(/^Deployer address$/)).toBe(SEPOLIA_DEFAULTS.deployerAddress);
    expect(value(/^USDC address$/)).toBe(SEPOLIA_DEFAULTS.usdcAddress);
    expect(value(/Forwarder address/)).toBe(SEPOLIA_DEFAULTS.forwarderAddress);

    // The one field defaults must never touch. A shipped default private key
    // would be a key every install shares — and every attacker has.
    expect(value(/^Deployer private key$/)).toBe("");
  });

  it("will not save without the vault password", () => {
    render(<BlockchainCard data={null} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: /Pre-fill Sepolia defaults/i }));

    // Everything else is filled; Save stays shut until the password is entered.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^Vault password$/), { target: { value: "pw" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── The IPC boundary ─────────────────────────────────────────────────────────

describe("getBlockchainPublic — the secret boundary", () => {
  const PRIVATE_KEY = "0xc0ffee-this-must-never-leave-the-vault";
  const RPC_WITH_KEY = "https://eth-sepolia.g.alchemy.com/v2/BILLABLE_API_KEY";

  beforeEach(async () => {
    // No storage reset: this jsdom lacks `localStorage.clear`, and the browser
    // vault already falls back to an in-memory cell when storage is
    // unavailable. Unlocking with a stable password is enough — vitest gives
    // each test file its own module registry, so the cell starts empty here.
    browserVault.lock();
    await backend.vaultUnlock("test-password");
    await backend.setBlockchain("test-password", {
      networkName: SEPOLIA_DEFAULTS.networkName,
      chainId: SEPOLIA_DEFAULTS.chainId,
      rpcUrl: RPC_WITH_KEY,
      contractAddress: SEPOLIA_DEFAULTS.contractAddress,
      deployerAddress: SEPOLIA_DEFAULTS.deployerAddress,
      deployerPrivateKey: PRIVATE_KEY,
      usdcAddress: SEPOLIA_DEFAULTS.usdcAddress,
      forwarderAddress: SEPOLIA_DEFAULTS.forwarderAddress,
    });
  });

  afterEach(() => {
    browserVault.lock();
  });

  it("never returns the private key, in any field", async () => {
    const pub = await backend.getBlockchainPublic();

    // Not by name, and not smuggled into some other field either — the whole
    // serialized shape is checked, which is the only version of this assertion
    // that survives someone adding a field later.
    expect(JSON.stringify(pub)).not.toContain(PRIVATE_KEY);
    expect(Object.values(pub)).not.toContain(PRIVATE_KEY);
    expect(pub.hasPrivateKey).toBe(true);
  });

  it("never returns the RPC credential — only the host", async () => {
    const pub = await backend.getBlockchainPublic();

    expect(JSON.stringify(pub)).not.toContain("BILLABLE_API_KEY");
    expect(pub.rpcUrlHint).toBe("eth-sepolia.g.alchemy.com");
  });

  it("reports the config as usable for settlement", async () => {
    expect(await backend.hasBlockchain()).toBe(true);
  });

  it("reports unusable once the vault is locked", async () => {
    browserVault.lock();
    // Not an exception — settlement degrades, the rest of the workflow does not.
    expect(await backend.hasBlockchain()).toBe(false);
  });

  it("rejects a write made with the wrong vault password", async () => {
    await expect(
      backend.setBlockchain("wrong-password", {
        networkName: "Ethereum Mainnet",
        chainId: 1,
        rpcUrl: "https://mainnet.example/v2/KEY",
        contractAddress: "0xattacker",
        deployerAddress: "0xattacker",
        deployerPrivateKey: "0xattacker-key",
        usdcAddress: "0x",
        forwarderAddress: "0x",
      }),
    ).rejects.toThrow(/password/i);

    // And the original config is untouched.
    const pub = await backend.getBlockchainPublic();
    expect(pub.contractAddress).toBe(SEPOLIA_DEFAULTS.contractAddress);
  });
});

// ── The settle gate ──────────────────────────────────────────────────────────

describe("settle gate — graceful degradation", () => {
  const met: Condition[] = [
    {
      id: "c-1",
      type: "document",
      label: "document condition",
      description: "d",
      status: "met",
      assetClass: "legal",
    },
  ];

  function monitorProps(extra: Partial<EscrowMonitorViewProps> = {}): EscrowMonitorViewProps {
    return {
      assetClass: "legal",
      conditions: met,
      conditionSummary: evaluateSummary(met),
      fundsDeposited: true,
      depositTxHash: "0xdeposit",
      escrowBalance: 1_850_000n,
      conditionPolling: false,
      conditionsUpdatedAt: "2026-07-18T12:00:00Z",
      executionPath: ExecutionPath.DirectSettlement,
      arbitrationState: null,
      busy: false,
      error: null,
      cannaVerifyConditions: null,
      cannaVerifyRunning: false,
      eventLog: null,
      now: Date.parse("2026-07-18T12:00:00Z"),
      onConfirmDeposit: vi.fn(),
      onRefresh: vi.fn(),
      onWaiveCondition: vi.fn(),
      onMarkConditionMet: vi.fn(),
      onRunCannaVerify: vi.fn(),
      onProceedToSettlement: vi.fn(),
      onSignArbitration: vi.fn(),
      ...extra,
    };
  }

  const settleButton = () => screen.getByRole("button", { name: /Proceed to Settlement/i });

  it("disables the settle button and warns when the chain is not configured", () => {
    render(<EscrowMonitorView {...monitorProps({ blockchainReady: false })} />);

    expect(screen.getByText(/Blockchain not configured — set up in Configuration/i)).toBeTruthy();
    expect((settleButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not fire the settlement handler while the chain is unconfigured", () => {
    const onProceedToSettlement = vi.fn();
    render(
      <EscrowMonitorView {...monitorProps({ blockchainReady: false, onProceedToSettlement })} />,
    );
    fireEvent.click(settleButton());
    expect(onProceedToSettlement).not.toHaveBeenCalled();
  });

  it("enables settlement once the chain is configured", () => {
    const onProceedToSettlement = vi.fn();
    render(
      <EscrowMonitorView {...monitorProps({ blockchainReady: true, onProceedToSettlement })} />,
    );

    expect(screen.queryByText(/Blockchain not configured/i)).toBeNull();
    expect((settleButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(settleButton());
    expect(onProceedToSettlement).toHaveBeenCalled();
  });

  it("leaves the conditions checklist working without any chain config", () => {
    // The core promise of graceful degradation: everything that is not
    // settlement carries on. The checklist still renders and still reports.
    render(<EscrowMonitorView {...monitorProps({ blockchainReady: false })} />);
    expect(screen.getByText(/All conditions met/i)).toBeTruthy();
  });
});
