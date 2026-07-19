/**
 * Stage 6/7 — Escrow Monitor (spec §12 Screen 6, §6 Stages 6–7).
 *
 * The screen the escrow officer lives on between funding and settlement. Every
 * condition, of every type, in one checklist with live status — and the single
 * button that releases the money, which stays disabled until that checklist
 * says it may be pressed.
 *
 * Two design commitments run through the whole screen:
 *
 *   1. **Nothing here fakes a verification.** A condition shows `met` only
 *      because a machine signal said so or because a human explicitly waived
 *      or confirmed it, and the two are visually distinct — a waived condition
 *      is struck through, never green.
 *   2. **The gate is real.** Unlike Stage 4, which reviews conditions, this
 *      screen enforces them. `proceedToSettlement` refuses while anything is
 *      unmet, and the disabled button names exactly what is blocking it.
 *
 * Split into a store container and a pure `EscrowMonitorView` so the view can
 * be render-tested without a live store, matching Condition Definition and
 * Execution Confirmation.
 */

import { useEffect, useMemo, useState } from "react";
import { useSession } from "../store/session";
import { descriptorFor, type AssetClass } from "../lib/assetClasses";
import { ExecutionPath } from "../lexguard/types";
import { formatUsd, toPayloadCents } from "../lexguard/payload-diff";
import { CannaVerifyConditions } from "../components/CannaVerifyConditions";
import { ArbitrationPanel } from "../components/ArbitrationPanel";
import { CREEventLog } from "../components/CREEventLog";
import type { Condition, ConditionStatus, ConditionSummary } from "../lib/conditions";
import type { ArbitrationSigner, ArbitrationState } from "../lib/releasePaths";
import type { CannaVerifyConditions as CannaVerifyConditionsData } from "../lib/cannaverify/types";
import { txUrl } from "../lib/explorer";

const DAY_MS = 86_400_000;

/** Countdown becomes second-by-second inside this window. */
const LIVE_COUNTDOWN_DAYS = 7;

// ── Status presentation ──────────────────────────────────────────────────────

const STATUS_CHIP: Record<ConditionStatus, { cls: string; text: string }> = {
  met: { cls: "badge badge-emerald", text: "✅ Met" },
  in_progress: { cls: "badge badge-brand", text: "🔄 In Progress" },
  pending: { cls: "badge badge-slate", text: "⏳ Pending" },
  failed: { cls: "badge badge-red", text: "❌ Failed" },
  waived: { cls: "badge badge-slate", text: "〜 Waived" },
};

const STATUS_BORDER: Record<ConditionStatus, string> = {
  met: "border-emerald-500/50",
  in_progress: "border-brand-500/50 animate-pulse",
  pending: "border-[#2D3A4A]",
  failed: "border-red-500/50",
  waived: "border-slate-500/40",
};

const TYPE_ICON: Record<Condition["type"], string> = {
  document: "📄",
  time: "⏰",
  esign: "✍️",
  cannaverify: "🔍",
  bar_verify: "⚖️",
  event: "🛰️",
  manual: "👤",
};

/** Per-signer status glyphs (spec §22 Stage 6). */
const SIGNER_STATUS: Record<string, string> = {
  sent: "⏳ Awaiting",
  delivered: "📬 Delivered",
  completed: "✅ Signed",
  declined: "❌ Declined",
  voided: "🚫 Voided",
};

function isUnmet(status: ConditionStatus): boolean {
  return status === "pending" || status === "in_progress" || status === "failed";
}

function shortHash(h: string): string {
  const bare = h.replace(/^sha256:/, "");
  return bare.length <= 18 ? bare : `${bare.slice(0, 10)}…${bare.slice(-6)}`;
}

function TxLink({ hash, label = "On-chain TX" }: { hash: string; label?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      <a
        href={txUrl(hash)}
        target="_blank"
        rel="noreferrer"
        className="truncate font-mono text-[11px] text-[#93C5FD] hover:underline"
        title={hash}
      >
        {hash.length <= 24 ? hash : `${hash.slice(0, 12)}…${hash.slice(-8)}`}
      </a>
    </div>
  );
}

// ── Time condition body ──────────────────────────────────────────────────────

/**
 * Format the gap to the release date.
 *
 * Inside a week the officer is watching a clock, so the countdown resolves to
 * seconds; beyond that a day count is what they actually plan around.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0s";
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return days > 0
    ? `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function TimeConditionBody({ condition, now }: { condition: Condition; now: number }) {
  const target = condition.releaseDate ? new Date(condition.releaseDate).getTime() : NaN;
  const withinWindow =
    Number.isFinite(target) && target - now > 0 && target - now <= LIVE_COUNTDOWN_DAYS * DAY_MS;

  // A ticking clock, but only when it is worth ticking. Outside the final week
  // a per-second re-render buys the officer nothing.
  const [tick, setTick] = useState(now);
  useEffect(() => {
    if (!withinWindow) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [withinWindow]);

  if (!Number.isFinite(target)) {
    return (
      <p className="text-xs text-amber-600">
        Release date “{condition.releaseDate}” could not be read as a date — resolve it before
        settling.
      </p>
    );
  }

  const current = withinWindow ? tick : now;
  const remaining = target - current;
  const reached = remaining <= 0;
  const days = Math.ceil(remaining / DAY_MS);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500">Release after</span>
        <span className="font-mono text-xs text-slate-700">{condition.releaseDate}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500">Today</span>
        <span className="font-mono text-xs text-slate-700">
          {new Date(current).toISOString().slice(0, 10)}
        </span>
      </div>
      <div className="pt-1 text-xs font-medium">
        {reached ? (
          <span className="text-emerald-600">✅ Date reached</span>
        ) : withinWindow ? (
          <span className="text-amber-600">⏳ {formatCountdown(remaining)} remaining</span>
        ) : (
          <span className="text-slate-500">
            ⏳ {days} day{days === 1 ? "" : "s"} remaining
          </span>
        )}
      </div>
    </div>
  );
}

// ── Per-type condition bodies ────────────────────────────────────────────────

function ESignConditionBody({ condition }: { condition: Condition }) {
  const signers = condition.signers ?? [];
  const statuses = condition.signerStatuses ?? {};
  const signedCount = signers.filter((n) => statuses[n] === "completed").length;

  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {signers.map((name) => (
          <li key={name} className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-slate-700">{name}</span>
            <span className="shrink-0 text-slate-500">
              {SIGNER_STATUS[statuses[name] ?? ""] ?? "⏳ Awaiting"}
            </span>
          </li>
        ))}
      </ul>
      <div className="border-t border-[#2D3A4A] pt-2 text-xs font-medium">
        {signers.length > 0 && signedCount === signers.length ? (
          <span className="text-emerald-600">✅ All signed</span>
        ) : (
          <span className="text-slate-500">
            ⏳ {signedCount} of {signers.length} signed
          </span>
        )}
      </div>
      {condition.onChainTx && <TxLink hash={condition.onChainTx} label="Certificate anchored" />}
    </div>
  );
}

function DocumentConditionBody({ condition }: { condition: Condition }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500">Document</span>
        <span className="truncate text-xs text-slate-700" title={condition.documentLabel}>
          {condition.documentLabel ?? "—"}
        </span>
      </div>
      {condition.documentHash && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">Fingerprint</span>
          <span className="font-mono text-[11px] text-slate-700" title={condition.documentHash}>
            {shortHash(condition.documentHash)}
          </span>
        </div>
      )}
      {condition.onChainTx && <TxLink hash={condition.onChainTx} label="AnchorReceipt" />}
      <div className="pt-1 text-xs font-medium">
        {condition.onChainTx ? (
          <span className="text-emerald-600">✅ Registered</span>
        ) : (
          <span className="text-slate-500">⏳ Pending registration</span>
        )}
      </div>
    </div>
  );
}

function BarVerifyConditionBody({ condition }: { condition: Condition }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500">Bar number</span>
        <span className="font-mono text-xs text-slate-700">{condition.barNumber || "—"}</span>
      </div>
      <div className="pt-1 text-xs font-medium">
        {condition.barVerified ? (
          <span className="text-emerald-600">✅ Verified active with the state bar</span>
        ) : (
          <span className="text-slate-500">❌ Not verified</span>
        )}
      </div>
    </div>
  );
}

/**
 * Manual confirmation, gated behind a typed word.
 *
 * The typing requirement is not friction for its own sake: this is the one
 * condition type with no machine evidence behind it, so the officer's click is
 * the entire basis for the escrow releasing. Making it a deliberate act — and
 * an audited one — is the point.
 */
function ManualConditionBody({
  condition,
  busy,
  onMarkMet,
}: {
  condition: Condition;
  busy: boolean;
  onMarkMet: (conditionId: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const armed = typed.trim().toUpperCase() === "CONFIRM";

  if (condition.status === "met") {
    return (
      <p className="text-xs font-medium text-emerald-600">
        ✅ Confirmed by the escrow officer
        {condition.metAt ? ` · ${new Date(condition.metAt).toLocaleString()}` : ""}
      </p>
    );
  }
  if (condition.status === "waived") return null;

  return (
    <div className="space-y-2">
      <label className="label" htmlFor={`confirm-${condition.id}`}>
        Type CONFIRM to mark this condition met
      </label>
      <div className="flex gap-2">
        <input
          id={`confirm-${condition.id}`}
          className="input"
          value={typed}
          placeholder="CONFIRM"
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
        />
        <button
          className="btn btn-primary shrink-0"
          disabled={!armed || busy}
          onClick={() => onMarkMet(condition.id)}
        >
          Mark as Met
        </button>
      </div>
    </div>
  );
}

// ── Waiver ───────────────────────────────────────────────────────────────────

function WaiverControl({
  condition,
  busy,
  onWaive,
}: {
  condition: Condition;
  busy: boolean;
  onWaive: (conditionId: string, reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button
        className="btn btn-secondary mt-3"
        disabled={busy}
        onClick={() => setOpen(true)}
        aria-label={`Waive ${condition.label}`}
      >
        Waive
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-amber-500/40 bg-[#1A2435] p-3">
      <label className="label" htmlFor={`waive-${condition.id}`}>
        Reason for waiving this condition
      </label>
      <textarea
        id={`waive-${condition.id}`}
        className="input min-h-16"
        value={reason}
        placeholder="Why is it acceptable to settle without this condition?"
        onChange={(e) => setReason(e.target.value)}
      />
      <p className="text-[11px] text-slate-400">
        Recorded to the audit trail against your identity. A waiver is not a verification.
      </p>
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={!reason.trim() || busy}
          onClick={() => {
            onWaive(condition.id, reason.trim());
            setOpen(false);
          }}
        >
          Confirm Waiver
        </button>
        <button className="btn btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Condition card ───────────────────────────────────────────────────────────

function ConditionCard({
  condition,
  now,
  busy,
  cannaVerifyConditions,
  cannaVerifyRunning,
  onRunCannaVerify,
  onWaive,
  onMarkMet,
}: {
  condition: Condition;
  now: number;
  busy: boolean;
  cannaVerifyConditions: CannaVerifyConditionsData | null;
  cannaVerifyRunning: boolean;
  onRunCannaVerify: () => void;
  onWaive: (conditionId: string, reason: string) => void;
  onMarkMet: (conditionId: string) => void;
}) {
  const chip = STATUS_CHIP[condition.status];
  const waived = condition.status === "waived";

  return (
    <div className={`card border p-5 ${STATUS_BORDER[condition.status]}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div
            className={`flex items-center gap-2 text-sm font-semibold ${
              waived ? "text-slate-500 line-through" : "text-slate-800"
            }`}
          >
            <span aria-hidden>{TYPE_ICON[condition.type]}</span>
            <span className="truncate">{condition.label}</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-400">{condition.description}</div>
        </div>
        <span className={`${chip.cls} shrink-0`}>{chip.text}</span>
      </div>

      <div className="mt-3">
        {condition.type === "document" && <DocumentConditionBody condition={condition} />}
        {condition.type === "time" && <TimeConditionBody condition={condition} now={now} />}
        {condition.type === "esign" && <ESignConditionBody condition={condition} />}
        {condition.type === "bar_verify" && <BarVerifyConditionBody condition={condition} />}
        {condition.type === "cannaverify" && (
          <CannaVerifyConditions
            conditions={cannaVerifyConditions}
            running={cannaVerifyRunning}
            onRun={onRunCannaVerify}
          />
        )}
        {condition.type === "manual" && (
          <ManualConditionBody condition={condition} busy={busy} onMarkMet={onMarkMet} />
        )}
        {condition.type === "event" && (
          <p className="text-xs text-slate-500">
            {condition.eventDescription ?? "Verified via CRE adapter."}
          </p>
        )}
      </div>

      {condition.status === "failed" && condition.failureReason && (
        <p className="mt-2 text-xs text-red-500">{condition.failureReason}</p>
      )}
      {waived && condition.failureReason && (
        <p className="mt-2 text-xs text-slate-500">Waived — {condition.failureReason}</p>
      )}

      {isUnmet(condition.status) && (
        <WaiverControl condition={condition} busy={busy} onWaive={onWaive} />
      )}
    </div>
  );
}

// ── Escrow balance ───────────────────────────────────────────────────────────

function BalanceCard({
  fundsDeposited,
  depositTxHash,
  escrowBalance,
  busy,
  onConfirmDeposit,
}: {
  fundsDeposited: boolean;
  depositTxHash: string | null;
  escrowBalance: bigint;
  busy: boolean;
  onConfirmDeposit: (txHash: string) => void;
}) {
  const [txHash, setTxHash] = useState("");

  if (fundsDeposited) {
    return (
      <div className="card border border-emerald-500/40 p-6">
        <div className="text-xs font-medium text-emerald-700">In escrow</div>
        <div className="mt-1 font-mono text-3xl font-bold text-emerald-800">
          {formatUsd(escrowBalance)} USDC
        </div>
        {depositTxHash && (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <TxLink hash={depositTxHash} label="Deposit transaction" />
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          🔒 Funds locked — conditions must be met to release.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <div className="text-sm font-semibold text-slate-700">Awaiting fund deposit</div>
      <p className="mt-1 text-xs text-slate-400">
        Record the transaction hash once the depositing party has funded the escrow contract.
      </p>
      <div className="mt-4">
        <label className="label" htmlFor="deposit-tx">
          Deposit Transaction Hash
        </label>
        <div className="flex gap-2">
          <input
            id="deposit-tx"
            className="input"
            value={txHash}
            placeholder="0x…"
            autoComplete="off"
            onChange={(e) => setTxHash(e.target.value)}
          />
          <button
            className="btn btn-primary shrink-0"
            disabled={!txHash.trim() || busy}
            onClick={() => onConfirmDeposit(txHash.trim())}
          >
            Confirm Deposit
          </button>
        </div>
      </div>
    </div>
  );
}

// ── View ─────────────────────────────────────────────────────────────────────

export interface EscrowMonitorViewProps {
  assetClass: AssetClass;
  conditions: Condition[];
  conditionSummary: ConditionSummary;
  fundsDeposited: boolean;
  depositTxHash: string | null;
  escrowBalance: bigint;
  conditionPolling: boolean;
  conditionsUpdatedAt: string | null;
  executionPath: ExecutionPath | null;
  arbitrationState: ArbitrationState | null;
  busy: boolean;
  error: string | null;
  cannaVerifyConditions: CannaVerifyConditionsData | null;
  cannaVerifyRunning: boolean;
  /** Rendered below the checklist. A node so the view stays store-free. */
  eventLog?: React.ReactNode;
  /** Injectable clock — keeps time-condition rendering deterministic in tests. */
  now?: number;
  onConfirmDeposit: (txHash: string) => void;
  onRefresh: () => void;
  onWaiveCondition: (conditionId: string, reason: string) => void;
  onMarkConditionMet: (conditionId: string) => void;
  onRunCannaVerify: () => void;
  onProceedToSettlement: () => void;
  onSignArbitration: (signer: ArbitrationSigner) => void;
  /**
   * Can this install settle on-chain? Defaults to `true` so the many existing
   * call sites and tests that predate the vault-held blockchain config keep
   * their behaviour — the store container passes the real value.
   */
  blockchainReady?: boolean;
}

export function EscrowMonitorView(props: EscrowMonitorViewProps) {
  const {
    assetClass,
    conditions,
    conditionSummary,
    fundsDeposited,
    executionPath,
    arbitrationState,
    busy,
    error,
    now = Date.now(),
    blockchainReady = true,
  } = props;

  const descriptor = descriptorFor(assetClass);
  const { total, met, allMet } = conditionSummary;

  // Path B locks and Path C schedules; neither moves funds from this button, so
  // neither needs a chain configured to get past it. Only Path A settles here.
  const needsChain = executionPath !== ExecutionPath.StagedRelease;
  const chainBlocked = needsChain && !blockchainReady;

  const waived = useMemo(
    () => conditions.filter((c) => c.status === "waived").length,
    [conditions],
  );
  const unmet = useMemo(() => conditions.filter((c) => isUnmet(c.status)), [conditions]);
  // Waived conditions count as satisfied for progress — they are resolved, just
  // not verified. The bar's colour is the same; the card's is not.
  const percent = total > 0 ? Math.round(((met + waived) / total) * 100) : 0;

  return (
    <div className="mx-auto w-full max-w-2xl">
      {/* 1 — Header */}
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 text-xl font-bold tracking-tight text-slate-900">
          <span aria-hidden>🔒</span>
          Escrow Monitor
        </h1>
        <span className="badge badge-brand">
          {descriptor.icon} {descriptor.displayName}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-500">Funds held pending condition verification.</p>

      {/* 2 — Balance */}
      <div className="mt-5">
        <BalanceCard
          fundsDeposited={fundsDeposited}
          depositTxHash={props.depositTxHash}
          escrowBalance={props.escrowBalance}
          busy={busy}
          onConfirmDeposit={props.onConfirmDeposit}
        />
      </div>

      {/* 3 — Checklist */}
      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Release conditions</h2>
        <div className="flex items-center gap-2">
          {props.conditionPolling && (
            <span className="badge badge-brand" title="Re-checking every 30 seconds">
              🔄 Auto-refresh
            </span>
          )}
          <button className="btn btn-secondary" onClick={props.onRefresh} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>

      {conditions.length === 0 ? (
        <div className="card mt-3 p-5 text-sm text-slate-500">
          No conditions have been defined for this escrow.
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {conditions.map((c) => (
            <ConditionCard
              key={c.id}
              condition={c}
              now={now}
              busy={busy}
              cannaVerifyConditions={props.cannaVerifyConditions}
              cannaVerifyRunning={props.cannaVerifyRunning}
              onRunCannaVerify={props.onRunCannaVerify}
              onWaive={props.onWaiveCondition}
              onMarkMet={props.onMarkConditionMet}
            />
          ))}
        </div>
      )}

      {/* 4 — Summary bar */}
      <div className="card mt-4 p-5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">
            {met} of {total} conditions met
            {waived > 0 && <span className="text-slate-400"> · {waived} waived</span>}
          </span>
          <span className="font-mono text-sm font-bold text-slate-800">{percent}%</span>
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200/20">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${percent}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </div>

      {/* 5 — Refresh line */}
      <div className="mt-2 text-right text-[11px] text-slate-400">
        Last updated:{" "}
        {props.conditionsUpdatedAt
          ? new Date(props.conditionsUpdatedAt).toLocaleTimeString()
          : "not yet"}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* 6 — Settlement trigger. Only once the escrow actually holds funds. */}
      {fundsDeposited && (
        <div className="mt-6">
          {allMet ? (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm font-medium text-emerald-700">
              ✅ All conditions met — ready to settle
            </div>
          ) : (
            <div className="rounded-lg border border-[#2D3A4A] bg-[#1A2435] px-4 py-3 text-sm text-slate-500">
              {unmet.length} condition{unmet.length === 1 ? "" : "s"} still pending
            </div>
          )}

          {/* Path B locks rather than settles; Path C opens the milestone
              schedule. Only Path A ends in a single release, so only Path A
              gets a button that says so. */}
          {executionPath === ExecutionPath.ArbitrationEscrow && arbitrationState ? (
            <ArbitrationPanel
              arbitrationState={arbitrationState}
              busy={busy}
              onSign={props.onSignArbitration}
            />
          ) : (
            <>
              {/* Blockchain gate. Distinct from the condition checklist above:
                  conditions are about *this escrow* being ready, this is about
                  *this install* being able to settle at all. An officer who has
                  satisfied every condition and still cannot settle deserves to
                  be told which of the two is missing. */}
              {chainBlocked && (
                <div
                  role="status"
                  className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-700"
                >
                  ⚠️ Blockchain not configured — set up in Configuration
                </div>
              )}
              <div className="mt-4 flex items-center justify-between gap-4">
                <p className="max-w-sm text-xs text-slate-400">
                  {chainBlocked
                    ? "The network, contract and deployer key are held in the vault. Until they are set, settlement cannot be submitted on-chain."
                    : allMet
                      ? "Settlement releases the escrowed funds. This cannot be undone."
                      : `Blocked by: ${unmet.map((c) => c.label).join(", ")}`}
                </p>
                <button
                  className="btn btn-primary btn-lg shrink-0"
                  disabled={!allMet || busy || chainBlocked}
                  title={
                    chainBlocked
                      ? "Blockchain not configured — set it up in Configuration"
                      : allMet
                        ? undefined
                        : `Unmet: ${unmet.map((c) => c.label).join(", ") || "no conditions defined"}`
                  }
                  onClick={props.onProceedToSettlement}
                >
                  {executionPath === ExecutionPath.StagedRelease
                    ? "View Milestone Progress"
                    : executionPath === ExecutionPath.ArbitrationEscrow
                      ? "Lock Escrow into Arbitration"
                      : "Proceed to Settlement"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {props.eventLog}
    </div>
  );
}

// ── Store container ──────────────────────────────────────────────────────────

export function EscrowMonitor() {
  const {
    assetClass,
    conditions,
    conditionSummary,
    fundsDeposited,
    depositTxHash,
    escrowBalance,
    conditionPolling,
    conditionsUpdatedAt,
    payload,
    arbitrationState,
    busy,
    error,
    cannaVerifyConditions,
    cannaVerifyRunning,
    sessionId,
    confirmFundsDeposited,
    updateConditions,
    waiveCondition,
    markConditionMet,
    runCannaVerify,
    proceedToSettlement,
    signArbitration,
    startConditionPolling,
    stopConditionPolling,
    blockchainReady,
    refreshBlockchainConfig,
  } = useSession();

  // Read the vault's blockchain config on arrival. This screen is where the
  // officer waits for conditions to clear, so it is the last calm moment before
  // settlement — the right place to discover a missing chain config, rather
  // than on the click that was supposed to move the money.
  useEffect(() => {
    void refreshBlockchainConfig();
  }, [refreshBlockchainConfig]);

  // Watch while there is something to watch, and stop the moment there is not.
  //
  // `confirmFundsDeposited` starts the sweep itself, but that alone would leave
  // a funded escrow un-monitored if the officer navigated away and came back —
  // and it is precisely the long waits that they navigate away from. The
  // cleanup matters just as much in the other direction: a dangling interval
  // would keep polling a session that may since have been reset.
  const allMet = conditionSummary.allMet;
  useEffect(() => {
    if (fundsDeposited && !allMet) startConditionPolling();
    return stopConditionPolling;
  }, [fundsDeposited, allMet, startConditionPolling, stopConditionPolling]);

  return (
    <EscrowMonitorView
      assetClass={assetClass}
      conditions={conditions}
      conditionSummary={conditionSummary}
      fundsDeposited={fundsDeposited}
      depositTxHash={depositTxHash}
      escrowBalance={fundsDeposited || !payload ? escrowBalance : toPayloadCents(payload).totalHeldCents}
      conditionPolling={conditionPolling}
      conditionsUpdatedAt={conditionsUpdatedAt}
      executionPath={payload?.recommendedPath ?? null}
      arbitrationState={arbitrationState}
      busy={busy}
      error={error}
      cannaVerifyConditions={cannaVerifyConditions}
      cannaVerifyRunning={cannaVerifyRunning}
      eventLog={sessionId ? <CREEventLog sessionId={sessionId} /> : null}
      onConfirmDeposit={(txHash) => confirmFundsDeposited(txHash)}
      onRefresh={() => updateConditions()}
      onWaiveCondition={(id, reason) => waiveCondition(id, reason)}
      onMarkConditionMet={(id) => markConditionMet(id)}
      onRunCannaVerify={() => void runCannaVerify()}
      onProceedToSettlement={() => void proceedToSettlement()}
      onSignArbitration={(signer) => void signArbitration(signer)}
      blockchainReady={blockchainReady}
    />
  );
}
