// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Test Path A — DirectSettlement end-to-end on Sepolia.
 * Calls directSettle (deployer = workflow) and checks the USDC movement.
 * Requires the escrow to be funded first (2_fundEscrow.ts).
 */
import { keccak256, toHex } from "viem";
import { clients, contractAddress, loadArtifact, usdcAddress, ERC20_ABI } from "./viemUtils";

async function main() {
  const { walletClient, publicClient, account } = clients();
  const contract = contractAddress();
  const { abi } = loadArtifact();
  const usdc = usdcAddress();

  // Demo split: client $4.20 unearned, firm $0.80 earned (USDC, 6 decimals).
  // Both paid to the deployer here so the test is self-contained.
  const clientWallet = account.address;
  const firmWallet = account.address;
  const clientAmount = 4_200_000n; // 4.20 USDC
  const firmAmount = 800_000n; // 0.80 USDC
  const documentHash = keccak256(toHex("lexescrow-demo-settle"));

  const escrowBefore = await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [contract] });
  const meBefore = await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });

  console.log(`directSettle → client ${clientAmount} + firm ${firmAmount} (base units)`);
  const hash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName: "directSettle",
    args: [clientWallet, firmWallet, clientAmount, firmAmount, documentHash],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("status:", receipt.status, "tx:", hash);

  const escrowAfter = await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [contract] });
  const meAfter = await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  console.log("escrow USDC delta:", (escrowAfter - escrowBefore).toString());
  console.log("recipient USDC delta:", (meAfter - meBefore).toString());
  console.log("Etherscan:", `https://sepolia.etherscan.io/tx/${hash}`);
}

main().catch((e) => {
  console.error("Settle test failed:", e);
  process.exit(1);
});
