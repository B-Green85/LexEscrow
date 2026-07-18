import { useEffect, useState } from "react";
import { useSession } from "../store/session";
import { useBatch } from "../store/batch";
import { ExecutionPath } from "../lexguard/types";
import { formatUsd } from "../lexguard/payload-diff";
import * as backend from "../lib/backend";
import { CannaVerifyConditions } from "../components/CannaVerifyConditions";

const PHASES: { key: string; label: string }[] = [
  { key: "verifying", label: "Verifying attorney & billing (Chainlink Functions)" },
  { key: "converting", label: "Converting USD → USDC (Chainlink Price Feeds)" },
  { key: "settling", label: "Executing settlement on-chain (CRE)" },
  { key: "notifying", label: "Notifying client" },
];

function shortRef(hash: string | null): string {
  if (!hash) return "—";
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export function ExecutionConfirmation() {
  const {
    execution,
    buildAuditReport,
    sessionId,
    reset,
    activeBatchItemId,
    fromBatch,
    returnToBatch,
    assetClass,
    cannaVerifyConditions,
    cannaVerifyRunning,
    runCannaVerify,
  } = useSession();
  const [chain, setChain] = useState<backend.ChainVerification | null>(null);
  const done = execution.phase === "done";
  const isDirect = execution.path === ExecutionPath.DirectSettlement;
  const currentIndex = done ? PHASES.length : PHASES.findIndex((p) => p.key === execution.phase);

  useEffect(() => {
    if (done) backend.verifyAuditChain().then(setChain).catch(() => setChain(null));
  }, [done]);

  // When this settlement came from a batch item, reflect it back into the batch
  // table (Settled + tx hash inline).
  useEffect(() => {
    if (done && activeBatchItemId && execution.txHash) {
      useBatch.getState().markSettled(activeBatchItemId, execution.txHash);
    }
  }, [done, activeBatchItemId, execution.txHash]);

  const onDownload = async () => {
    const json = await buildAuditReport();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lexescrow-audit-${sessionId ?? "session"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          {done ? "Settlement complete" : "Executing settlement"}
        </h1>
        <span className={isDirect ? "badge badge-brand" : "badge badge-amber"}>
          {isDirect ? "Path A — Direct Settlement" : "Path B — Arbitration Escrow"}
        </span>
      </div>

      {/* CRE progress */}
      <div className="card mt-5 divide-y divide-slate-100">
        {PHASES.map((p, i) => {
          const status = i < currentIndex ? "done" : i === currentIndex ? "active" : "pending";
          return (
            <div key={p.key} className="flex items-center gap-3 px-5 py-3.5">
              {status === "done" ? (
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                    <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                  </svg>
                </div>
              ) : status === "active" ? (
                <svg className="h-4 w-4 animate-spin text-brand-600" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
                </svg>
              ) : (
                <div className="h-5 w-5 rounded-full border-2 border-slate-200" />
              )}
              <span className={`text-sm ${status === "pending" ? "text-slate-400" : "text-slate-700"}`}>
                {p.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Cannabis IND — regulatory condition state carried through settlement.
          The blocking gate is on the review screen; this is the monitor view. */}
      {assetClass === "cannabis_ind" && (
        <CannaVerifyConditions
          conditions={cannaVerifyConditions}
          running={cannaVerifyRunning}
          onRun={() => void runCannaVerify()}
        />
      )}

      {done && (
        <>
          {/* Settlement summary */}
          <div className="card mt-5 p-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg bg-emerald-50 p-4">
                <div className="text-xs font-medium text-emerald-700">
                  {isDirect ? "Released to client" : "Locked in escrow"}
                </div>
                <div className="mt-1 font-mono text-lg font-bold text-emerald-800">
                  {formatUsd(execution.clientCents)} USDC
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <div className="text-xs font-medium text-slate-600">
                  {isDirect ? "Released to firm" : "Firm (pending resolution)"}
                </div>
                <div className="mt-1 font-mono text-lg font-bold text-slate-800">
                  {formatUsd(execution.firmCents)} USDC
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
              <span className="text-sm text-slate-500">Settlement reference</span>
              <span className="font-mono text-sm text-slate-800" data-selectable>
                {shortRef(execution.txHash)}
              </span>
            </div>
          </div>

          {/* Notifications */}
          <div className="card mt-4 p-5">
            <div className="text-sm font-semibold text-slate-700">Client notification</div>
            <div className="mt-2 space-y-2">
              {execution.notifications.map((n, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">
                    {n.channel === "email" ? "Email" : "SMS"} · {n.target || "—"}
                  </span>
                  <span
                    className={
                      n.status === "delivered" || n.status === "sent"
                        ? "badge badge-emerald"
                        : n.status === "skipped"
                          ? "badge badge-slate"
                          : "badge badge-red"
                    }
                  >
                    {n.status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Audit */}
          <div className="card mt-4 flex items-center justify-between p-5">
            <div>
              <div className="text-sm font-semibold text-slate-700">Tamper-evident audit trail</div>
              <div className="mt-0.5 text-xs text-slate-500">
                {chain
                  ? chain.valid
                    ? `${chain.entries} entries · hash chain intact`
                    : `chain broken at entry ${chain.brokenAt}`
                  : "verifying…"}
                {chain?.valid && <span className="ml-1 text-emerald-600">✓</span>}
              </div>
            </div>
            <button className="btn btn-secondary" onClick={onDownload}>
              Download audit report
            </button>
          </div>

          <div className="mt-6 flex justify-center gap-2">
            {fromBatch ? (
              <button className="btn btn-primary" onClick={() => returnToBatch()}>
                Back to batch
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={() => reset()}>
                Start a new release
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
