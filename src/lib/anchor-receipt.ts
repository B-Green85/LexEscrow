// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * AnchorReceipt — the document integrity layer (spec §8).
 *
 * ArtifactGuard answers "has this document changed *this session*".
 * AnchorReceipt answers "was this exact document version ever registered, and
 * when" — a provenance claim across time and across parties. Four steps, in
 * order, for every document LexEscrow touches:
 *
 *   1. **Fingerprint** — SHA-256, computed by ArtifactGuard in the Rust backend.
 *   2. **Seal**        — server-keyed HMAC-SHA256 over `hash|size`. The raw
 *                        digest proves the bytes are unchanged; the seal proves
 *                        *LexEscrow attested this fingerprint for these bytes*,
 *                        which is what stops a hash being substituted wholesale
 *                        in transit between counterparties.
 *   3. **Register**    — anchored on-chain via Chainlink CRE. Public,
 *                        decentralized, permanent — a stronger trust primitive
 *                        than a symmetric registry the issuer alone controls.
 *                        Real on Sepolia — `AnchorRegistry` (see `registerOnChain`).
 *   4. **Issue**       — a portable `receipt.json` whose `receiptHash` any
 *                        counterparty can recompute **offline**, with no access
 *                        to the issuer's database. That offline property is the
 *                        entire design constraint of this module.
 */

import type { AssetClass } from "./assetClasses";
import * as backend from "./backend";

/** One sealed, registered document inside a receipt. */
export interface AnchorReceiptItem {
  label: string; // filename or document label
  hmac: string; // base64url HMAC seal from the Rust backend
  hash: string; // SHA-256 fingerprint ("sha256:<hex>")
  size: number; // file size in bytes
  registered: boolean;
  registeredAt?: string; // ISO timestamp
  onChainTx?: string; // AnchorRegistry.anchor tx (Sepolia); absent when unregistered
  // CannaVerify extensions — cannabis_ind only (spec §8 receipt format).
  cannaverifyLicenseStatus?: string;
  cannaverifyComplianceHolds?: number;
}

export interface AnchorReceiptSummary {
  overallStatus: "verified_all" | "verified_partial" | "unverified";
  verifiedCount: number;
  totalCount: number;
}

export interface AnchorReceipt {
  receiptId: string; // UUID
  issuedAt: string; // ISO timestamp
  assertionType: string; // 'escrow_document_registration'
  transactionId: string; // session_id
  assetClass: AssetClass;
  summary: AnchorReceiptSummary;
  items: AnchorReceiptItem[];
  assertionText: string;
  receiptHash: string; // SHA-256 over canonical JSON
}

/** A receipt as it exists before its own hash is folded in. */
export type UnhashedReceipt = Omit<AnchorReceipt, "receiptHash">;

export const ASSERTION_TYPE = "escrow_document_registration";

/** Spec §8 — the standard assertion, fixed text so receipts are comparable. */
export const ASSERTION_TEXT =
  "As of the issued timestamp, the above document fingerprints were verified " +
  "against the LexEscrow AnchorReceipt registry.";

export interface AnchorReceiptItemInput {
  label: string;
  hash: string;
  size: number;
  cannaverifyLicenseStatus?: string;
  cannaverifyComplianceHolds?: number;
}

// ── Step 2 — HMAC seal ───────────────────────────────────────────────────────

/**
 * Seal a fingerprint. Delegates to the Rust backend, which holds the seal key;
 * outside Tauri the bridge returns a `DEMO-HMAC-` stand-in (see `backend.ts`).
 */
export async function computeHmacSeal(hash: string, size: number): Promise<string> {
  return backend.computeHmacSeal(hash, size);
}

// ── Step 3 — on-chain registration ───────────────────────────────────────────

/**
 * Anchor a document's SHA-256 fingerprint on-chain and record it in the local
 * registry.
 *
 * The anchor is real: the Rust backend calls `anchor(bytes32)` on the Sepolia
 * AnchorRegistry and returns only once the transaction is mined. Resolves to
 * that tx hash, or `null` when anchoring failed (locked vault, no registry
 * configured, RPC down, revert) — never to a stand-in hash. The local registry
 * row is written only for a confirmed anchor.
 *
 * A registry write failure is deliberately non-fatal: the anchor is on-chain
 * and the receipt hash covers it, so losing the local index row must not cost
 * the officer a receipt they can still verify offline.
 */
export async function registerOnChain(
  sessionId: string,
  assetClass: AssetClass,
  hmac: string,
  hash: string,
): Promise<string | null> {
  let onChainTx: string;
  try {
    onChainTx = await backend.anchorDocument(hash);
  } catch (e) {
    console.error("on-chain anchoring failed", hash, e);
    return null;
  }
  try {
    await backend.saveRegisteredFingerprint({ hmac, sessionId, assetClass, onChainTx });
  } catch (e) {
    console.error("anchor fingerprint registry write failed", hmac, e);
  }
  return onChainTx;
}

// ── Canonicalization + receipt hash ──────────────────────────────────────────

/**
 * Deterministic JSON: every object's keys sorted, at every depth, no
 * incidental whitespace.
 *
 * The sort is **recursive** rather than a top-level `JSON.stringify` replacer
 * allowlist. A replacer array is applied at every nesting level, so it would
 * strip any key not also present at the top level — `summary.verifiedCount` and
 * every field of every item would vanish from the hashed material, and a
 * receipt whose item hashes had been rewritten would still verify. The hash has
 * to cover the whole document to mean anything.
 *
 * Arrays keep their order: item order is receipt content, not incidental.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members are absent from JSON, so an optional field left unset
    // must not change the canonical form.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/** Canonical JSON for a receipt, excluding its own hash. */
export async function canonicalize(receipt: UnhashedReceipt): Promise<string> {
  return canonicalJson(receipt);
}

/**
 * SHA-256 over the canonical JSON, as lowercase hex.
 *
 * Web Crypto rather than the Rust backend on purpose: a counterparty verifying
 * a receipt has a browser and a JSON file, and nothing else. Verification that
 * needed the desktop app would not be offline verification.
 */
export async function computeReceiptHash(receipt: UnhashedReceipt): Promise<string> {
  const canonical = await canonicalize(receipt);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Step 4 — issue ───────────────────────────────────────────────────────────

function newReceiptId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `receipt-${Date.now().toString(16)}`;
}

function summarize(items: AnchorReceiptItem[]): AnchorReceiptSummary {
  const verifiedCount = items.filter((i) => i.registered).length;
  const totalCount = items.length;
  const overallStatus =
    totalCount > 0 && verifiedCount === totalCount
      ? "verified_all"
      : verifiedCount > 0
        ? "verified_partial"
        : "unverified";
  return { overallStatus, verifiedCount, totalCount };
}

/**
 * Seal, register and issue a portable receipt for a set of documents.
 *
 * Items are processed sequentially, not in parallel: each one writes a row to
 * the fingerprint registry, and the audit-trail ordering downstream of this is
 * only meaningful if registration order matches item order.
 */
export async function issueReceipt(params: {
  sessionId: string;
  assetClass: AssetClass;
  items: AnchorReceiptItemInput[];
}): Promise<AnchorReceipt> {
  const { sessionId, assetClass } = params;
  const items: AnchorReceiptItem[] = [];

  for (const input of params.items) {
    const hmac = await computeHmacSeal(input.hash, input.size);
    const onChainTx = await registerOnChain(sessionId, assetClass, hmac, input.hash);
    items.push({
      label: input.label,
      hmac,
      hash: input.hash,
      size: input.size,
      registered: onChainTx !== null,
      ...(onChainTx !== null && { registeredAt: new Date().toISOString(), onChainTx }),
      ...(input.cannaverifyLicenseStatus !== undefined && {
        cannaverifyLicenseStatus: input.cannaverifyLicenseStatus,
      }),
      ...(input.cannaverifyComplianceHolds !== undefined && {
        cannaverifyComplianceHolds: input.cannaverifyComplianceHolds,
      }),
    });
  }

  const unhashed: UnhashedReceipt = {
    receiptId: newReceiptId(),
    issuedAt: new Date().toISOString(),
    assertionType: ASSERTION_TYPE,
    transactionId: sessionId,
    assetClass,
    summary: summarize(items),
    items,
    assertionText: ASSERTION_TEXT,
  };

  return { ...unhashed, receiptHash: await computeReceiptHash(unhashed) };
}

// ── Verification ─────────────────────────────────────────────────────────────

export interface ReceiptVerification {
  valid: boolean;
  computedHash: string;
  claimedHash: string;
}

/**
 * Offline verification: strip the claimed hash, recompute over what remains,
 * compare. Any edit anywhere in the receipt — a swapped fingerprint, an added
 * item, a rewritten timestamp — moves the computed hash away from the claimed
 * one, because the hash covers the entire canonical document.
 */
export async function verifyReceipt(receipt: AnchorReceipt): Promise<ReceiptVerification> {
  const { receiptHash: claimedHash, ...rest } = receipt;
  const computedHash = await computeReceiptHash(rest);
  return { valid: computedHash === claimedHash, computedHash, claimedHash: claimedHash ?? "" };
}

export interface ReceiptFileVerification extends ReceiptVerification {
  receipt: AnchorReceipt;
}

/**
 * Verify a receipt JSON file a counterparty was handed. Parse failures throw
 * with a plain-language reason — the Console surfaces it verbatim, and "this
 * is not a receipt" is a different answer from "this receipt was tampered
 * with", so the two must not collapse into one red banner.
 */
export async function verifyReceiptFile(file: File): Promise<ReceiptFileVerification> {
  const text = await file.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON — an AnchorReceipt is a .json file.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("That file does not contain an AnchorReceipt object.");
  }
  const receipt = parsed as AnchorReceipt;
  if (typeof receipt.receiptHash !== "string" || !Array.isArray(receipt.items)) {
    throw new Error("That JSON file is missing the AnchorReceipt fields (receiptHash, items).");
  }

  return { ...(await verifyReceipt(receipt)), receipt };
}

// ── Download ─────────────────────────────────────────────────────────────────

/** Save the receipt as a portable `anchor-receipt-{receiptId}.json`. */
export function downloadReceipt(receipt: AnchorReceipt): void {
  const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `anchor-receipt-${receipt.receiptId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
