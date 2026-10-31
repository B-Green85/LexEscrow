// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * CannaVerify condition checklist (spec §5 / §11 — Escrow Monitor).
 *
 * Shows the live state of the cannabis regulatory conditions: license, holds,
 * inventory, manifest, entity standing. Each row carries the CRE Functions tx
 * hash that recorded the result on-chain (mock in this build).
 */

import { CHECK_LABELS, type CannaVerifyCheck, type CannaVerifyConditions } from "../lib/cannaverify/types";
import { txUrl } from "../lib/explorer";

interface Props {
  conditions: CannaVerifyConditions | null;
  running: boolean;
  onRun: () => void;
}

const RESULT_BADGE: Record<string, { cls: string; text: string }> = {
  PASS: { cls: "badge badge-emerald", text: "✅ PASS" },
  FAIL: { cls: "badge badge-red", text: "❌ FAIL" },
  ERROR: { cls: "badge badge-amber", text: "⚠️ ERROR" },
};

const OVERALL_BANNER: Record<string, { cls: string; text: string }> = {
  PASS: {
    cls: "border-emerald-500/30 bg-emerald-50 text-emerald-700",
    text: "✅ All conditions verified — ready to settle",
  },
  FAIL: {
    cls: "border-red-500/30 bg-red-50 text-red-700",
    text: "❌ Conditions failed — review required",
  },
  ERROR: {
    cls: "border-amber-500/30 bg-amber-50 text-amber-700",
    text: "⚠️ Verification error — retry or contact support",
  },
};

/** 0x1234abcd…9f2c — enough to eyeball, short enough to sit inline. */
function shortTx(tx: string): string {
  if (tx.length <= 14) return tx;
  return `${tx.slice(0, 10)}…${tx.slice(-4)}`;
}

function CheckRow({ check }: { check: CannaVerifyCheck }) {
  const badge = RESULT_BADGE[check.result] ?? RESULT_BADGE.ERROR;
  return (
    <div className="px-5 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-text-primary">{CHECK_LABELS[check.checkType]}</span>
        <span className={badge.cls}>{badge.text}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-text-muted">{check.detail}</p>
      {check.onChainTx && (
        <a
          href={txUrl(check.onChainTx)}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-block font-mono text-[11px] text-brand-fg hover:underline"
        >
          {shortTx(check.onChainTx)}
        </a>
      )}
    </div>
  );
}

export function CannaVerifyConditions({ conditions, running, onRun }: Props) {
  return (
    <div className="card mt-5">
      <div className="flex items-center justify-between border-b border-app-border px-5 py-3.5">
        <div>
          <div className="text-sm font-semibold text-text-primary">🌿 CannaVerify conditions</div>
          <div className="mt-0.5 text-xs text-text-muted">
            Metrc &amp; state regulatory verification via Chainlink Functions
          </div>
        </div>
        {conditions && (
          <span className="font-mono text-[11px] text-text-muted">{conditions.stateLicenseNum}</span>
        )}
      </div>

      {/* Running — no results yet. */}
      {running && !conditions && (
        <div className="flex items-center gap-3 px-5 py-6">
          <svg className="h-4 w-4 animate-spin text-brand-fg" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
          </svg>
          <span className="text-sm text-text-muted">
            🔍 CannaVerify running Metrc and state regulatory checks...
          </span>
        </div>
      )}

      {/* Not yet run. */}
      {!running && !conditions && (
        <div className="px-5 py-6">
          <p className="text-sm text-text-muted">
            Cannabis transactions require verified state licensure before any funds are released.
            Run CannaVerify to check license status, compliance holds, inventory, transfer manifest
            and entity standing.
          </p>
          <button className="btn btn-primary mt-4" onClick={onRun}>
            Run CannaVerify
          </button>
        </div>
      )}

      {/* Results. */}
      {conditions && (
        <>
          <div className="divide-y divide-app-border">
            {conditions.checks.map((c) => (
              <CheckRow key={c.checkType} check={c} />
            ))}
          </div>
          <div className="px-5 pb-5 pt-4">
            <div
              className={`rounded-lg border px-4 py-3 text-sm font-medium ${
                (OVERALL_BANNER[conditions.overallResult] ?? OVERALL_BANNER.ERROR).cls
              }`}
            >
              {(OVERALL_BANNER[conditions.overallResult] ?? OVERALL_BANNER.ERROR).text}
            </div>
            {conditions.overallResult !== "PASS" && (
              <button className="btn btn-secondary mt-3" onClick={onRun} disabled={running}>
                {running ? "Re-running…" : "Re-run CannaVerify"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
