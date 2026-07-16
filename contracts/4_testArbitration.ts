/**
 * Test Path B — ArbitrationEscrow end-to-end on Sepolia.
 * Locks a disputed retainer, then exercises the 2-of-3 resolution.
 *
 * A full 2-of-3 release needs two DISTINCT party signatures, so set
 * SECOND_PRIVATE_KEY (a funded-for-gas key) — used as the firm party. Without
 * it the script locks and records one signature, then explains the rest.
 */
import { createWalletClient, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { clients, contractAddress, loadArtifact, rpcUrl } from "./viemUtils";

async function main() {
  const { walletClient, publicClient, account } = clients();
  const contract = contractAddress();
  const { abi } = loadArtifact();

  const second = process.env.SECOND_PRIVATE_KEY
    ? privateKeyToAccount(
        (process.env.SECOND_PRIVATE_KEY.startsWith("0x")
          ? process.env.SECOND_PRIVATE_KEY
          : `0x${process.env.SECOND_PRIVATE_KEY}`) as `0x${string}`,
      )
    : null;

  const clientWallet = account.address; // party 1 (deployer)
  const firmWallet = second ? second.address : account.address; // party 2
  const total = 5_000_000n; // 5.00 USDC locked
  const disputed = 1_000_000n; // 1.00 USDC disputed
  const documentHash = keccak256(toHex(`lexescrow-demo-arbitration-${Date.now()}`));

  console.log(`lockArbitration → total ${total}, disputed ${disputed}`);
  let hash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName: "lockArbitration",
    args: [clientWallet, firmWallet, total, documentHash, disputed],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log("locked, tx:", hash);

  // Proposed split: client $4.00, firm $1.00 (must equal across signers).
  const clientAmount = 4_000_000n;
  const firmAmount = 1_000_000n;

  console.log("resolveArbitration signature 1 (deployer / client)");
  hash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName: "resolveArbitration",
    args: [documentHash, clientAmount, firmAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  if (!second) {
    console.log(
      "\nOne signature recorded. Set SECOND_PRIVATE_KEY (a distinct funded party) to\n" +
        "cast the second signature and release the escrow (2-of-3).",
    );
    return;
  }

  const secondWallet = createWalletClient({ account: second, chain: sepolia, transport: http(rpcUrl()) });
  console.log("resolveArbitration signature 2 (second / firm) →", second.address);
  hash = await secondWallet.writeContract({
    address: contract,
    abi,
    functionName: "resolveArbitration",
    args: [documentHash, clientAmount, firmAmount],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("resolved (2-of-3), status:", receipt.status, "tx:", hash);
  console.log("Etherscan:", `https://sepolia.etherscan.io/tx/${hash}`);
}

main().catch((e) => {
  console.error("Arbitration test failed:", e);
  process.exit(1);
});
