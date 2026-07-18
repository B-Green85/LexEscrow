/**
 * <CorrectedField /> — spec §28 (Stage 4 corrected-field visual) and §30.
 *
 * Wraps any Stage 4 payload field the nudge loop corrected. The officer sees
 * what AI originally extracted, what LexGuard corrected it to, and which module
 * and constraint forced the change — enough to judge the correction without
 * leaving the review screen.
 *
 * The Override button is revealed on hover via Tailwind's `group`/`group-hover`
 * so the row stays readable at rest, but it is also focusable, so the control is
 * reachable by keyboard rather than hover-only.
 */

import { useState } from "react";
import { OverrideDialog } from "./OverrideDialog";
import { formatFieldValue } from "../lib/corrections";

export interface CorrectedFieldProps {
  /** Payload field name — the identity used for money detection and the audit trail. */
  fieldName: string;
  /** Display label, when the screen shows something friendlier than the field name. */
  label?: string;
  correctedValue: string | number;
  originalAiValue: string | number;
  /** Which LexGuard module caught it. */
  module: string;
  /** Human-readable rule that was violated. */
  constraint: string;
  onOverride: (value: string | number, reason: string) => void;
}

export function CorrectedField({
  fieldName,
  label,
  correctedValue,
  originalAiValue,
  module,
  constraint,
  onOverride,
}: CorrectedFieldProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="group -mx-2 rounded-lg bg-amber-50 px-2 py-1.5" data-testid={`corrected-${fieldName}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-amber-800">{label ?? fieldName}</span>

        <span className="flex items-center gap-2">
          <span className="font-mono text-sm text-slate-400 line-through" data-testid="original-value">
            {formatFieldValue(fieldName, originalAiValue)}
          </span>
          <span className="font-mono text-sm font-bold text-amber-700" data-testid="corrected-value">
            {formatFieldValue(fieldName, correctedValue)}
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded border border-amber-300 px-2 py-0.5 text-xs font-semibold text-amber-800
              opacity-0 transition-opacity hover:bg-amber-100 focus:opacity-100
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 group-hover:opacity-100"
          >
            Override
          </button>
        </span>
      </div>

      <div className="mt-0.5 text-xs text-amber-700">
        ⚠ LexGuard corrected — {module}: {constraint}
      </div>

      {open && (
        <OverrideDialog
          fieldName={fieldName}
          lexGuardValue={correctedValue}
          onCancel={() => setOpen(false)}
          onConfirm={(value, reason) => {
            setOpen(false);
            onOverride(value, reason);
          }}
        />
      )}
    </div>
  );
}
