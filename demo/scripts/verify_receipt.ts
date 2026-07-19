#!/usr/bin/env npx tsx
/**
 * LexEscrow Receipt Verification CLI
 * Usage: npx tsx verify_receipt.ts <path-to-receipt.json>
 *
 * The point of this script is that it is *small and standalone*. AnchorReceipt
 * (spec §8) promises a counterparty can verify a receipt offline, with no
 * access to the issuer's database and no LexEscrow install — so the verifier
 * has to be something they can read end to end and re-implement in an
 * afternoon. It imports nothing from `src/`: sharing the canonicalizer with the
 * issuer would make this a test of self-consistency rather than an independent
 * check.
 */

import { readFileSync } from "fs";
import { createHash } from "crypto";
import { pathToFileURL } from "url";

export interface VerificationResult {
  valid: boolean;
  claimedHash: string;
  computedHash: string;
  receipt: Record<string, unknown>;
}

/**
 * Canonical JSON — keys sorted at every depth, no incidental whitespace.
 *
 * Must agree byte-for-byte with `canonicalJson` in src/lib/anchor-receipt.ts,
 * including that arrays keep their order (item order is receipt content, not
 * incidental) and that the sort is recursive rather than top-level only.
 */
export function sortedJson(obj: unknown): string {
  if (typeof obj !== "object" || obj === null) return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(sortedJson).join(",") + "]";
  const sorted = Object.keys(obj as object)
    .sort()
    .reduce(
      (acc, k) => {
        acc[k] = sortedJson((obj as Record<string, unknown>)[k]);
        return acc;
      },
      {} as Record<string, string>,
    );
  return (
    "{" +
    Object.entries(sorted)
      .map(([k, v]) => JSON.stringify(k) + ":" + v)
      .join(",") +
    "}"
  );
}

/** SHA-256 over the receipt's canonical form, excluding its own hash. */
export function computeReceiptHash(receipt: Record<string, unknown>): string {
  const withoutHash = { ...receipt };
  delete withoutHash.receiptHash;
  return createHash("sha256").update(sortedJson(withoutHash)).digest("hex");
}

/**
 * Verify a receipt object. Any edit anywhere — a swapped fingerprint, an added
 * item, a rewritten timestamp — moves the computed hash away from the claimed
 * one, because the hash covers the whole canonical document.
 */
export function verifyReceipt(receipt: Record<string, unknown>): VerificationResult {
  const claimedHash = String(receipt.receiptHash ?? "");
  const computedHash = computeReceiptHash(receipt);
  return { valid: computedHash === claimedHash, claimedHash, computedHash, receipt };
}

export function verifyReceiptFile(path: string): VerificationResult {
  return verifyReceipt(JSON.parse(readFileSync(path, "utf-8")));
}

function main(argv: string[]): number {
  const receiptPath = argv[2];
  if (!receiptPath) {
    console.error("Usage: npx tsx verify_receipt.ts <receipt.json>");
    return 1;
  }

  let result: VerificationResult;
  try {
    result = verifyReceiptFile(receiptPath);
  } catch (e) {
    // "This is not a receipt" is a different answer from "this receipt was
    // tampered with", so the two must not collapse into one failure message.
    console.error(`\n❌ Could not read ${receiptPath}: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  }

  const { receipt, claimedHash, computedHash, valid } = result;
  const items = receipt.items as Array<Record<string, unknown>> | undefined;

  console.log("\n── LexEscrow Receipt Verification ──────────────────");
  console.log("Receipt ID:    ", receipt.receiptId ?? "N/A");
  console.log("Issued at:     ", receipt.issuedAt ?? "N/A");
  console.log("Asset class:   ", receipt.assetClass ?? "N/A");
  console.log("");
  console.log("Claimed hash:  ", claimedHash || "(absent)");
  console.log("Computed hash: ", computedHash);
  console.log("");

  if (!valid) {
    console.log("❌ INVALID — Receipt hash mismatch. This receipt may have been tampered with.");
    console.log("────────────────────────────────────────────────────\n");
    return 1;
  }

  console.log("✅ VALID — Receipt hash verified. This receipt has not been tampered with.");
  const onChainTx = items?.[0]?.onChainTx;
  if (onChainTx) {
    console.log("");
    console.log("On-chain TX:   ", onChainTx);
    console.log("Verify at:      https://sepolia.etherscan.io/tx/" + onChainTx);
  }
  console.log("────────────────────────────────────────────────────\n");
  return 0;
}

// Run only when invoked directly, so the pure functions above can be imported
// by tests without the CLI firing on import.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(main(process.argv));
}
