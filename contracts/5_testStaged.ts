// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Test Path C — StagedRelease end-to-end on Sepolia.
 *
 * Records a three-milestone schedule against a session id, then releases each
 * milestone in turn and asserts the on-chain tally after every step. Needs the
 * escrow funded with at least the deposit total (`npm run fund`).
 */
import { keccak256, toHex } from "viem";
import { clients, contractAddress, loadArtifact } from "./viemUtils";

async function main() {
  const { walletClient, publicClient, account } = clients();
  const contract = contractAddress();
  const { abi } = loadArtifact();

  const sessionId = keccak256(toHex(`lexescrow-demo-staged-${Date.now()}`));
  // 6.00 USDC across three milestones — amounts must exhaust the deposit.
  const milestones = [2_000_000n, 3_000_000n, 1_000_000n];
  const total = milestones.reduce((a, b) => a + b, 0n);

  const progress = async () =>
    (await publicClient.readContract({
      address: contract,
      abi,
      functionName: "stagedReleaseOf",
      args: [sessionId],
    })) as readonly [bigint, bigint, bigint, bigint];

  console.log(`stagedDeposit → total ${total}, ${milestones.length} milestones`);
  let hash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName: "stagedDeposit",
    args: [sessionId, total, BigInt(milestones.length)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log("deposited, tx:", hash);

  for (const [index, amount] of milestones.entries()) {
    console.log(`releaseMilestone ${index} → ${amount}`);
    hash = await walletClient.writeContract({
      address: contract,
      abi,
      functionName: "releaseMilestone",
      args: [sessionId, BigInt(index), account.address, amount],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const [, milestoneCount, releasedAmount, releasedCount] = await progress();
    console.log(
      `  status ${receipt.status} · released ${releasedAmount}/${total} · ` +
        `${releasedCount}/${milestoneCount} milestones · tx ${hash}`,
    );
  }

  const [totalAmount, , releasedAmount, releasedCount] = await progress();
  if (releasedAmount !== totalAmount || releasedCount !== BigInt(milestones.length)) {
    throw new Error(`staged release incomplete: ${releasedAmount}/${totalAmount}, ${releasedCount} milestones`);
  }

  // Re-releasing a paid milestone must revert (MilestoneAlreadyReleased).
  let rejected = false;
  try {
    await publicClient.simulateContract({
      account,
      address: contract,
      abi,
      functionName: "releaseMilestone",
      args: [sessionId, 0n, account.address, 1n],
    });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("double-release of milestone 0 was NOT rejected");
  console.log("double-release correctly rejected");

  console.log("\nStaged release complete.");
  console.log("Etherscan:", `https://sepolia.etherscan.io/tx/${hash}`);
}

main().catch((e) => {
  console.error("Staged release test failed:", e);
  process.exit(1);
});
