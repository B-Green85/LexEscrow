// @vitest-environment jsdom
/**
 * Plain-English help on the blockchain step — wizard and Configuration.
 *
 * The claim under test is not "a tooltip component exists" (that is
 * `info-tooltip.test.tsx`); it is that the *same* help reaches an operator in
 * both of the two places they can be asked for a private key. The wizard and
 * the Configuration card were written separately and drifted once already,
 * which is why `SEPOLIA_DEFAULTS` and the secret inputs are shared — this suite
 * holds the same line for the copy.
 *
 * The escalating private key warning is asserted through real focus and blur
 * rather than by rendering the panel directly, because the whole point of it is
 * *when* it appears. A panel that renders correctly but never escalates would
 * pass a snapshot test and fail the operator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SetupWizard } from "./SetupWizard";
import { BlockchainCard } from "./Configuration";
import { BLOCKCHAIN_TOOLTIPS } from "../components/blockchainHelp";
import { useSession } from "../store/session";
import * as browserVault from "../lib/browserVault";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

beforeEach(() => {
  browserVault.lock();
  useSession.setState({ showWizard: false, wizardComplete: false });
});

afterEach(() => {
  cleanup();
  browserVault.lock();
  vi.clearAllMocks();
});

const button = (name: RegExp | string) => screen.getByRole("button", { name });

/** An open tooltip popover, by the field title it explains. */
const popover = (title: string) => screen.getByRole("dialog", { name: title });

/** Walk the wizard to step 4, the blockchain step. */
async function wizardToBlockchain() {
  render(<SetupWizard />);
  fireEvent.click(button(/Get Started/));
  fireEvent.change(screen.getByLabelText(/^Vault password$/), {
    target: { value: "correct-horse-battery" },
  });
  fireEvent.change(screen.getByLabelText(/^Confirm password$/), {
    target: { value: "correct-horse-battery" },
  });
  fireEvent.click(button(/Create Vault/));
  await screen.findByText(/Configure AI Provider/);
  fireEvent.click(button(/Skip — Use Manual Entry/));
  await screen.findByText(/Configure Blockchain Settlement/);
}

/** Open the Configuration card's edit form, where the fields live. */
function configurationEditing() {
  render(<BlockchainCard data={null} refresh={vi.fn()} />);
  fireEvent.click(button("Add"));
}

/** Every field on the step, paired with the tip that should explain it. */
const FIELDS = [
  ["networkName", "Network Name"],
  ["chainId", "Chain ID"],
  ["rpcUrl", "RPC URL — Your Blockchain Gateway"],
  ["contractAddress", "LexEscrow Contract Address"],
  ["deployerAddress", "Your Wallet Address (Public)"],
  ["deployerPrivateKey", "Your Wallet Private Key (Keep Secret)"],
  ["usdcAddress", "USDC Token Contract"],
  ["forwarderAddress", "Chainlink Forwarder Address"],
] as const;

// ── Tooltips reach both screens ──────────────────────────────────────────────

describe("blockchain field tooltips", () => {
  it.each(FIELDS)("explains %s in the wizard", async (key, title) => {
    await wizardToBlockchain();

    const tip = screen.getByRole("button", { name: `More information: ${title}` });
    fireEvent.click(tip);

    // Named, because the wizard shell is itself a dialog — the popover has to
    // be identifiable rather than merely present.
    expect(popover(title).textContent).toContain(BLOCKCHAIN_TOOLTIPS[key].explanation);
  });

  it.each(FIELDS)("explains %s in Configuration", (key, title) => {
    configurationEditing();

    const tip = screen.getByRole("button", { name: `More information: ${title}` });
    fireEvent.click(tip);

    expect(popover(title).textContent).toContain(BLOCKCHAIN_TOOLTIPS[key].explanation);
  });

  it("sends an operator who needs an RPC URL somewhere they can get one", async () => {
    await wizardToBlockchain();
    fireEvent.click(
      screen.getByRole("button", { name: /More information: RPC URL/ }),
    );

    expect(screen.getByRole("button", { name: /Learn more/i })).toBeTruthy();
    expect(BLOCKCHAIN_TOOLTIPS.rpcUrl.learnMore).toBe("https://www.alchemy.com");
  });

  it("leaves every field reachable by its own label", async () => {
    // The ⓘ sits beside the label, not inside it. If that inverts, the field
    // labels stop resolving — here and in `blockchain-config.test.tsx`.
    await wizardToBlockchain();

    expect(screen.getByLabelText(/^Network name$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Chain ID$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Deployer private key$/)).toBeTruthy();
  });
});

// ── Wallet setup guide ───────────────────────────────────────────────────────

describe("wallet setup guide", () => {
  it("offers the guide on the wizard blockchain step, collapsed", async () => {
    await wizardToBlockchain();

    const summary = screen.getByText(/Don't have a wallet yet\? — Setup guide/);
    expect(summary).toBeTruthy();
    // Collapsed by default — an operator with a funded wallet sees one line.
    expect(summary.closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("offers the same guide on the Configuration card", () => {
    configurationEditing();

    expect(screen.getByText(/Don't have a wallet yet\? — Setup guide/)).toBeTruthy();
  });

  it("walks through wallet, test ETH, test USDC and then the form", async () => {
    await wizardToBlockchain();

    expect(screen.getByText(/^Get a wallet$/)).toBeTruthy();
    expect(screen.getByText(/^Get testnet ETH \(for testing\)$/)).toBeTruthy();
    expect(screen.getByText(/^Get testnet USDC \(for testing\)$/)).toBeTruthy();
    expect(screen.getByText(/^Enter your details above$/)).toBeTruthy();
  });

  it("links to MetaMask", async () => {
    await wizardToBlockchain();
    expect(screen.getByRole("button", { name: /metamask\.io/i })).toBeTruthy();
  });

  it("links to the Sepolia and Circle faucets", async () => {
    await wizardToBlockchain();

    expect(screen.getByRole("button", { name: /Sepolia Faucet/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Circle Faucet/i })).toBeTruthy();
  });

  it("opens links in the operator's browser rather than the app window", async () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    await wizardToBlockchain();

    fireEvent.click(screen.getByRole("button", { name: /metamask\.io/i }));

    expect(windowOpen).toHaveBeenCalledWith(
      "https://metamask.io",
      "_blank",
      "noopener,noreferrer",
    );
    windowOpen.mockRestore();
  });
});

// ── The escalating private key warning ───────────────────────────────────────

const COLLAPSED = /controls fund movement on-chain/i;
const EXPANDED = /Private Key Safety Rules/i;

describe("private key warning", () => {
  it("starts as a one-line caution in the wizard", async () => {
    await wizardToBlockchain();

    expect(screen.getByText(COLLAPSED)).toBeTruthy();
    expect(screen.queryByText(EXPANDED)).toBeNull();
  });

  it("escalates to the full rules when the key field takes focus", async () => {
    await wizardToBlockchain();
    fireEvent.focus(screen.getByLabelText(/^Deployer private key$/));

    expect(screen.getByText(EXPANDED)).toBeTruthy();
    expect(screen.getByText(/Never share this with anyone/i)).toBeTruthy();
    expect(screen.getByText(/create a new wallet immediately/i)).toBeTruthy();
    expect(screen.queryByText(COLLAPSED)).toBeNull();
  });

  it("stays escalated while a key is in the field, even unfocused", async () => {
    await wizardToBlockchain();
    const field = screen.getByLabelText(/^Deployer private key$/);

    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "0x" + "1".repeat(64) } });
    fireEvent.blur(field);

    // Blurring does not make the key on screen any less dangerous.
    expect(screen.getByText(EXPANDED)).toBeTruthy();
  });

  it("collapses once the field is cleared and left", async () => {
    await wizardToBlockchain();
    const field = screen.getByLabelText(/^Deployer private key$/);

    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "0x" + "1".repeat(64) } });
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);

    expect(screen.getByText(COLLAPSED)).toBeTruthy();
    expect(screen.queryByText(EXPANDED)).toBeNull();
  });

  it("escalates the same way on the Configuration card", () => {
    configurationEditing();
    expect(screen.getByText(COLLAPSED)).toBeTruthy();

    fireEvent.focus(screen.getByLabelText(/^Deployer private key$/));
    expect(screen.getByText(EXPANDED)).toBeTruthy();
  });

  it("still warns on the Configuration summary, where there is no field", () => {
    // Not editing: nothing to focus, but a stored key is still a custodial
    // responsibility, so the caution stays on screen.
    render(<BlockchainCard data={null} refresh={vi.fn()} />);

    expect(screen.getByText(COLLAPSED)).toBeTruthy();
    expect(screen.queryByText(EXPANDED)).toBeNull();
  });

  it("names no real key material anywhere in the copy", () => {
    // A guide that ships an example private key is a guide someone will paste.
    const copy = Object.values(BLOCKCHAIN_TOOLTIPS)
      .map((t) => t.explanation)
      .join(" ");

    expect(copy).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(copy).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});
