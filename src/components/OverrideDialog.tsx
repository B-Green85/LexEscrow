/**
 * <OverrideDialog /> — spec §30, Scenario 3.
 *
 * The nudge loop succeeded and LexGuard wrote a corrected value; the officer
 * disagrees. This is the dialog that lets them substitute their own value.
 *
 * Rendered inline beneath the corrected field rather than as a modal overlay —
 * the officer is comparing their value against the surrounding payload, so
 * covering that payload with a modal would remove exactly the context the
 * decision needs.
 *
 * The reason field is mandatory by design. Per spec, an override is a conscious
 * departure from automated validation; the written reason is what protects the
 * officer if the value is later disputed.
 */

import { useState } from "react";
import { formatFieldValue } from "../lib/corrections";

export interface OverrideDialogProps {
  fieldName: string;
  lexGuardValue: string | number;
  onConfirm: (overrideValue: string | number, reason: string) => void;
  onCancel: () => void;
}

/** Both inputs must carry content — an override with no stated reason is not an override. */
export function canApplyOverride(value: string, reason: string): boolean {
  return value.trim().length > 0 && reason.trim().length > 0;
}

export function OverrideDialog({
  fieldName,
  lexGuardValue,
  onConfirm,
  onCancel,
}: OverrideDialogProps) {
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const ready = canApplyOverride(value, reason);

  return (
    <div
      className="mt-2 overflow-hidden rounded-lg border border-brand/40 bg-app-card"
      data-testid="override-dialog"
    >
      <div className="flex items-center gap-2 border-b border-brand/30 bg-brand/10 px-4 py-2.5">
        <span aria-hidden="true">✏️</span>
        <span className="text-sm font-bold text-text-primary">Override LexGuard Correction</span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-xs uppercase tracking-wide text-text-muted">Field</span>
          <span className="font-mono text-sm text-text-muted">{fieldName}</span>
        </div>

        <div className="flex items-baseline justify-between gap-4">
          <span className="text-xs uppercase tracking-wide text-text-muted">LexGuard corrected to</span>
          <span className="font-mono text-sm font-semibold text-amber-400">
            {formatFieldValue(fieldName, lexGuardValue)}
          </span>
        </div>

        <div>
          <label className="label" htmlFor={`override-value-${fieldName}`}>
            Your override value
          </label>
          <input
            id={`override-value-${fieldName}`}
            className="input font-mono"
            value={value}
            placeholder="enter override value"
            onChange={(e) => setValue(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor={`override-reason-${fieldName}`}>
            Reason (required)
          </label>
          <textarea
            id={`override-reason-${fieldName}`}
            className="input min-h-[72px] resize-y"
            value={reason}
            placeholder="explain why you are overriding LexGuard — mandatory"
            onChange={(e) => setReason(e.target.value)}
          />
          {!reason.trim() && (
            <p className="mt-1 text-xs text-text-muted">
              LexGuard cannot be overridden silently — state your reason to continue.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel — Keep LexGuard Value
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready}
            onClick={() => onConfirm(value.trim(), reason.trim())}
          >
            Apply Override
          </button>
        </div>
      </div>
    </div>
  );
}
