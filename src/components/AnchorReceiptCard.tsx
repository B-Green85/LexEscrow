// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * AnchorReceipt summary card (spec §8 / §12 Screen 8).
 *
 * Shared by the Execution Confirmation screen and the AnchorReceipt Console so
 * a receipt looks identical wherever it is shown — an officer comparing the one
 * in the workflow against the one from the Console should not have to work out
 * whether two different layouts are describing the same object.
 *
 * Everything it renders arrives as props, so it render-tests without a live
 * store (the same shape as `ExecutionConfirmationView`). The one store it
 * touches is write-only and inert when unmounted — see `toast`.
 */

import { useState } from "react";
import {
  verifyReceipt,
  type AnchorReceipt,
  type ReceiptVerification,
} from "../lib/anchor-receipt";
import { toast } from "./Toast";
import { descriptorFor } from "../lib/assetClasses";
import { isRealTxHash, txUrl } from "../lib/explorer";

/** Middle-elided reference — long enough to compare by eye, short enough to fit. */
export function shortHash(value: string | null | undefined, head = 10, tail = 6): string {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Registration reference — an Etherscan link only for a real 32-byte
 * transaction hash. The simulated `0xanchor-…` references render as plain
 * monospace text: a link to "transaction not found" reads as evidence the
 * registration never happened.
 */
export function AnchorTxLink({ hash }: { hash: string | null | undefined }) {
  if (!hash) return <span className="font-mono text-sm text-text-muted">—</span>;
  if (!isRealTxHash(hash)) {
    return (
      <span className="font-mono text-sm text-text-primary" data-selectable>
        {shortHash(hash, 12, 6)}
      </span>
    );
  }
  return (
    <a
      className="font-mono text-sm text-brand-fg underline-offset-2 hover:underline"
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      data-selectable
    >
      {shortHash(hash, 12, 6)}
    </a>
  );
}

function StatusBadge({ summary }: { summary: AnchorReceipt["summary"] }) {
  const { overallStatus, verifiedCount, totalCount } = summary;
  const className =
    overallStatus === "verified_all"
      ? "badge badge-emerald"
      : overallStatus === "verified_partial"
        ? "badge badge-amber"
        : "badge badge-red";
  const label =
    overallStatus === "verified_all"
      ? "Verified — all documents"
      : overallStatus === "verified_partial"
        ? "Verified — partial"
        : "Unverified";
  return (
    <span className={className}>
      {label} · {verifiedCount}/{totalCount}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-app-border pt-3 first:border-0 first:pt-0">
      <span className="shrink-0 text-sm text-text-muted">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/** Inline verification panel — computed vs claimed, side by side. */
export function ReceiptVerificationPanel({
  result,
  error,
}: {
  result: ReceiptVerification | null;
  error?: string | null;
}) {
  if (error) {
    return (
      <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
        <div className="text-sm font-semibold text-red-700">❌ Could not read that receipt</div>
        <div className="mt-1 text-xs text-red-600">{error}</div>
      </div>
    );
  }
  if (!result) return null;

  return (
    <div
      className={`mt-4 rounded-lg border px-4 py-3 ${
        result.valid ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
      }`}
    >
      <div
        className={`text-sm font-semibold ${result.valid ? "text-emerald-700" : "text-red-700"}`}
      >
        {result.valid
          ? "✅ Valid — Receipt hash verified. This receipt has not been tampered with."
          : "❌ Invalid — Receipt hash mismatch. This receipt may have been tampered with."}
      </div>
      <dl className="mt-3 space-y-1.5">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
          <dt className="shrink-0 text-xs text-text-muted">Computed</dt>
          <dd
            className={`break-all font-mono text-xs ${
              result.valid ? "text-emerald-800" : "text-red-700"
            }`}
            data-selectable
          >
            {result.computedHash}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
          <dt className="shrink-0 text-xs text-text-muted">Claimed</dt>
          <dd
            className={`break-all font-mono text-xs ${
              result.valid ? "text-emerald-800" : "text-red-700"
            }`}
            data-selectable
          >
            {result.claimedHash || "—"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export interface AnchorReceiptCardProps {
  receipt: AnchorReceipt;
  onDownload: () => void;
  /** Extra actions rendered next to Download (the Console adds Copy Hash). */
  actions?: React.ReactNode;
  /** Heading text; the Console titles its own step differently. */
  heading?: string;
}

export function AnchorReceiptCard({
  receipt,
  onDownload,
  actions,
  heading = "📋 AnchorReceipt Issued",
}: AnchorReceiptCardProps) {
  const [verification, setVerification] = useState<ReceiptVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const first = receipt.items[0];

  const onVerify = async () => {
    setVerifying(true);
    try {
      setVerification(await verifyReceipt(receipt));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="card mt-4 p-5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-text-primary">{heading}</div>
        <StatusBadge summary={receipt.summary} />
      </div>

      <div className="mt-4 space-y-3">
        <Row label="Receipt ID">
          <span className="font-mono text-sm text-text-primary" data-selectable>
            {shortHash(receipt.receiptId, 8, 4)}
          </span>
        </Row>
        <Row label="Issued at">
          <span className="text-sm text-text-primary">
            {new Date(receipt.issuedAt).toLocaleString()}
          </span>
        </Row>
        <Row label="Asset class">
          <span className="text-sm text-text-primary">
            {descriptorFor(receipt.assetClass).icon} {descriptorFor(receipt.assetClass).displayName}
          </span>
        </Row>
        <Row label="Documents registered">
          <span className="text-sm text-text-primary">
            {receipt.summary.verifiedCount} of {receipt.summary.totalCount}
          </span>
        </Row>
        <Row label="On-chain registration">
          <AnchorTxLink hash={first?.onChainTx} />
        </Row>
        <Row label="Receipt hash">
          <span className="font-mono text-sm text-text-primary" data-selectable>
            {shortHash(receipt.receiptHash, 12, 8)}
          </span>
        </Row>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          className="btn btn-primary"
          // The toast is raised before the handler, not after: the download is
          // the caller's business (and may be async), while the feedback is
          // owed the moment the button is pressed.
          onClick={() => {
            toast("Downloading receipt…");
            onDownload();
          }}
        >
          Download Receipt JSON
        </button>
        <button className="btn btn-secondary" onClick={() => void onVerify()} disabled={verifying}>
          {verifying ? "Verifying…" : "Verify Receipt"}
        </button>
        {actions}
      </div>

      <ReceiptVerificationPanel result={verification} />

      <p className="mt-4 border-t border-app-border pt-3 text-xs text-text-muted">
        {receipt.assertionText}
      </p>
    </div>
  );
}
