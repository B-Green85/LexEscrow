import { useEffect, useRef, type ReactNode } from "react";
import { useSession } from "../store/session";
import { ExecutionPath } from "../lexguard/types";
import { formatUsd, toCents } from "../lexguard/payload-diff";

const $ = (n: number) => formatUsd(toCents(n));

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`text-sm font-medium text-slate-900 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</div>
  );
}

export function ParsedOutputReview() {
  const {
    payload,
    corrections,
    providerLabel,
    scrollCompleted,
    acknowledged,
    markScrollCompleted,
    setAcknowledged,
    proceedToExecution,
    error,
    busy,
  } = useSession();
  const scrollRef = useRef<HTMLDivElement>(null);

  // If the content isn't tall enough to scroll, there's nothing to enforce.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 4) markScrollCompleted();
  }, [markScrollCompleted]);

  if (!payload) return null;
  const isDirect = payload.recommendedPath === ExecutionPath.DirectSettlement;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) markScrollCompleted();
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">Review parsed output</h1>
        <span className={corrections.length ? "badge badge-amber" : "badge badge-emerald"}>
          {corrections.length
            ? `${corrections.length} correction${corrections.length > 1 ? "s" : ""} made`
            : "No corrections required"}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        LexGuard reviewed and validated the AI output. Review the complete parsed output carefully —
        errors in parsing will affect fund distribution.
      </p>
      {providerLabel && <p className="mt-1 text-xs text-slate-400">Parsed via {providerLabel}.</p>}

      <div className="card mt-5 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-selectable
          className="max-h-[44vh] overflow-y-auto px-6 py-4"
        >
          <SectionTitle>Parties</SectionTitle>
          <div className="divide-y divide-slate-100">
            <Row label="Client" value={payload.clientName ?? "—"} />
            <Row label="Client ID" value={payload.clientId} />
            <Row label="Client wallet" value={payload.clientWallet} mono />
            <Row label="Law firm wallet" value={payload.lawFirmWallet} mono />
          </div>

          <SectionTitle>Billing reconciliation</SectionTitle>
          <div className="divide-y divide-slate-100">
            <Row label="Total retainer held" value={$(payload.totalHeld)} mono />
            <Row label="Earned fees (firm)" value={$(payload.earnedFees)} mono />
            <Row label="Unearned balance (client)" value={$(payload.unearnedBalance)} mono />
            <Row label="Disputed hours" value={payload.disputedHours.toFixed(1)} mono />
            <Row label="Disputed amount" value={$(payload.disputedAmount)} mono />
          </div>

          <SectionTitle>Determination</SectionTitle>
          <div className="divide-y divide-slate-100">
            <Row
              label="Recommended path"
              value={isDirect ? "Path A — Direct Settlement" : "Path B — Arbitration Escrow"}
            />
            <Row
              label="Signatures"
              value={payload.signaturesVerified ? "Verified" : "Not verified"}
            />
            <Row
              label="Anomalies flagged"
              value={payload.anomaliesFlagged.length ? payload.anomaliesFlagged.length : "None"}
            />
          </div>
          {payload.anomaliesFlagged.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-sm text-amber-700">
              {payload.anomaliesFlagged.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}

          <SectionTitle>LexGuard corrections</SectionTitle>
          {corrections.length === 0 ? (
            <p className="py-2 text-sm text-slate-500">No corrections were required during parsing.</p>
          ) : (
            <ul className="space-y-1 py-1">
              {corrections.map((c, i) => (
                <li key={i} className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <span className="font-semibold">{c.field}</span>: corrected from{" "}
                  <span className="font-mono">{String(c.aiValue)}</span> to{" "}
                  <span className="font-mono">{String(c.observedValue)}</span> ({c.module})
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-center text-xs text-slate-400">
            — end of parsed output —
          </div>
        </div>

        {/* Acknowledgment footer */}
        <div className="border-t border-slate-100 bg-slate-50/60 px-6 py-4">
          {!scrollCompleted ? (
            <p className="text-center text-sm text-slate-400">
              Scroll to the bottom of the parsed output to continue.
            </p>
          ) : (
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span className="text-sm text-slate-700">
                I have reviewed the complete parsed output and confirm it is accurate.
              </span>
            </label>
          )}

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <button
              className="btn btn-primary btn-lg"
              disabled={!scrollCompleted || !acknowledged || busy}
              onClick={() => proceedToExecution()}
            >
              {busy ? "Verifying…" : "Proceed to Execution"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
