import { useState } from "react";
import { ExecutionPath } from "../lexguard/types";
import type { ManualEntryFields } from "../store/session";

/**
 * Structured manual-entry form for a ParsedRetainerPayload. Money fields are
 * entered and displayed as dollars; the store converts to integer cents. On
 * submit, LexGuard runs against this payload exactly as it would against AI
 * output — no field bypasses validation.
 */

export interface ManualEntryInitial {
  clientId?: string;
  lawFirmWallet?: string;
  clientWallet?: string;
  totalHeld?: number;
  earnedFees?: number;
  unearnedBalance?: number;
  disputedHours?: number;
  disputedAmount?: number;
  signaturesVerified?: boolean;
  recommendedPath?: ExecutionPath;
  anomaliesFlagged?: string[];
}

const dollars = (n?: number) => (n === undefined ? "" : String(n));

function money(s: string): number {
  const n = parseFloat(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function ManualEntryForm({
  initial,
  submitting,
  onSubmit,
  onCancel,
}: {
  initial?: ManualEntryInitial;
  submitting?: boolean;
  onSubmit: (fields: ManualEntryFields) => void;
  onCancel?: () => void;
}) {
  const [clientId, setClientId] = useState(initial?.clientId ?? "");
  const [lawFirmWallet, setLawFirmWallet] = useState(initial?.lawFirmWallet ?? "");
  const [clientWallet, setClientWallet] = useState(initial?.clientWallet ?? "");
  const [totalHeld, setTotalHeld] = useState(dollars(initial?.totalHeld));
  const [earnedFees, setEarnedFees] = useState(dollars(initial?.earnedFees));
  const [unearnedBalance, setUnearnedBalance] = useState(dollars(initial?.unearnedBalance));
  const [disputedHours, setDisputedHours] = useState(dollars(initial?.disputedHours));
  const [disputedAmount, setDisputedAmount] = useState(dollars(initial?.disputedAmount));
  const [signaturesVerified, setSignaturesVerified] = useState(initial?.signaturesVerified ?? false);
  const [recommendedPath, setRecommendedPath] = useState<ExecutionPath>(
    initial?.recommendedPath ?? ExecutionPath.DirectSettlement,
  );
  const [anomaliesText, setAnomaliesText] = useState((initial?.anomaliesFlagged ?? []).join(", "));

  const submit = () => {
    onSubmit({
      clientId: clientId.trim(),
      lawFirmWallet: lawFirmWallet.trim(),
      clientWallet: clientWallet.trim(),
      totalHeld: money(totalHeld),
      earnedFees: money(earnedFees),
      unearnedBalance: money(unearnedBalance),
      disputedHours: money(disputedHours),
      disputedAmount: money(disputedAmount),
      signaturesVerified,
      recommendedPath,
      anomaliesFlagged: anomaliesText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    });
  };

  return (
    <div className="card p-6">
      <div className="text-sm font-semibold text-slate-800">Manual entry</div>
      <p className="mt-0.5 text-xs text-slate-500">
        Enter the retainer fields. LexGuard validates everything you enter against the document —
        arithmetic, anchors, anomalies, and field scope — before you can proceed.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="label">Client ID</label>
          <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="C-10482" />
        </div>
        <div>
          <label className="label">Law firm wallet</label>
          <input className="input font-mono text-xs" value={lawFirmWallet} onChange={(e) => setLawFirmWallet(e.target.value)} placeholder="0x…" />
        </div>
        <div>
          <label className="label">Client wallet</label>
          <input className="input font-mono text-xs" value={clientWallet} onChange={(e) => setClientWallet(e.target.value)} placeholder="0x…" />
        </div>

        <div>
          <label className="label">Total retainer held ($)</label>
          <input className="input" inputMode="decimal" value={totalHeld} onChange={(e) => setTotalHeld(e.target.value)} placeholder="5000.00" />
        </div>
        <div>
          <label className="label">Earned fees ($)</label>
          <input className="input" inputMode="decimal" value={earnedFees} onChange={(e) => setEarnedFees(e.target.value)} placeholder="800.00" />
        </div>
        <div>
          <label className="label">Unearned balance ($)</label>
          <input className="input" inputMode="decimal" value={unearnedBalance} onChange={(e) => setUnearnedBalance(e.target.value)} placeholder="4200.00" />
        </div>
        <div>
          <label className="label">Disputed hours</label>
          <input className="input" inputMode="decimal" value={disputedHours} onChange={(e) => setDisputedHours(e.target.value)} placeholder="0" />
        </div>
        <div>
          <label className="label">Disputed amount ($)</label>
          <input className="input" inputMode="decimal" value={disputedAmount} onChange={(e) => setDisputedAmount(e.target.value)} placeholder="0.00" />
        </div>
        <div>
          <label className="label">Recommended path</label>
          <select
            className="input"
            value={recommendedPath}
            onChange={(e) => setRecommendedPath(e.target.value as ExecutionPath)}
          >
            <option value={ExecutionPath.DirectSettlement}>Direct Settlement</option>
            <option value={ExecutionPath.ArbitrationEscrow}>Arbitration Escrow</option>
          </select>
        </div>

        <div className="col-span-2 flex items-center gap-2">
          <input
            id="sigs"
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            checked={signaturesVerified}
            onChange={(e) => setSignaturesVerified(e.target.checked)}
          />
          <label htmlFor="sigs" className="text-sm text-slate-700">
            Signatures verified
          </label>
        </div>

        <div className="col-span-2">
          <label className="label">Anomalies flagged (comma separated)</label>
          <input
            className="input"
            value={anomaliesText}
            onChange={(e) => setAnomaliesText(e.target.value)}
            placeholder="e.g. ledger gap, missing signature"
          />
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        {onCancel && (
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary btn-lg" onClick={submit} disabled={submitting}>
          {submitting ? "Validating…" : "Validate with LexGuard"}
        </button>
      </div>
    </div>
  );
}
