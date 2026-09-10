import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSession, type LexGuardCorrection } from "../store/session";
import { ExecutionPath } from "../lexguard/types";
import { formatUsd, toCents } from "../lexguard/payload-diff";
import { CannaVerifyConditions } from "../components/CannaVerifyConditions";
import { CorrectedField } from "../components/CorrectedField";
import { constraintFor, parseFieldInput } from "../lib/corrections";

const $ = (n: number) => formatUsd(toCents(n));

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-text-muted">{label}</span>
      <span className={`text-sm font-medium text-text-primary ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

/**
 * The correction LexGuard actually landed on for each field — the last
 * *resolved* nudge. Unresolved attempts are history, not applied values, so
 * highlighting them at Stage 4 would claim a change that never happened.
 */
function appliedCorrections(corrections: LexGuardCorrection[]): Map<string, LexGuardCorrection> {
  const applied = new Map<string, LexGuardCorrection>();
  for (const c of corrections) {
    if (c.resolved) applied.set(c.field, c);
  }
  return applied;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{children}</div>
  );
}

/**
 * A money row, rendered as a corrected field when LexGuard changed it.
 *
 * Declared at module scope, not inside `ParsedOutputReview`. A component
 * defined during render gets a fresh function identity every time, so React
 * would unmount and remount this subtree on *any* store change — discarding a
 * half-typed override dialog underneath the officer.
 */
function MoneyRow({
  label,
  field,
  value,
  correction,
  overridden,
  onOverride,
}: {
  label: string;
  field: string;
  value: number;
  correction: LexGuardCorrection | undefined;
  overridden: boolean;
  onOverride: (field: string, value: string | number, reason: string) => void;
}) {
  if (!correction || overridden) return <Row label={label} value={$(value)} mono />;
  return (
    <CorrectedField
      fieldName={field}
      label={label}
      correctedValue={value}
      originalAiValue={correction.aiValue}
      module={correction.module}
      constraint={constraintFor(correction.module, field)}
      onOverride={(overrideValue, reason) => onOverride(field, overrideValue, reason)}
    />
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
    navigateToConditions,
    error,
    busy,
    assetClass,
    cannaVerifyConditions,
    cannaVerifyRunning,
    runCannaVerify,
    applyHumanOverride,
    intakeSource,
    clioMatter,
  } = useSession();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fields the officer has overridden this session, and the banner that tells
  // them the review gate reopened because of it (spec §30).
  const [overridden, setOverridden] = useState<Set<string>>(new Set());
  const [overrideNotice, setOverrideNotice] = useState<string | null>(null);

  const applied = useMemo(() => appliedCorrections(corrections), [corrections]);
  const pendingCorrections = useMemo(
    () => [...applied.keys()].filter((field) => !overridden.has(field)),
    [applied, overridden],
  );

  const handleOverride = (field: string, raw: string | number, reason: string) => {
    const value = typeof raw === "number" ? raw : parseFieldInput(field, raw);
    // The dialog gates on a non-empty value, but a money field can still hold
    // something unparseable — refuse rather than write NaN into a settlement.
    if (value === null) return;
    setOverridden((prev) => new Set(prev).add(field));
    setOverrideNotice("Override applied — please re-review the full payload");
    void applyHumanOverride({ field, overrideValue: value, reason });
  };

  const moneyRowProps = (field: string) => ({
    field,
    correction: applied.get(field),
    overridden: overridden.has(field),
    onOverride: handleOverride,
  });

  // Cannabis IND: state licensure must verify before any funds move (spec §5).
  const isCannabis = assetClass === "cannabis_ind";
  const cannaBlocked = isCannabis && cannaVerifyConditions?.overallResult !== "PASS";

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
        <h1 className="text-xl font-semibold text-text-primary">Review parsed output</h1>
        <span className={corrections.length ? "badge badge-amber" : "badge badge-emerald"}>
          {corrections.length
            ? `${corrections.length} correction${corrections.length > 1 ? "s" : ""} made`
            : "No corrections required"}
        </span>
      </div>
      <p className="mt-1 text-sm text-text-muted">
        LexGuard reviewed and validated the AI output. Review the complete parsed output carefully —
        errors in parsing will affect fund distribution.
      </p>
      {providerLabel && <p className="mt-1 text-xs text-text-muted">Parsed via {providerLabel}.</p>}

      {/* Provenance, at the one moment it changes how the officer reads the
          numbers below. On the Clio path these figures were extracted from a
          live matter record rather than from a signed retainer, so there is no
          document to check them against — the matter is the source, and if a
          total looks wrong the place to correct it is Clio. Naming the matter
          rather than just the source makes that check actionable. */}
      {intakeSource === "clio" && clioMatter && (
        <p className="mt-2">
          <span className="badge badge-brand" data-testid="clio-source-badge">
            📋 Data sourced from Clio Manage — matter {clioMatter.displayNumber}
          </span>
        </p>
      )}

      {pendingCorrections.length > 0 && (
        <div
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          data-testid="corrections-banner"
        >
          <span className="font-semibold">
            {pendingCorrections.length} LexGuard correction
            {pendingCorrections.length > 1 ? "s" : ""} applied
          </span>{" "}
          — review highlighted fields below. Hover a corrected field to override it.
        </div>
      )}

      {overrideNotice && (
        <div
          className="mt-3 rounded-lg border border-brand/40 bg-brand/10 px-4 py-3 text-sm text-brand-fg"
          role="status"
          data-testid="override-notice"
        >
          {overrideNotice}
        </div>
      )}

      <div className="card mt-5 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-selectable
          className="max-h-[44vh] overflow-y-auto px-6 py-4"
        >
          <SectionTitle>Parties</SectionTitle>
          <div className="divide-y divide-app-border">
            <Row label="Client" value={payload.clientName ?? "—"} />
            <Row label="Client ID" value={payload.clientId} />
            <Row label="Client wallet" value={payload.clientWallet} mono />
            <Row label="Law firm wallet" value={payload.lawFirmWallet} mono />
          </div>

          <SectionTitle>Billing reconciliation</SectionTitle>
          <div className="divide-y divide-app-border">
            <MoneyRow label="Total retainer held" value={payload.totalHeld} {...moneyRowProps("totalHeld")} />
            <MoneyRow label="Earned fees (firm)" value={payload.earnedFees} {...moneyRowProps("earnedFees")} />
            <MoneyRow
              label="Unearned balance (client)"
              value={payload.unearnedBalance}
              {...moneyRowProps("unearnedBalance")}
            />
            <Row label="Disputed hours" value={payload.disputedHours.toFixed(1)} mono />
            <MoneyRow
              label="Disputed amount"
              value={payload.disputedAmount}
              {...moneyRowProps("disputedAmount")}
            />
          </div>

          <SectionTitle>Determination</SectionTitle>
          <div className="divide-y divide-app-border">
            <Row
              label="Recommended path"
              value={
                payload.recommendedPath === ExecutionPath.StagedRelease
                  ? "Path C — Staged Release"
                  : isDirect
                    ? "Path A — Direct Settlement"
                    : "Path B — Arbitration Escrow"
              }
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
            <p className="py-2 text-sm text-text-muted">No corrections were required during parsing.</p>
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

          <div className="mt-4 rounded-md bg-app-input px-3 py-2 text-center text-xs text-text-muted">
            — end of parsed output —
          </div>
        </div>

        {/* Cannabis IND — regulatory conditions gate settlement (spec §5). */}
        {isCannabis && (
          <div className="px-6">
            <CannaVerifyConditions
              conditions={cannaVerifyConditions}
              running={cannaVerifyRunning}
              onRun={() => void runCannaVerify()}
            />
          </div>
        )}

        {/* Acknowledgment footer */}
        <div className="mt-5 border-t border-app-border bg-app-input px-6 py-4">
          {!scrollCompleted ? (
            <p className="text-center text-sm text-text-muted">
              Scroll to the bottom of the parsed output to continue.
            </p>
          ) : (
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-app-border accent-brand focus:ring-2 focus:ring-brand/40"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span className="text-sm text-text-primary">
                I have reviewed the complete parsed output and confirm it is accurate.
              </span>
            </label>
          )}

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          {cannaBlocked && scrollCompleted && acknowledged && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              🌿 CannaVerify must pass before this cannabis transaction can settle.
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <button
              className="btn btn-primary btn-lg"
              disabled={!scrollCompleted || !acknowledged || busy || cannaBlocked}
              onClick={() => navigateToConditions()}
            >
              {busy ? "Verifying…" : "Proceed to Conditions"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
