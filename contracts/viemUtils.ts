import { createPublicClient, createWalletClient, http, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import * as dotenv from "dotenv";
import * as fs from "fs";
import { join } from "path";

dotenv.config({ path: join(process.cwd(), ".env") });

// USDC on Ethereum Sepolia.
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Chainlink CRE KeystoneForwarder that may call `onReport` — network-specific.
 * Supplied via FORWARDER_ADDRESS in contracts/.env; there is no default because
 * a wrong forwarder silently breaks report verification. Verify the Ethereum
 * Sepolia address against the Forwarder Directory:
 * https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts
 * (the owner can also correct it post-deploy via setForwarderAddress).
 */
export function forwarderAddress(): `0x${string}` {
  const f = process.env.FORWARDER_ADDRESS;
  if (!f || !f.startsWith("0x") || f.length !== 42) {
    throw new Error(
      "FORWARDER_ADDRESS not set in contracts/.env — set the Base Sepolia CRE " +
        "KeystoneForwarder (see the Forwarder Directory) before deploying.",
    );
  }
  return f as `0x${string}`;
}

function requireKey(name: string): `0x${string}` {
  const pk = process.env[name];
  if (!pk) throw new Error(`${name} not set in contracts/.env`);
  return (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
}

export function account(name = "CRE_ETH_PRIVATE_KEY") {
  return privateKeyToAccount(requireKey(name));
}

export function rpcUrl(): string {
  const url = process.env.SEPOLIA_RPC;
  if (!url) throw new Error("SEPOLIA_RPC not set in contracts/.env");
  return url;
}

export function usdcAddress(): `0x${string}` {
  return (process.env.USDC_ADDRESS || SEPOLIA_USDC) as `0x${string}`;
}

export function arbitratorAddress(fallback: `0x${string}`): `0x${string}` {
  const a = process.env.ARBITRATOR_ADDRESS;
  return a && a.length ? (a as `0x${string}`) : fallback;
}

/** Resolve the deployed contract address from .env, else cre/config.json. */
export function contractAddress(): `0x${string}` {
  const fromEnv = process.env.CONTRACT_ADDRESS;
  if (fromEnv && fromEnv.startsWith("0x") && fromEnv.length === 42) return fromEnv as `0x${string}`;

  const cfgPath = join(process.cwd(), "..", "cre", "config.json");
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const addr = cfg?.evms?.[0]?.retainerReleaseAddress;
    if (addr && addr.startsWith("0x") && addr.length === 42 && addr !== ZERO) return addr;
  }
  throw new Error("CONTRACT_ADDRESS not set — deploy first, or set it in contracts/.env");
}

export function clients(keyName = "CRE_ETH_PRIVATE_KEY") {
  const acct = account(keyName);
  const url = rpcUrl();
  return {
    account: acct,
    walletClient: createWalletClient({ account: acct, chain: sepolia, transport: http(url) }),
    publicClient: createPublicClient({ chain: sepolia, transport: http(url) }),
  };
}

/** Load the solc-compiled ABI + bytecode from output/. */
export function loadArtifact(): { abi: Abi; bytecode: `0x${string}` } {
  const abiPath = join(process.cwd(), "output", "RetainerRelease.abi");
  const binPath = join(process.cwd(), "output", "RetainerRelease.bin");
  if (!fs.existsSync(abiPath) || !fs.existsSync(binPath)) {
    throw new Error("Compiled artifacts missing — run `npm run compile` first.");
  }
  const abi = JSON.parse(fs.readFileSync(abiPath, "utf8")) as Abi;
  let bin = fs.readFileSync(binPath, "utf8").trim();
  if (!bin.startsWith("0x")) bin = "0x" + bin;
  return { abi, bytecode: bin as `0x${string}` };
}

/** Minimal ERC-20 ABI for USDC interactions in the test scripts. */
export const ERC20_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
