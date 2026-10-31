// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Fund the deployed RetainerRelease escrow with test USDC so it can settle.
 * Amount (whole USDC) via FUND_AMOUNT env, default 6.
 */
import { clients, contractAddress, usdcAddress, ERC20_ABI } from "./viemUtils";

const AMOUNT_USDC = process.env.FUND_AMOUNT ? Number(process.env.FUND_AMOUNT) : 6;

async function main() {
  const { walletClient, publicClient, account } = clients();
  const contract = contractAddress();
  const usdc = usdcAddress();

  const decimals = await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "decimals" });
  const amount = BigInt(Math.round(AMOUNT_USDC * 10 ** Number(decimals)));

  console.log(`Funding escrow ${contract} with ${AMOUNT_USDC} USDC (${amount} base units) from ${account.address}`);
  const hash = await walletClient.writeContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [contract, amount],
  });
  console.log("transfer tx:", hash);
  await publicClient.waitForTransactionReceipt({ hash });

  const balance = await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [contract] });
  console.log("escrow USDC balance:", balance.toString());
}

main().catch((e) => {
  console.error("Fund failed:", e);
  process.exit(1);
});
