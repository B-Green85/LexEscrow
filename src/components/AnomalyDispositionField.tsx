// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * <AnomalyDispositionField /> — the correction control for the
 * `anomaliesSuppressed` escalation finding (spec §31).
 *
 * Unlike every other escalation finding, a suppressed-anomaly finding is not a
 * value the officer restates — it is a set of individually-flagged anomalies
 * that each need a human decision. This component lists every anomaly the parser
 * flagged and makes the officer disposition each one as Acknowledged (reviewed,
 * not blocking) or Blocking (real, must not direct-settle). The parent gates the
 * escalation on the result: all Acknowledged flows into "Confirm All"; any
 * Blocking forces escalation to arbitration.
 *
 * Pure and prop-driven — the parent owns the choices so the same state feeds the
 * confirm gate, the audit log, and the arbitration route.
 */

import type { AnomalyChoice } from "../lib/corrections";

export interface AnomalyDispositionFieldProps {
  anomalies: string[];
  /** Current disposition per anomaly index; absent until the officer chooses. */
  value: Record<number, AnomalyChoice>;
  disabled?: boolean;
  onChange: (index: number, choice: AnomalyChoice) => void;
}

export function AnomalyDispositionField({
  anomalies,
  value,
  disabled,
  onChange,
}: AnomalyDispositionFieldProps) {
  if (anomalies.length === 0) {
    return (
      <p className="text-xs text-text-muted" data-testid="anomaly-disposition-empty">
        No anomalies were recorded on the payload.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="anomaly-disposition">
      {anomalies.map((description, i) => {
        const choice = value[i];
        return (
          <div
            key={i}
            className="rounded-md border border-app-border bg-app-surface p-3"
            data-testid={`anomaly-${i}`}
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-text-primary">{description}</p>
              <span
                aria-hidden="true"
                className="w-5 shrink-0 text-right text-lg"
                data-testid={`anomaly-status-${i}`}
              >
                {choice === "acknowledged" ? (
                  <span className="text-emerald-400">✓</span>
                ) : choice === "blocking" ? (
                  <span className="text-red-400">✕</span>
                ) : (
                  ""
                )}
              </span>
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={disabled}
                aria-pressed={choice === "acknowledged"}
                className={`btn btn-sm ${choice === "acknowledged" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => onChange(i, "acknowledged")}
                data-testid={`anomaly-ack-${i}`}
              >
                Acknowledged
              </button>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={choice === "blocking"}
                className={`btn btn-sm ${choice === "blocking" ? "btn-danger" : "btn-secondary"}`}
                onClick={() => onChange(i, "blocking")}
                data-testid={`anomaly-block-${i}`}
              >
                Blocking
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
