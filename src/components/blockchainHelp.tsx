/**
 * Plain-English help for the blockchain settlement fields.
 *
 * The wizard and the Configuration card ask for the same eight values, so the
 * copy explaining them lives here rather than in either screen. That is the
 * same reasoning that already puts `SEPOLIA_DEFAULTS` and the secret inputs in
 * one place: a second copy of "which of these is safe to share" is a copy that
 * drifts, and the version that drifts is the one an operator reads right before
 * pasting a private key somewhere.
 *
 * The audience is a solo practitioner, not a protocol engineer. Every
 * explanation answers "what is this, where do I get it, and can I break
 * something" — in that order, and without assuming the reader knows what an RPC
 * endpoint is.
 */

import type { InfoTooltipProps } from "./InfoTooltip";
import { openExternal } from "./InfoTooltip";

type Tip = Omit<InfoTooltipProps, "children">;

export const BLOCKCHAIN_TOOLTIPS = {
  networkName: {
    title: "Network Name",
    explanation:
      "The blockchain network LexEscrow settles on. 'Ethereum Sepolia' is the test network — free to use, no real money. Switch to 'Ethereum Mainnet' only for real client transactions.",
  },
  chainId: {
    title: "Chain ID",
    explanation:
      "A number that identifies the blockchain network. Sepolia testnet is 11155111. Ethereum mainnet is 1. This is set automatically when you use the Sepolia defaults button — you don't need to change it manually.",
  },
  rpcUrl: {
    title: "RPC URL — Your Blockchain Gateway",
    explanation:
      "This is your personal connection to the Ethereum network. Get one free at alchemy.com: create an account, create an app for 'Ethereum Sepolia', and copy the HTTPS URL. It will look like:\nhttps://eth-sepolia.g.alchemy.com/v2/your-key-here",
    learnMore: "https://www.alchemy.com",
  },
  contractAddress: {
    title: "LexEscrow Contract Address",
    explanation:
      "The address of LexEscrow's smart contract on the blockchain — pre-filled when you use Sepolia defaults. This is where escrow funds are held. Do not change this unless you have deployed your own contract.",
  },
  deployerAddress: {
    title: "Your Wallet Address (Public)",
    explanation:
      "Your Ethereum wallet's public address — starts with 0x followed by 40 characters. This is like your account number. Safe to share. If you don't have a wallet yet, see the wallet setup guide below.",
  },
  deployerPrivateKey: {
    title: "Your Wallet Private Key (Keep Secret)",
    explanation:
      "The secret key that proves you own your wallet and authorizes fund releases on-chain. In MetaMask: click the three dots → Account Details → Export Private Key. LexEscrow encrypts this immediately with AES-256-GCM — it never leaves your device unencrypted.",
  },
  usdcAddress: {
    title: "USDC Token Contract",
    explanation:
      "The address of the USDC stablecoin on this network. LexEscrow settles in USDC to avoid price swings — $1 in always equals $1 out. Pre-filled for Sepolia testnet. Do not change this.",
  },
  forwarderAddress: {
    title: "Chainlink Forwarder Address",
    explanation:
      "A Chainlink infrastructure contract that routes settlement instructions from LexEscrow to the blockchain. Pre-filled for Sepolia testnet. Do not change this unless you are deploying to a different network.",
  },
} satisfies Record<string, Tip>;

// ── Wallet setup guide ───────────────────────────────────────────────────────

/** A link that leaves the app — see `openExternal` for why it is not an `<a>`. */
function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <button
      type="button"
      onClick={() => void openExternal(href)}
      className="mt-1 cursor-pointer text-xs font-medium text-[#60A5FA] hover:underline"
    >
      {children}
    </button>
  );
}

function GuideStep({ n, title, body, children }: {
  n: number;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#B45309] text-xs font-bold text-white">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-200">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{body}</p>
        {children}
      </div>
    </li>
  );
}

/**
 * "Don't have a wallet yet?" — the step before the form.
 *
 * Collapsed by default and built on `<details>`: an operator who already has a
 * funded wallet should see one line, not four steps of onboarding, and the
 * native element gets keyboard operation and the disclosure semantics for free.
 */
export function WalletSetupGuide() {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-sm font-medium text-[#60A5FA] hover:underline">
        🔑 Don't have a wallet yet? — Setup guide
      </summary>

      <ol className="mt-2 space-y-4 rounded-lg border border-[#1A2435] bg-[#0A0F1A] p-4">
        <GuideStep
          n={1}
          title="Get a wallet"
          body="Download MetaMask (free) — the most widely used Ethereum wallet."
        >
          <ExternalLink href="https://metamask.io">metamask.io →</ExternalLink>
        </GuideStep>
        <GuideStep
          n={2}
          title="Get testnet ETH (for testing)"
          body="You need a small amount of free 'test ETH' to pay for blockchain transactions. It has no real value."
        >
          <ExternalLink href="https://sepoliafaucet.com">Sepolia Faucet →</ExternalLink>
        </GuideStep>
        <GuideStep
          n={3}
          title="Get testnet USDC (for testing)"
          body="LexEscrow holds funds in USDC. Get free test USDC from Circle's faucet."
        >
          <ExternalLink href="https://faucet.circle.com">Circle Faucet →</ExternalLink>
        </GuideStep>
        <GuideStep
          n={4}
          title="Enter your details above"
          body="Once your wallet is set up, paste your wallet address and export your private key into the fields above."
        />
      </ol>
    </details>
  );
}

// ── Private key warning ──────────────────────────────────────────────────────

const RULES = [
  "Never share this with anyone — not support, not us, no one",
  "Anyone with this key can move all funds in your wallet",
  "LexEscrow encrypts it immediately — never leaves your device",
  "If you think it was exposed, create a new wallet immediately",
  "In MetaMask: ··· → Account Details → Export Private Key",
];

/**
 * The standing amber banner, escalating to the full rules panel.
 *
 * `expanded` is driven by focus-or-content on the private key field rather than
 * being always-on. The full list is five lines; shown permanently it becomes
 * furniture, and the one moment it has to be read is the moment a key is on the
 * clipboard. The collapsed form still states the whole risk in a sentence, so
 * an operator who never touches the field is not left uninformed.
 */
export function PrivateKeyWarning({ expanded }: { expanded: boolean }) {
  if (!expanded) {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-400">
        ⚠️ Your deployer private key controls fund movement on-chain. Never share it. It is the
        most sensitive credential in LexEscrow — encrypted in your vault and never transmitted
        anywhere.
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="rounded-md border border-red-800 bg-red-950 px-3 py-2.5 text-xs leading-relaxed text-red-100"
    >
      <p className="font-semibold">🔴 Private Key Safety Rules</p>
      <ul className="mt-1.5 space-y-1">
        {RULES.map((rule) => (
          <li key={rule} className="flex gap-1.5">
            <span aria-hidden="true" className="text-red-400">
              ·
            </span>
            <span>{rule}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
