/**
 * CRE event log — the settlement-relevant slice of the audit trail (spec §13).
 *
 * The full hash-chained trail records everything, including scroll timings and
 * acknowledgment checkboxes. That is the right level of detail for a compliance
 * export and the wrong level for a monitoring screen, so this component shows
 * only the events that represent an *external* system acting on the escrow:
 * registrations, verifications, signatures, deposits, releases.
 *
 * Each row stays collapsed to one line; the full `payload_json` is one click
 * away. The officer is scanning for what happened, not reading JSON — but when
 * something looks wrong, the evidence must be reachable without leaving the
 * screen.
 */

import { useEffect, useState } from "react";
import * as backend from "../lib/backend";
import { useSession } from "../store/session";

/** Events that represent a CRE / external-system action on the escrow. */
export const CRE_EVENT_TYPES: readonly string[] = [
  "anchor_receipt_issued",
  "cannaverify_completed",
  "esign_sent",
  "esign_completed",
  "arbitration_locked",
  "staged_release_initiated",
  "milestone_released",
  "cre_workflow_triggered",
  "cre_execution_started",
  "cre_execution_completed",
  "funds_deposited",
  "condition_waived",
];

export const EVENT_LABELS: Record<string, string> = {
  anchor_receipt_issued: "📋 AnchorReceipt registered",
  cannaverify_completed: "🔍 CannaVerify completed",
  esign_sent: "✍️ Signature request sent",
  esign_completed: "✅ Signatures collected",
  funds_deposited: "💰 Funds deposited to escrow",
  cre_workflow_triggered: "⚡ CRE workflow triggered",
  cre_execution_started: "⚡ CRE settlement initiated",
  cre_execution_completed: "✅ Settlement complete",
  condition_waived: "〜 Condition waived",
  milestone_released: "💸 Milestone released",
};

/** Human label for an event type, falling back to the raw name. */
export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType;
}

/** Pretty-print the stored payload, tolerating a non-JSON string. */
function formatPayload(payloadJson: string): string {
  try {
    return JSON.stringify(JSON.parse(payloadJson), null, 2);
  } catch {
    return payloadJson;
  }
}

/**
 * The DON execution ID an event carries, if any.
 *
 * Surfaced on the collapsed row rather than left to the expanded JSON because
 * this is the one value an officer copies out of this screen — it is what
 * `cre execution list` and the LexTrace poll match on. Everything else in the
 * payload is context for when something looks wrong; this is the handle.
 */
function executionIdOf(payloadJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const id = (parsed as Record<string, unknown>).execution_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

export interface CREEventLogProps {
  sessionId: string;
  maxEvents?: number; // default 10
}

export function CREEventLog({ sessionId, maxEvents = 10 }: CREEventLogProps) {
  const [events, setEvents] = useState<backend.AuditEntry[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  // Re-fetch whenever the session state that *causes* an audit write moves.
  // The trail has no change notification of its own, and polling it on a timer
  // of its own would double the wake-ups for no extra freshness — every event
  // this log cares about lands alongside one of these.
  const signal = useSession((s) => s.conditionsUpdatedAt);
  const depositSignal = useSession((s) => s.depositTxHash);
  const phaseSignal = useSession((s) => s.execution.phase);
  const envelopeSignal = useSession((s) => s.eSignEnvelopes.length);

  useEffect(() => {
    let live = true;
    backend
      .getAuditTrail(sessionId)
      .then((trail) => {
        if (!live) return;
        const relevant = trail.filter((e) => CRE_EVENT_TYPES.includes(e.eventType));
        // Newest first, capped — the tail is in the full audit export.
        setEvents(relevant.slice(-maxEvents).reverse());
      })
      .catch(() => {
        if (live) setEvents([]);
      });
    return () => {
      live = false;
    };
  }, [sessionId, maxEvents, signal, depositSignal, phaseSignal, envelopeSignal]);

  return (
    <div className="card mt-4 p-5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-text-primary">CRE event log</div>
        <span className="text-[11px] text-text-muted">
          {events.length === 0 ? "no events yet" : `last ${events.length}`}
        </span>
      </div>

      {events.length === 0 ? (
        <p className="mt-3 text-xs text-text-muted">
          Registrations, verifications and settlement actions appear here as they happen.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {events.map((e) => {
            const open = expanded === e.logId;
            const executionId = executionIdOf(e.payloadJson);
            return (
              <li key={e.logId} className="rounded-lg border border-app-border bg-app-input">
                <button
                  className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left"
                  onClick={() => setExpanded(open ? null : e.logId)}
                  aria-expanded={open}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-text-primary">
                      {eventLabel(e.eventType)}
                    </span>
                    {executionId && (
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-text-muted">
                        Execution ID: {executionId}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-text-muted">
                    {timeOf(e.blockTimestamp)}
                  </span>
                </button>
                {open && (
                  <pre className="overflow-x-auto border-t border-app-border px-3 py-2 font-mono text-[11px] text-text-muted">
                    {formatPayload(e.payloadJson)}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
