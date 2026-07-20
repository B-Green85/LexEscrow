/**
 * LexGuard escalation dialog — spec §29 (Scenario 2) and §31 (multi-field cascade).
 *
 * Three nudge attempts failed, so LexGuard hands the decision to a human. The
 * dialog shows what the document says, what AI returned on every attempt, and
 * an editable field pre-filled with LexGuard's own extraction. The officer can
 * accept that default or type their own value.
 *
 * The confirm gate — every field answered *and* the attestation checked — is
 * the liability-transfer moment. It is deliberately not skippable.
 *
 * Split into a pure `LexGuardEscalationView` and a store-connected wrapper, the
 * same shape as `ConditionDefinition`, so the dialog's gating logic can be
 * exercised without standing up a session.
 */

import { useMemo, useState } from "react";
import { useSession, type HumanCorrectionInput } from "../store/session";
import type { Escalation, EscalationDiscrepancy } from "../lexguard/pipeline";
import {
  escalationFindings,
  formatFieldValue,
  inputValueFor,
  isMoneyField,
  parseFieldInput,
} from "../lib/corrections";
import { SourceDocumentViewer } from "../components/SourceDocumentViewer";

export interface LexGuardEscalationViewProps {
  escalation: Escalation;
  /** Artifact text behind "View Source Document"; null when no artifact is loaded. */
  normalizedText: string | null;
  busy: boolean;
  onConfirm: (corrections: HumanCorrectionInput[]) => void;
  onReviewDocument: () => void;
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.345 0-2.188-1.458-1.515-2.625L8.485 2.495zM10 6a1 1 0 00-1 1v3a1 1 0 102 0V7a1 1 0 00-1-1zm0 8a1 1 0 100-2 1 1 0 000 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** One "AI parsed (nudge n)" row. Attempts that never landed read as an em dash. */
function AttemptRow({
  label,
  field,
  value,
}: {
  label: string;
  field: string;
  value: number | string | undefined;
}) {
  const missing = value === undefined || value === null || value === "";
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`font-mono text-sm ${missing ? "text-text-muted" : "font-medium text-red-400"}`}>
        {missing ? "—" : formatFieldValue(field, value)}
      </span>
    </div>
  );
}

/** Inputs pre-filled from LexGuard's own extraction, keyed by field position. */
function defaultValues(findings: EscalationDiscrepancy[]): Record<number, string> {
  return Object.fromEntries(findings.map((f, i) => [i, inputValueFor(f.field, f.observedValue)]));
}

export function LexGuardEscalationView({
  escalation,
  normalizedText,
  busy,
  onConfirm,
  onReviewDocument,
}: LexGuardEscalationViewProps) {
  const findings = useMemo(() => escalationFindings(escalation), [escalation]);

  // Keyed by position, not field name — a cascade can surface the same field
  // from two different modules.
  const [values, setValues] = useState<Record<number, string>>(() => defaultValues(findings));
  const [attested, setAttested] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  // A correction can introduce a *new* discrepancy, and the screen stays on
  // `escalation` when it does — same component instance, different escalation.
  // Without this reset the officer would face fresh findings carrying the last
  // round's values and an attestation checkbox still ticked, which would let
  // them confirm values they never looked at. Attestation is per-escalation.
  const [attestedFor, setAttestedFor] = useState(escalation);
  if (attestedFor !== escalation) {
    setAttestedFor(escalation);
    setValues(defaultValues(findings));
    setAttested(false);
    setViewerOpen(false);
  }

  // A field counts as answered only if it also *parses* — a money field holding
  // "abcd" is not an answer, and must never reach a settlement payload.
  const parsed = findings.map((f, i) => parseFieldInput(f.field, values[i] ?? ""));
  const remaining = parsed.filter((v) => v === null).length;
  const canConfirm = remaining === 0 && attested && !busy;

  const submit = () => {
    if (!canConfirm) return;
    onConfirm(
      findings.map((f, i) => ({ field: f.field, value: parsed[i] as number | string })),
    );
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="card overflow-hidden border-amber-300">
        <div className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-6 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 text-amber-600">
            <WarningIcon />
          </div>
          <div>
            <div className="text-sm font-bold text-amber-900">
              LexGuard Escalation — Manual Correction Required
            </div>
            <div className="text-xs text-amber-800">
              {findings.length === 1
                ? "Three correction attempts failed. Confirm the correct value before processing resumes."
                : `${findings.length} fields require correction. Work through each before processing resumes.`}
            </div>
          </div>
        </div>

        <div className="space-y-4 px-6 py-5">
          {findings.map((finding, i) => {
            const answered = parsed[i] !== null;
            return (
              <div
                key={`${finding.field}-${i}`}
                className="rounded-lg border border-app-border bg-app-input p-4"
                data-testid={`escalation-field-${i}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-text-primary">
                    Field {i + 1} of {findings.length}: <span className="font-mono">{finding.field}</span>
                  </div>
                  <span className="badge badge-slate">{finding.module}</span>
                </div>

                <div className="mt-3 divide-y divide-app-border">
                  <div className="flex items-baseline justify-between gap-4 py-1">
                    <span className="text-xs text-text-muted">Document says</span>
                    <span
                      className="font-mono text-sm font-semibold text-emerald-400"
                      data-selectable
                      data-testid={`document-says-${i}`}
                    >
                      {formatFieldValue(finding.field, finding.observedValue)}
                    </span>
                  </div>
                  <AttemptRow label="AI parsed (nudge 1)" field={finding.field} value={finding.aiAttempt1} />
                  <AttemptRow label="AI parsed (nudge 2)" field={finding.field} value={finding.aiAttempt2} />
                  <AttemptRow label="AI parsed (nudge 3)" field={finding.field} value={finding.aiAttempt3} />
                </div>

                <div className="mt-3">
                  <label className="label" htmlFor={`correct-value-${i}`}>
                    Correct value
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id={`correct-value-${i}`}
                      className="input font-mono"
                      inputMode={isMoneyField(finding.field) ? "decimal" : "text"}
                      value={values[i] ?? ""}
                      placeholder={
                        isMoneyField(finding.field) ? "enter correct amount" : "enter correct value"
                      }
                      onChange={(e) => setValues((prev) => ({ ...prev, [i]: e.target.value }))}
                    />
                    <span
                      aria-hidden="true"
                      className={`w-4 text-lg ${answered ? "text-emerald-400" : "text-text-muted"}`}
                      data-testid={`field-check-${i}`}
                    >
                      {answered ? "✓" : ""}
                    </span>
                  </div>
                  {isMoneyField(finding.field) && (
                    <p className="mt-1 text-xs text-text-muted">Enter a dollar amount, e.g. 18500.00</p>
                  )}
                </div>
              </div>
            );
          })}

          <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-amber-50 px-3 py-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-app-border accent-brand focus:ring-2 focus:ring-brand/40"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
            <span className="text-sm text-amber-800">
              I have reviewed the source document and confirm this value is correct
            </span>
          </label>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!normalizedText}
              onClick={() => setViewerOpen(true)}
            >
              View Source Document
            </button>
            <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={submit}>
              {busy ? "Applying…" : `Confirm All (${remaining} remaining)`}
            </button>
          </div>

          <div className="border-t border-app-border pt-3">
            <button
              type="button"
              className="btn btn-secondary w-full"
              disabled={busy}
              onClick={onReviewDocument}
            >
              Review Document
            </button>
            <p className="mt-3 text-center text-xs text-text-muted">
              Corrections are logged as HUMAN_CORRECTION with your identity, all AI attempts, and a
              timestamp.
            </p>
          </div>
        </div>
      </div>

      {viewerOpen && normalizedText && (
        <SourceDocumentViewer text={normalizedText} onClose={() => setViewerOpen(false)} />
      )}
    </div>
  );
}

export function LexGuardEscalation() {
  const { escalation, artifact, busy, resolveEscalationWithCorrections, resolveEscalation } =
    useSession();
  if (!escalation) return null;

  return (
    <LexGuardEscalationView
      escalation={escalation}
      normalizedText={artifact?.normalizedText ?? null}
      busy={busy}
      onConfirm={(corrections) => void resolveEscalationWithCorrections(corrections)}
      onReviewDocument={() => void resolveEscalation("review")}
    />
  );
}
