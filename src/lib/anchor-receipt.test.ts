/**
 * AnchorReceipt integrity layer (spec §8).
 *
 * The property under test throughout is the one the layer exists to provide:
 * a receipt must be verifiable **offline**, by recomputation alone, and any
 * edit anywhere in it must break that recomputation. Tests that only checked
 * "issue then verify passes" would miss the half that matters — most of what
 * follows is tampering.
 *
 * The backend bridge is mocked so no Tauri IPC or SQLite is involved; the seal
 * is a fixed stand-in, exactly as the browser fallback produces.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSERTION_TEXT,
  ASSERTION_TYPE,
  canonicalJson,
  canonicalize,
  computeHmacSeal,
  computeReceiptHash,
  issueReceipt,
  registerOnChain,
  verifyReceipt,
  verifyReceiptFile,
  type AnchorReceipt,
  type UnhashedReceipt,
} from "./anchor-receipt";
import * as backend from "./backend";

vi.mock("./backend", () => ({
  computeHmacSeal: vi.fn().mockResolvedValue("DEMO-HMAC-abc12345"),
  saveRegisteredFingerprint: vi.fn().mockResolvedValue(undefined),
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

const HASH_A = "sha256:" + "a".repeat(64);
const HASH_B = "sha256:" + "b".repeat(64);

function issue(over: Partial<Parameters<typeof issueReceipt>[0]> = {}) {
  return issueReceipt({
    sessionId: "wf-001",
    assetClass: "legal",
    items: [{ label: "retainer.pdf", hash: HASH_A, size: 2048 }],
    ...over,
  });
}

/** Structured-clone a receipt so a test's tampering cannot leak between cases. */
function clone(receipt: AnchorReceipt): AnchorReceipt {
  return JSON.parse(JSON.stringify(receipt)) as AnchorReceipt;
}

function receiptFile(receipt: unknown, name = "anchor-receipt-test.json"): File {
  return new File([JSON.stringify(receipt, null, 2)], name, { type: "application/json" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Issuance ─────────────────────────────────────────────────────────────────

describe("issueReceipt", () => {
  it("returns a receipt with the full documented structure", async () => {
    const receipt = await issue();
    expect(receipt).toMatchObject({
      receiptId: expect.any(String),
      issuedAt: expect.any(String),
      assertionType: expect.any(String),
      transactionId: "wf-001",
      assetClass: "legal",
      assertionText: expect.any(String),
      receiptHash: expect.any(String),
    });
    expect(Array.isArray(receipt.items)).toBe(true);
  });

  it("sets assertionType to 'escrow_document_registration'", async () => {
    expect((await issue()).assertionType).toBe(ASSERTION_TYPE);
    expect(ASSERTION_TYPE).toBe("escrow_document_registration");
  });

  it("carries the spec §8 standard assertion text", async () => {
    const receipt = await issue();
    expect(receipt.assertionText).toBe(ASSERTION_TEXT);
    expect(receipt.assertionText).toContain("LexEscrow AnchorReceipt registry");
  });

  it("summary counts match the items array length", async () => {
    const receipt = await issue({
      items: [
        { label: "a.pdf", hash: HASH_A, size: 10 },
        { label: "b.pdf", hash: HASH_B, size: 20 },
        { label: "c.pdf", hash: HASH_A, size: 30 },
      ],
    });
    expect(receipt.items).toHaveLength(3);
    expect(receipt.summary.totalCount).toBe(3);
    expect(receipt.summary.verifiedCount).toBe(3);
  });

  it("reports verified_all when every item registered", async () => {
    expect((await issue()).summary.overallStatus).toBe("verified_all");
  });

  it("reports unverified for an empty item set", async () => {
    const receipt = await issue({ items: [] });
    expect(receipt.summary).toEqual({
      overallStatus: "unverified",
      verifiedCount: 0,
      totalCount: 0,
    });
  });

  it("receiptHash is a 64-character lowercase hex string", async () => {
    const { receiptHash } = await issue();
    expect(receiptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("populates hmac and onChainTx on every item", async () => {
    const receipt = await issue({
      items: [
        { label: "a.pdf", hash: HASH_A, size: 10 },
        { label: "b.pdf", hash: HASH_B, size: 20 },
      ],
    });
    for (const item of receipt.items) {
      expect(item.hmac).toBe("DEMO-HMAC-abc12345");
      expect(item.onChainTx).toMatch(/^0xanchor-/);
      expect(item.registered).toBe(true);
      expect(item.registeredAt).toEqual(expect.any(String));
    }
  });

  it("seals each item over its own hash and size", async () => {
    await issue({
      items: [
        { label: "a.pdf", hash: HASH_A, size: 10 },
        { label: "b.pdf", hash: HASH_B, size: 20 },
      ],
    });
    expect(backend.computeHmacSeal).toHaveBeenCalledTimes(2);
    expect(backend.computeHmacSeal).toHaveBeenCalledWith(HASH_A, 10);
    expect(backend.computeHmacSeal).toHaveBeenCalledWith(HASH_B, 20);
  });

  it("writes each fingerprint to the registry under the session and asset class", async () => {
    await issue({ assetClass: "cannabis_ind" });
    expect(backend.saveRegisteredFingerprint).toHaveBeenCalledWith(
      expect.objectContaining({
        hmac: "DEMO-HMAC-abc12345",
        sessionId: "wf-001",
        assetClass: "cannabis_ind",
        onChainTx: expect.stringMatching(/^0xanchor-/),
      }),
    );
  });

  it("carries CannaVerify fields through onto the item when supplied", async () => {
    const receipt = await issue({
      assetClass: "cannabis_ind",
      items: [
        {
          label: "license.pdf",
          hash: HASH_A,
          size: 512,
          cannaverifyLicenseStatus: "ACTIVE",
          cannaverifyComplianceHolds: 0,
        },
      ],
    });
    expect(receipt.items[0].cannaverifyLicenseStatus).toBe("ACTIVE");
    expect(receipt.items[0].cannaverifyComplianceHolds).toBe(0);
  });

  it("omits CannaVerify fields entirely for non-cannabis documents", async () => {
    const receipt = await issue();
    expect(receipt.items[0]).not.toHaveProperty("cannaverifyLicenseStatus");
    expect(receipt.items[0]).not.toHaveProperty("cannaverifyComplianceHolds");
  });

  it("does not fail a receipt when the registry write throws", async () => {
    vi.mocked(backend.saveRegisteredFingerprint).mockRejectedValueOnce(new Error("db offline"));
    const receipt = await issue();
    // The seal and the receipt hash are what make the receipt verifiable; a
    // lost index row must not cost the officer a usable receipt.
    expect(receipt.items[0].onChainTx).toMatch(/^0xanchor-/);
    expect((await verifyReceipt(receipt)).valid).toBe(true);
  });

  it("issues distinct receipt ids for separate registrations", async () => {
    const [a, b] = [await issue(), await issue()];
    expect(a.receiptId).not.toBe(b.receiptId);
  });
});

describe("computeHmacSeal / registerOnChain", () => {
  it("delegates sealing to the backend bridge", async () => {
    expect(await computeHmacSeal(HASH_A, 99)).toBe("DEMO-HMAC-abc12345");
    expect(backend.computeHmacSeal).toHaveBeenCalledWith(HASH_A, 99);
  });

  it("derives the mock tx from the seal", async () => {
    const tx = await registerOnChain("wf-1", "legal", "SEALVALUE123");
    expect(tx.startsWith("0xanchor-SEALVALU-")).toBe(true);
  });
});

// ── Verification ─────────────────────────────────────────────────────────────

describe("verifyReceipt", () => {
  it("returns valid: true for an unmodified receipt", async () => {
    expect((await verifyReceipt(await issue())).valid).toBe(true);
  });

  it("computedHash matches the claimed hash for a valid receipt", async () => {
    const result = await verifyReceipt(await issue());
    expect(result.computedHash).toBe(result.claimedHash);
  });

  it("claimedHash is exactly receipt.receiptHash", async () => {
    const receipt = await issue();
    expect((await verifyReceipt(receipt)).claimedHash).toBe(receipt.receiptHash);
  });

  it("returns valid: false when receiptHash itself is tampered with", async () => {
    const receipt = clone(await issue());
    receipt.receiptHash = "0".repeat(64);
    const result = await verifyReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.claimedHash).toBe("0".repeat(64));
    expect(result.computedHash).not.toBe(result.claimedHash);
  });

  it("returns valid: false when item data is modified", async () => {
    const receipt = clone(await issue());
    receipt.items[0].hash = HASH_B;
    expect((await verifyReceipt(receipt)).valid).toBe(false);
  });

  it("returns valid: false when an item's seal is swapped", async () => {
    const receipt = clone(await issue());
    receipt.items[0].hmac = "DEMO-HMAC-deadbeef";
    expect((await verifyReceipt(receipt)).valid).toBe(false);
  });

  it("returns valid: false when an item's size is altered", async () => {
    const receipt = clone(await issue());
    receipt.items[0].size = 4096;
    expect((await verifyReceipt(receipt)).valid).toBe(false);
  });

  it("returns valid: false when an extra item is appended", async () => {
    const receipt = clone(await issue());
    receipt.items.push({ ...receipt.items[0], label: "smuggled.pdf" });
    expect((await verifyReceipt(receipt)).valid).toBe(false);
  });

  it("returns valid: false when an item is removed", async () => {
    const receipt = clone(
      await issue({
        items: [
          { label: "a.pdf", hash: HASH_A, size: 10 },
          { label: "b.pdf", hash: HASH_B, size: 20 },
        ],
      }),
    );
    receipt.items.pop();
    expect((await verifyReceipt(receipt)).valid).toBe(false);
  });

  it("returns valid: false when the summary is inflated", async () => {
    const receipt = clone(await issue());
    receipt.summary.verifiedCount = 99;
    expect((await verifyReceipt(receipt)).valid).toBe(false);
  });

  it("returns valid: false when the issued timestamp is backdated", async () => {
    const receipt = clone(await issue());
    receipt.issuedAt = "2020-01-01T00:00:00.000Z";
    expect((await verifyReceipt(receipt)).valid).toBe(false);
  });

  it("returns valid: false when the transaction id is re-pointed", async () => {
    const receipt = clone(await issue());
    receipt.transactionId = "wf-someone-elses";
    expect((await verifyReceipt(receipt)).valid).toBe(false);
  });

  it("survives a JSON round trip — the receipt is genuinely portable", async () => {
    const original = await issue();
    const roundTripped = JSON.parse(JSON.stringify(original)) as AnchorReceipt;
    expect((await verifyReceipt(roundTripped)).valid).toBe(true);
  });
});

// ── Canonicalization ─────────────────────────────────────────────────────────

describe("canonicalize", () => {
  it("produces identical output regardless of key insertion order", async () => {
    const a = { receiptId: "r1", issuedAt: "t", assetClass: "legal" };
    const b = { assetClass: "legal", issuedAt: "t", receiptId: "r1" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("sorts keys at every depth, not just the top level", async () => {
    const a = { outer: { zebra: 1, alpha: 2 } };
    const b = { outer: { alpha: 2, zebra: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"outer":{"alpha":2,"zebra":1}}');
  });

  it("retains nested item fields in the hashed material", async () => {
    // Regression guard: a top-level `JSON.stringify` replacer allowlist would
    // strip every key not present at the root, silently dropping item hashes
    // out of the hash and letting a rewritten fingerprint verify.
    const receipt = await issue();
    const canonical = await canonicalize(receipt as UnhashedReceipt);
    expect(canonical).toContain(HASH_A);
    expect(canonical).toContain("retainer.pdf");
    expect(canonical).toContain("verifiedCount");
  });

  it("preserves array order — item order is receipt content", () => {
    expect(canonicalJson([{ b: 1 }, { a: 2 }])).toBe('[{"b":1},{"a":2}]');
    expect(canonicalJson([{ a: 2 }, { b: 1 }])).not.toBe(canonicalJson([{ b: 1 }, { a: 2 }]));
  });

  it("treats an unset optional field as absent, not as null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("two receipts with the same data but different key order hash identically", async () => {
    const base = await issue();
    const { receiptHash: _drop, ...unhashed } = base;

    // Same data, every object rebuilt with reversed key order.
    const reversed = Object.fromEntries(
      Object.entries(unhashed)
        .reverse()
        .map(([k, v]) => [
          k,
          v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v).reverse())
            : Array.isArray(v)
              ? v.map((el) =>
                  el && typeof el === "object"
                    ? Object.fromEntries(Object.entries(el).reverse())
                    : el,
                )
              : v,
        ]),
    ) as UnhashedReceipt;

    expect(await computeReceiptHash(reversed)).toBe(await computeReceiptHash(unhashed));
    expect(await computeReceiptHash(reversed)).toBe(base.receiptHash);
  });
});

// ── File verification ────────────────────────────────────────────────────────

describe("verifyReceiptFile", () => {
  it("verifies a receipt read back from a downloaded file", async () => {
    const receipt = await issue();
    const result = await verifyReceiptFile(receiptFile(receipt));
    expect(result.valid).toBe(true);
    expect(result.receipt.receiptId).toBe(receipt.receiptId);
  });

  it("returns the parsed receipt alongside the verdict for display", async () => {
    const receipt = await issue({ assetClass: "cannabis_ind" });
    const result = await verifyReceiptFile(receiptFile(receipt));
    expect(result.receipt.assetClass).toBe("cannabis_ind");
    expect(result.receipt.summary.totalCount).toBe(1);
  });

  it("flags a file whose receiptHash was edited after download", async () => {
    const receipt = clone(await issue());
    receipt.receiptHash = "f".repeat(64);
    const result = await verifyReceiptFile(receiptFile(receipt));
    expect(result.valid).toBe(false);
    expect(result.computedHash).not.toBe(result.claimedHash);
  });

  it("flags a file whose item fingerprint was swapped after download", async () => {
    const receipt = clone(await issue());
    receipt.items[0].hash = HASH_B;
    expect((await verifyReceiptFile(receiptFile(receipt))).valid).toBe(false);
  });

  it("rejects a non-JSON file with a distinct, plain-language reason", async () => {
    const file = new File(["not json at all"], "notes.txt", { type: "text/plain" });
    // "Not a receipt" must not be reported as "tampered with" — they are
    // different answers and lead the officer to different next steps.
    await expect(verifyReceiptFile(file)).rejects.toThrow(/not valid JSON/i);
  });

  it("rejects JSON that is not an AnchorReceipt", async () => {
    await expect(verifyReceiptFile(receiptFile({ hello: "world" }))).rejects.toThrow(
      /missing the AnchorReceipt fields/i,
    );
  });

  it("rejects a JSON array", async () => {
    await expect(verifyReceiptFile(receiptFile([1, 2, 3]))).rejects.toThrow(
      /does not contain an AnchorReceipt/i,
    );
  });
});
