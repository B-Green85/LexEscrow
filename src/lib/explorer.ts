/**
 * Block-explorer links, resolved against the configured chain.
 *
 * Six screens used to hardcode `https://sepolia.etherscan.io/tx/…`, which was
 * correct only for as long as this install pointed at Sepolia. The moment the
 * vault holds a mainnet config, every one of those links sends the operator to
 * a testnet explorer that reports "transaction not found" for a settlement that
 * really happened — the worst possible answer, because it looks like evidence
 * the money never moved.
 *
 * The chain ID lives here as module state rather than being threaded through
 * every component: these are presentation-layer links in leaf components, and a
 * prop drilled through six trees to reach an `<a href>` would be a lot of
 * plumbing for one string. `setExplorerChain` is called from the session store
 * when the vault's blockchain config loads.
 *
 * The default stays Sepolia — the network this build has always targeted — so
 * an unconfigured vault renders exactly what it rendered before.
 */

const SEPOLIA = 11155111;

const EXPLORERS: Record<number, { base: string; name: string }> = {
  1: { base: "https://etherscan.io", name: "Etherscan" },
  [SEPOLIA]: { base: "https://sepolia.etherscan.io", name: "Sepolia Etherscan" },
};

let chainId: number = SEPOLIA;

/**
 * Point subsequent links at `id`.
 *
 * An unknown chain ID is ignored rather than accepted: falling back to a
 * generic explorer would produce confidently wrong links, and keeping the last
 * known-good chain at least keeps them internally consistent.
 */
export function setExplorerChain(id: number | null | undefined): void {
  if (typeof id === "number" && EXPLORERS[id]) chainId = id;
}

/** Current chain ID, for callers that need to branch on it. */
export function explorerChainId(): number {
  return chainId;
}

/** Human-readable explorer name, e.g. for link titles. */
export function explorerName(): string {
  return EXPLORERS[chainId]?.name ?? EXPLORERS[SEPOLIA].name;
}

function base(): string {
  return (EXPLORERS[chainId] ?? EXPLORERS[SEPOLIA]).base;
}

/** Explorer URL for a transaction hash. */
export function txUrl(hash: string): string {
  return `${base()}/tx/${hash}`;
}

/** Explorer URL for an address (contract or wallet). */
export function addressUrl(address: string): string {
  return `${base()}/address/${address}`;
}

/** Reset to the default chain. Test-support only. */
export function resetExplorerChain(): void {
  chainId = SEPOLIA;
}
