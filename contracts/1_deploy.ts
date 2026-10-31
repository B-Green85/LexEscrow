// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Deploy RetainerRelease to Ethereum Sepolia.
 *
 * Requires contracts/.env: CRE_ETH_PRIVATE_KEY (funded), SEPOLIA_RPC.
 * Writes the deployed address into cre/config.json (evms[0].retainerReleaseAddress).
 */
import * as fs from "fs";
import { join } from "path";
import { clients, loadArtifact, usdcAddress, arbitratorAddress, forwarderAddress } from "./viemUtils";

async function main() {
  const { walletClient, publicClient, account } = clients();
  const { abi, bytecode } = loadArtifact();
  const usdc = usdcAddress();
  const arbitrator = arbitratorAddress(account.address);
  const forwarder = forwarderAddress();

  console.log(`Deploying RetainerRelease to Ethereum Sepolia from ${account.address}`);
  console.log(`  forwarder  = ${forwarder}`);
  console.log(`  usdc       = ${usdc}`);
  console.log(`  arbitrator = ${arbitrator}`);

  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [forwarder, usdc, arbitrator],
  });
  console.log("deploy tx:", hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress;
  if (!address) throw new Error("no contract address in receipt");
  console.log(`RetainerRelease deployed at ${address} (block ${receipt.blockNumber})`);

  // Point the CRE workflow at the deployed contract.
  const cfgPath = join(process.cwd(), "..", "cre", "config.json");
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg?.evms?.[0]) {
      cfg.evms[0].retainerReleaseAddress = address;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
      console.log("→ updated cre/config.json (evms[0].retainerReleaseAddress)");
    }
  }

  console.log(`\nAdd to contracts/.env:   CONTRACT_ADDRESS=${address}`);
  console.log(`Etherscan:               https://sepolia.etherscan.io/address/${address}#code`);
}

main().catch((e) => {
  console.error("Deploy failed:", e);
  process.exit(1);
});
