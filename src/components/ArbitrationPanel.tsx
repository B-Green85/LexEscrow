/**
 * Path B multi-signature panel (spec §6 Path B).
 *
 * A compact, self-contained signing surface: the three parties, who has signed,
 * and how many signatures remain before the threshold releases the escrow.
 *
 * Deliberately narrower than `ExecutionConfirmation`'s `ArbitrationView`, which
 * also carries the lock transaction, the arbiter address and the resolution
 * record. Those belong to the *settlement* screen, where the escrow's final
 * disposition is being reported. Here, on the monitor, the officer is still
 * collecting signatures — showing a resolution block that cannot yet exist
 * would be noise.
 */

import type { ArbitrationSigner, ArbitrationState } from "../lib/releasePaths";

function SignatureRow({
  label,
  signed,
  disabled,
  onSign,
}: {
  label: string;
  signed: boolean;
  disabled: boolean;
  onSign: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-3.5">
      <span className="flex items-center gap-2 text-sm text-text-primary">
        <span aria-hidden>{signed ? "✅" : "⬜"}</span>
        {label}
      </span>
      <span className="flex items-center gap-3">
        <span className={signed ? "badge badge-emerald" : "badge badge-slate"}>
          {signed ? "Signed" : "Pending"}
        </span>
        {/* Disabled once this party has signed — nobody signs twice. */}
        <button className="btn btn-secondary" onClick={onSign} disabled={signed || disabled}>
          Sign as {label}
        </button>
      </span>
    </div>
  );
}

export interface ArbitrationPanelProps {
  arbitrationState: ArbitrationState;
  busy: boolean;
  onSign: (signer: ArbitrationSigner) => void;
}

export function ArbitrationPanel({ arbitrationState, busy, onSign }: ArbitrationPanelProps) {
  const { party1Signed, party2Signed, arbiterSigned, threshold, resolvedAt } = arbitrationState;
  const signed = [party1Signed, party2Signed, arbiterSigned].filter(Boolean).length;
  const resolved = Boolean(resolvedAt);

  return (
    <div className="card mt-4">
      <div className="flex items-center justify-between border-b border-app-border px-5 py-3">
        <div>
          <div className="text-sm font-semibold text-text-primary">⚖️ Multi-signature resolution</div>
          <div className="mt-0.5 text-xs text-text-muted">
            Funds stay locked until the signature threshold is met.
          </div>
        </div>
        <span className={signed >= threshold ? "badge badge-emerald" : "badge badge-amber"}>
          {signed}/{threshold} required signatures
        </span>
      </div>
      <div className="divide-y divide-app-border">
        <SignatureRow
          label="Party 1"
          signed={party1Signed}
          disabled={busy || resolved}
          onSign={() => onSign("party1")}
        />
        <SignatureRow
          label="Party 2"
          signed={party2Signed}
          disabled={busy || resolved}
          onSign={() => onSign("party2")}
        />
        <SignatureRow
          label="Arbiter"
          signed={arbiterSigned}
          disabled={busy || resolved}
          onSign={() => onSign("arbiter")}
        />
      </div>
    </div>
  );
}
