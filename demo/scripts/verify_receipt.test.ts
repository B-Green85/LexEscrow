/**
 * Receipt verifier tests.
 *
 * This verifier is deliberately standalone — it shares no code with `src/`,
 * because it stands in for what a counterparty runs offline (spec §8). So the
 * central test is not that it agrees with itself: it is that its canonical form
 * agrees **byte-for-byte** with the issuer's `canonicalJson`. If those two ever
 * diverge, every receipt LexEscrow issues becomes unverifiable by the only
 * tool a counterparty has, and nothing else in the suite would notice.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterAll, describe, expect, it } from "vitest";
import { sortedJson, computeReceiptHash, verifyReceipt } from "./verify_receipt";
import { canonicalJson } from "../../src/lib/anchor-receipt";

const SCRIPT = fileURLToPath(new URL("./verify_receipt.ts", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "lexescrow-receipt-"));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** A receipt in the shape `issueReceipt` produces, minus its hash. */
function unhashedReceipt() {
  return {
    receiptId: "b1f0c2d4-1111-4222-8333-444455556666",
    issuedAt: "2026-07-18T12:00:00.000Z",
    assertionType: "escrow_document_registration",
    transactionId: "wf-1234",
    assetClass: "legal",
    summary: { overallStatus: "verified_all", verifiedCount: 1, totalCount: 1 },
    items: [
      {
        label: "retainer_agreement_demo.txt",
        hmac: "DEMO-HMAC-abc12345",
        hash: "sha256:deadbeefcafe",
        size: 4096,
        registered: true,
        registeredAt: "2026-07-18T12:00:00.000Z",
        onChainTx: "0xanchor-abc12345-18f3c",
      },
    ],
    assertionText:
      "As of the issued timestamp, the above document fingerprints were verified " +
      "against the LexEscrow AnchorReceipt registry.",
  };
}

/** A complete, self-consistent receipt. */
function validReceipt() {
  const unhashed = unhashedReceipt();
  return { ...unhashed, receiptHash: computeReceiptHash(unhashed) };
}

function writeReceipt(name: string, receipt: unknown): string {
  const path = join(workDir, name);
  writeFileSync(path, JSON.stringify(receipt, null, 2));
  return path;
}

/** Run the CLI, returning its exit code and combined output. */
function runCli(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync("npx", ["tsx", SCRIPT, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("sortedJson", () => {
  it("produces identical output regardless of key order", () => {
    const a = { zeta: 1, alpha: 2, mid: { z: 9, a: 8 } };
    const b = { mid: { a: 8, z: 9 }, alpha: 2, zeta: 1 };
    expect(sortedJson(a)).toBe(sortedJson(b));
  });

  it("sorts recursively, not just at the top level", () => {
    // A top-level-only canonicalizer would let nested reordering slip through,
    // and item fields are exactly where a tamperer would work.
    const a = { items: [{ hash: "x", label: "a" }] };
    const b = { items: [{ label: "a", hash: "x" }] };
    expect(sortedJson(a)).toBe(sortedJson(b));
    expect(sortedJson(a)).toBe('{"items":[{"hash":"x","label":"a"}]}');
  });

  it("preserves array order, which is receipt content", () => {
    expect(sortedJson([1, 2])).not.toBe(sortedJson([2, 1]));
  });

  it("agrees byte-for-byte with the issuer's canonicalJson", () => {
    const receipt = unhashedReceipt();
    expect(sortedJson(receipt)).toBe(canonicalJson(receipt));
  });

  it("agrees with the issuer on primitives and nesting edge cases", () => {
    for (const value of [null, 0, -1.5, "", "quote\"and\\slash", true, [], {}, [[{ a: [1] }]]]) {
      expect(sortedJson(value)).toBe(canonicalJson(value));
    }
  });
});

describe("verifyReceipt", () => {
  it("accepts a valid receipt", () => {
    const result = verifyReceipt(validReceipt());
    expect(result.valid).toBe(true);
    expect(result.computedHash).toBe(result.claimedHash);
  });

  it("detects a tampered receiptHash", () => {
    const receipt = { ...validReceipt(), receiptHash: "0".repeat(64) };
    const result = verifyReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.claimedHash).toBe("0".repeat(64));
  });

  it("detects modified item data", () => {
    const receipt = validReceipt();
    receipt.items[0].hash = "sha256:0000000000000";
    expect(verifyReceipt(receipt).valid).toBe(false);
  });

  it("detects an added item", () => {
    const receipt = validReceipt();
    receipt.items.push({ ...receipt.items[0], label: "smuggled.txt" });
    expect(verifyReceipt(receipt).valid).toBe(false);
  });

  it("detects a rewritten timestamp", () => {
    const receipt = validReceipt();
    receipt.issuedAt = "2020-01-01T00:00:00.000Z";
    expect(verifyReceipt(receipt).valid).toBe(false);
  });

  it("treats a missing hash as invalid rather than absent", () => {
    const receipt = unhashedReceipt() as Record<string, unknown>;
    const result = verifyReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.claimedHash).toBe("");
  });
});

describe("CLI", () => {
  it("exits 0 and reports VALID for a good receipt", () => {
    const path = writeReceipt("valid.json", validReceipt());
    const { code, output } = runCli([path]);
    expect(code).toBe(0);
    expect(output).toContain("✅ VALID");
    expect(output).toContain("https://sepolia.etherscan.io/tx/0xanchor-abc12345-18f3c");
  });

  it("exits 1 and reports INVALID for a tampered receipt", () => {
    const path = writeReceipt("tampered.json", { ...validReceipt(), receiptHash: "f".repeat(64) });
    const { code, output } = runCli([path]);
    expect(code).toBe(1);
    expect(output).toContain("❌ INVALID");
  });

  it("exits 1 with usage when given no argument", () => {
    const { code, output } = runCli([]);
    expect(code).toBe(1);
    expect(output).toContain("Usage:");
  });

  it("distinguishes an unreadable file from a tampered one", () => {
    const path = join(workDir, "not-json.json");
    writeFileSync(path, "this is not JSON");
    const { code, output } = runCli([path]);
    expect(code).toBe(1);
    expect(output).toContain("Could not read");
    expect(output).not.toContain("INVALID");
  });
});
