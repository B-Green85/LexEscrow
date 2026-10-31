// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Render checks for the AnchorReceipt Console — Screen 8 (spec §12).
 *
 * Renders the pure `AnchorReceiptConsoleView` through `react-dom/server`, the
 * same shape as the Execution Confirmation and Condition Definition screen
 * tests: the store container cannot be server-rendered meaningfully because
 * zustand v5 hands React `getInitialState` as the server snapshot.
 *
 * The verify cases run receipts through the *real* `verifyReceiptFile` rather
 * than hand-writing a verdict object, so the ✅/❌ the officer sees is tied to
 * an actual recomputation.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import {
  AnchorReceiptConsoleView,
  type AnchorReceiptConsoleViewProps,
} from "./AnchorReceiptConsole";
import {
  issueReceipt,
  verifyReceiptFile,
  type AnchorReceipt,
  type ReceiptFileVerification,
} from "../lib/anchor-receipt";
import * as backend from "../lib/backend";
import type { LoadedArtifact } from "../lib/backend";

// Everything else runs the real browser fallbacks; only the chain write is
// stubbed, and it defaults to the browser behaviour (no desktop → rejects).
vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backend")>()),
  anchorDocument: vi.fn().mockRejectedValue(new Error("On-chain anchoring requires the desktop backend.")),
}));

const REAL_TX = "0x" + "7f".repeat(32);

const HASH = "sha256:" + "a".repeat(64);

const artifact: LoadedArtifact = {
  filename: "purchase-agreement.pdf",
  hash: HASH,
  size: 2048,
  normalizedText: "PURCHASE AGREEMENT",
};

function props(over: Partial<AnchorReceiptConsoleViewProps> = {}): AnchorReceiptConsoleViewProps {
  return {
    file: null,
    artifact: null,
    hmac: null,
    assetClass: "legal",
    receipt: null,
    registeredAt: null,
    busy: false,
    error: null,
    copied: false,
    onSelectFile: () => {},
    onSetAssetClass: () => {},
    onComputeSeal: () => {},
    onRegister: () => {},
    onDownload: () => {},
    onCopyHash: () => {},
    verifyFile: null,
    verifyResult: null,
    verifyError: null,
    verifyBusy: false,
    onSelectVerifyFile: () => {},
    onVerify: () => {},
    onClose: () => {},
    ...over,
  };
}

const render = (over: Partial<AnchorReceiptConsoleViewProps> = {}): string =>
  renderToString(createElement(AnchorReceiptConsoleView, props(over)));

/** A receipt issued through the real pipeline (browser fallback seal). */
function issue(assetClass: AnchorReceipt["assetClass"] = "legal"): Promise<AnchorReceipt> {
  return issueReceipt({
    sessionId: "wf-console-001",
    assetClass,
    items: [{ label: artifact.filename, hash: HASH, size: artifact.size }],
  });
}

function receiptFile(receipt: AnchorReceipt): File {
  return new File([JSON.stringify(receipt, null, 2)], `anchor-receipt-${receipt.receiptId}.json`, {
    type: "application/json",
  });
}

async function verificationOf(receipt: AnchorReceipt): Promise<ReceiptFileVerification> {
  return verifyReceiptFile(receiptFile(receipt));
}

// ── Step 1 — Load Document ───────────────────────────────────────────────────

describe("AnchorReceiptConsole — initial state", () => {
  it("renders the console header and its purpose", () => {
    const html = render();
    expect(html).toContain("AnchorReceipt Console");
    expect(html).toContain("outside of an escrow workflow");
  });

  it("renders Step 1 (file upload) initially", () => {
    const html = render();
    expect(html).toContain("Load Document");
    expect(html).toContain("Click to select a document");
    expect(html).toContain(".pdf, .docx, .txt, .md");
  });

  it("does not offer sealing or registration before a document is loaded", () => {
    const html = render();
    expect(html).not.toContain("Compute Seal");
    expect(html).not.toContain(">Register<");
  });
});

// ── Step 2 — HMAC Seal ───────────────────────────────────────────────────────

describe("AnchorReceiptConsole — after the document is hashed", () => {
  it("shows the full SHA-256 hash and the Hashed status", () => {
    const html = render({ file: new File(["x"], artifact.filename), artifact });
    expect(html).toContain(HASH);
    expect(html).toContain("✅ Hashed");
    expect(html).toContain(artifact.filename);
  });

  it("shows the Compute Seal button once hashed", () => {
    const html = render({ artifact });
    expect(html).toContain("Compute Seal");
  });

  it("explains what the seal proves over and above the raw hash", () => {
    const html = render({ artifact });
    expect(html).toContain("the seal proves LexEscrow attested it");
  });

  it("does not offer registration until the seal exists", () => {
    expect(render({ artifact })).not.toContain("Register On-Chain");
  });
});

// ── Step 3 — Register ────────────────────────────────────────────────────────

describe("AnchorReceiptConsole — after the seal is computed", () => {
  it("shows the Sealed status and the Register step", () => {
    const html = render({ artifact, hmac: "DEMO-HMAC-abc12345" });
    expect(html).toContain("✅ Sealed");
    expect(html).toContain("Register On-Chain");
    expect(html).toContain("Register");
  });

  it("offers a compact asset class selector before registering", () => {
    const html = render({ artifact, hmac: "DEMO-HMAC-abc12345" });
    expect(html).toContain("Asset class");
    expect(html).toContain("Cannabis IND");
    expect(html).toContain("Real Estate");
  });
});

// ── Step 4 — Receipt ─────────────────────────────────────────────────────────

describe("AnchorReceiptConsole — after registration", () => {
  it("shows the receipt card with the download button", async () => {
    const receipt = await issue();
    const html = render({ artifact, hmac: receipt.items[0].hmac, receipt });
    expect(html).toContain("Portable AnchorReceipt");
    expect(html).toContain("Download Receipt JSON");
    expect(html).toContain("Copy Receipt Hash");
  });

  it("shows the Registered status, Etherscan-linked tx and verified counts once anchored", async () => {
    vi.mocked(backend.anchorDocument).mockResolvedValueOnce(REAL_TX);
    const receipt = await issue();
    const html = render({
      artifact,
      hmac: receipt.items[0].hmac,
      receipt,
      registeredAt: receipt.items[0].registeredAt ?? null,
    });
    expect(html).toContain("✅ Registered");
    expect(html).toContain("Verified — all documents");
    expect(html).toContain(`sepolia.etherscan.io/tx/${REAL_TX}`);
  });

  it("says the fingerprint is not on-chain when anchoring failed", async () => {
    const receipt = await issue();
    const html = render({ artifact, hmac: receipt.items[0].hmac, receipt, registeredAt: null });
    expect(html).toContain("Not anchored on-chain");
    expect(html).not.toContain("✅ Registered");
    expect(html).not.toContain("Verified — all documents");
    expect(html).not.toContain("sepolia.etherscan.io/tx/");
  });

  it("reflects the registered asset class in the receipt card", async () => {
    const receipt = await issue("cannabis_ind");
    const html = render({
      artifact,
      hmac: receipt.items[0].hmac,
      receipt,
      assetClass: "cannabis_ind",
    });
    expect(html).toContain("Cannabis IND");
  });

  it("confirms the copy action once the hash is on the clipboard", async () => {
    const receipt = await issue();
    const html = render({ artifact, hmac: receipt.items[0].hmac, receipt, copied: true });
    expect(html).toContain("Copied ✓");
  });

  it("surfaces a registration error to the officer", () => {
    const html = render({ artifact, hmac: "DEMO-HMAC-abc12345", error: "Registration failed: db offline" });
    expect(html).toContain("Registration failed: db offline");
  });
});

// ── Step 5 — Verify (independent section) ────────────────────────────────────

describe("AnchorReceiptConsole — verify section", () => {
  it("is visible before any document has been loaded", () => {
    const html = render();
    expect(html).toContain("Verify an Existing Receipt");
    expect(html).toContain("Select a receipt JSON file");
  });

  it("stays visible all the way through the registration flow", async () => {
    const receipt = await issue();
    for (const state of [
      {},
      { artifact },
      { artifact, hmac: "DEMO-HMAC-abc12345" },
      { artifact, hmac: receipt.items[0].hmac, receipt },
    ]) {
      expect(render(state)).toContain("Verify an Existing Receipt");
    }
  });

  it("shows a ✅ result for a valid receipt file", async () => {
    const result = await verificationOf(await issue());
    expect(result.valid).toBe(true);

    const html = render({ verifyFile: receiptFile(result.receipt), verifyResult: result });
    expect(html).toContain("✅ Valid");
    expect(html).toContain("Receipt hash verified. This receipt has not been tampered with.");
    expect(html).toContain(result.computedHash);
    expect(html).toContain(result.claimedHash);
  });

  it("shows the receipt's own details alongside a valid result", async () => {
    const result = await verificationOf(await issue("cannabis_ind"));
    const html = render({ verifyResult: result });
    expect(html).toContain("Receipt ID");
    expect(html).toContain("Issued at");
    expect(html).toContain("Cannabis IND");
    expect(html).toContain("Documents verified");
  });

  it("shows a ❌ result for a receipt whose hash was tampered with", async () => {
    const tampered = JSON.parse(JSON.stringify(await issue())) as AnchorReceipt;
    tampered.receiptHash = "0".repeat(64);
    const result = await verificationOf(tampered);
    expect(result.valid).toBe(false);

    const html = render({ verifyFile: receiptFile(tampered), verifyResult: result });
    expect(html).toContain("❌ Invalid");
    expect(html).toContain("Receipt hash mismatch. This receipt may have been tampered with.");
    // Both hashes are shown so the mismatch is visible, not merely asserted.
    expect(html).toContain(result.computedHash);
    expect(html).toContain("0".repeat(64));
  });

  it("shows a ❌ result when an item fingerprint was rewritten", async () => {
    const tampered = JSON.parse(JSON.stringify(await issue())) as AnchorReceipt;
    tampered.items[0].hash = "sha256:" + "b".repeat(64);
    const result = await verificationOf(tampered);
    expect(result.valid).toBe(false);
    expect(render({ verifyResult: result })).toContain("❌ Invalid");
  });

  it("reports an unreadable file distinctly from a tampered one", () => {
    const html = render({
      verifyError: "That file is not valid JSON — an AnchorReceipt is a .json file.",
    });
    expect(html).toContain("❌ Could not read that receipt");
    expect(html).toContain("not valid JSON");
    expect(html).not.toContain("may have been tampered with");
  });
});
