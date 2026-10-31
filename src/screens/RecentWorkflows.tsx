// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Screen 9 — Recent Workflows (spec §12).
 *
 * The session history, reached from File → Recent Workflows (Cmd+R). Read-only
 * by design: this is where an officer goes to answer "what did we do, and can I
 * prove it", not to resume work. The proof lives behind the per-row audit-trail
 * button, which shows the hash-chained record exactly as it is stored.
 *
 * Split into a pure `RecentWorkflowsView` and a store container, matching the
 * AnchorReceipt Console and Execution Confirmation screens: the view takes all
 * state as props so it render-tests without a live store.
 */

import { useEffect, useState } from "react";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import { ASSET_CLASSES, type AssetClass } from "../lib/assetClasses";

/** How many sessions the list asks for. Mirrors the backend's default. */
export const RECENT_LIMIT = 20;

/**
 * Case-insensitive substring match across the fields an officer would search
 * by. Every field is one they can actually see in the table — searching a
 * column that is not on screen produces matches with no visible reason.
 */
export function filterSessions(
  sessions: backend.RecentSessionRow[],
  term: string,
): backend.RecentSessionRow[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((s) =>
    [s.clientId, s.assetClass, s.sessionId, s.currentState, s.executionPath ?? ""].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

/**
 * State → badge tone. Anything unrecognized falls through to slate rather than
 * throwing: `current_state` is CHECK-constrained in SQLite, but a row written
 * by a newer build than this screen would otherwise crash the list.
 */
function stateTone(state: string): string {
  switch (state) {
    case "EXECUTED":
      return "badge-emerald";
    case "FAILED":
      return "badge-red";
    case "ESCALATED":
      return "badge-amber";
    case "APPROVED":
    case "FUNDED":
    case "VERIFYING":
      return "badge-brand";
    default:
      return "badge-slate";
  }
}

function assetLabel(assetClass: string): string {
  const known = ASSET_CLASSES[assetClass as AssetClass];
  return known ? `${known.icon} ${known.displayName}` : assetClass;
}

/** Execution path is null until a release path is chosen. */
function pathLabel(path: string | null): string {
  if (!path) return "—";
  return path.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function dateLabel(iso: string): string {
  const parsed = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

function amountLabel(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 13)}…` : id;
}

// ── Audit trail modal ────────────────────────────────────────────────────────

/**
 * The hash chain, shown as a chain.
 *
 * Each entry displays the previous hash it commits to alongside its own, so the
 * linkage an auditor would check by hand is visible on the screen rather than
 * asserted by a "verified ✓" badge. The first entry's missing previous hash is
 * labelled as the chain origin, not rendered as an empty cell.
 */
export function AuditTrailModal({
  sessionId,
  entries,
  loading,
  error,
  onClose,
}: {
  sessionId: string;
  entries: backend.AuditEntry[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Audit trail"
      data-testid="audit-trail-modal"
    >
      <div className="card w-full max-w-3xl">
        <div className="flex items-start justify-between gap-4 border-b border-app-border px-5 py-4">
          <div className="min-w-0">
            <div className="text-sm font-bold text-text-primary">Audit Trail</div>
            <div className="mt-0.5 truncate font-mono text-xs text-text-muted">{sessionId}</div>
          </div>
          <button className="btn btn-secondary btn-sm shrink-0" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="px-5 py-4">
          {loading && <div className="text-sm text-text-muted">Loading audit trail…</div>}

          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <div className="text-sm text-text-muted">
              This session has no audit entries — nothing consequential happened before it ended.
            </div>
          )}

          {!loading && !error && entries.length > 0 && (
            <ol className="space-y-3">
              {entries.map((entry) => (
                <li key={entry.logId} className="rounded-lg border border-app-border bg-app-input p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-mono text-sm font-semibold text-brand-fg">
                      #{entry.logId} · {entry.eventType}
                    </span>
                    <span className="text-xs text-text-muted">{dateLabel(entry.blockTimestamp)}</span>
                  </div>

                  <div className="mt-1 text-xs text-text-muted">by {entry.userIdentity}</div>

                  <div className="mt-2 space-y-1 border-t border-app-border pt-2 font-mono text-[11px]">
                    <div className="flex gap-2">
                      <span className="shrink-0 text-text-muted">prev</span>
                      <span className="min-w-0 break-all text-text-muted" data-selectable>
                        {entry.previousHash ?? "— chain origin —"}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <span className="shrink-0 text-text-muted">this</span>
                      <span className="min-w-0 break-all text-emerald-400" data-selectable>
                        {entry.entryHash}
                      </span>
                    </div>
                  </div>

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-text-muted hover:text-text-primary">
                      Payload
                    </summary>
                    <pre className="mt-1.5 overflow-x-auto rounded bg-app-bg p-2 text-[11px] text-text-muted">
                      {entry.payloadJson}
                    </pre>
                  </details>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Pure view ────────────────────────────────────────────────────────────────

export interface RecentWorkflowsViewProps {
  sessions: backend.RecentSessionRow[];
  loading: boolean;
  error: string | null;
  search: string;
  onSearchChange: (term: string) => void;
  auditSessionId: string | null;
  auditEntries: backend.AuditEntry[];
  auditLoading: boolean;
  auditError: string | null;
  onViewAudit: (sessionId: string) => void;
  onCloseAudit: () => void;
  onNewTransaction: () => void;
  onClose: () => void;
}

export function RecentWorkflowsView(props: RecentWorkflowsViewProps) {
  const { sessions, loading, error, search, auditSessionId } = props;
  const visible = filterSessions(sessions, search);
  const searching = search.trim().length > 0;

  return (
    <div className="w-full">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Recent Workflows</h1>
          <p className="mt-1 text-sm text-text-muted">
            The last {RECENT_LIMIT} escrow sessions on this install, newest first. Read-only — open
            a session's audit trail to see its hash-chained record.
          </p>
        </div>
        <button className="btn btn-secondary shrink-0" onClick={props.onClose}>
          Close
        </button>
      </div>

      {/* ── Search ── */}
      <div className="mt-6">
        <label className="sr-only" htmlFor="recent-search">
          Search workflows
        </label>
        <div className="relative">
          <input
            id="recent-search"
            type="search"
            placeholder="Search by client, asset class, session ID, or state..."
            className="pr-10"
            value={search}
            onChange={(e) => props.onSearchChange(e.target.value)}
          />
          {searching && (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => props.onSearchChange("")}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-lg leading-none text-text-muted hover:text-text-primary"
            >
              ×
            </button>
          )}
        </div>
        {searching && (
          <div className="mt-1.5 text-xs text-text-muted" data-testid="result-count">
            {`${visible.length} ${visible.length === 1 ? "result" : "results"}`}
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && <div className="mt-6 text-sm text-text-muted">Loading sessions…</div>}

      {/* ── Empty: nothing recorded at all ── */}
      {!loading && !error && sessions.length === 0 && (
        <div className="card mt-6 px-6 py-12 text-center">
          <div className="text-sm font-semibold text-text-primary">No workflows yet</div>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-text-muted">
            Every escrow you run is recorded here with its audit trail. Start one to see it appear.
          </p>
          <button className="btn btn-primary mt-5" onClick={props.onNewTransaction}>
            New Transaction
          </button>
        </div>
      )}

      {/* ── Empty: the search excluded everything ── */}
      {!loading && !error && sessions.length > 0 && visible.length === 0 && (
        <div className="card mt-6 px-6 py-10 text-center">
          <div className="text-sm font-semibold text-text-primary">No matching workflows</div>
          <p className="mt-1.5 text-sm text-text-muted">
            Nothing in the last {sessions.length} sessions matches “{search.trim()}”.
          </p>
          <button className="btn btn-secondary mt-5" onClick={() => props.onSearchChange("")}>
            Clear search
          </button>
        </div>
      )}

      {/* ── Table ── */}
      {!loading && !error && visible.length > 0 && (
        <div className="card mt-6 overflow-x-auto">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead>
              <tr className="border-b border-app-border bg-app-input text-xs uppercase tracking-wide text-text-muted">
                <th className="px-4 py-3 font-medium">Asset class</th>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">State</th>
                <th className="px-4 py-3 font-medium">Execution path</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr
                  key={s.sessionId}
                  className="border-b border-app-border last:border-0 hover:bg-white/5"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-text-primary">
                    {assetLabel(s.assetClass)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-text-primary">{s.clientId}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-text-muted">
                      {shortId(s.sessionId)}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                    {dateLabel(s.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge ${stateTone(s.currentState)}`}>{s.currentState}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                    {pathLabel(s.executionPath)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-text-primary">
                    {amountLabel(s.totalHeldCents)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => props.onViewAudit(s.sessionId)}
                    >
                      View Audit Trail
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {auditSessionId && (
        <AuditTrailModal
          sessionId={auditSessionId}
          entries={props.auditEntries}
          loading={props.auditLoading}
          error={props.auditError}
          onClose={props.onCloseAudit}
        />
      )}
    </div>
  );
}

// ── Store container ──────────────────────────────────────────────────────────

export function RecentWorkflows() {
  const { openRecent, reset } = useSession();

  const [sessions, setSessions] = useState<backend.RecentSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [auditSessionId, setAuditSessionId] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<backend.AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const rows = await backend.getRecentSessions(RECENT_LIMIT);
        if (live) setSessions(rows);
      } catch (e) {
        if (live) setError(`Could not load sessions: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const onViewAudit = async (sessionId: string) => {
    setAuditSessionId(sessionId);
    setAuditEntries([]);
    setAuditError(null);
    setAuditLoading(true);
    try {
      setAuditEntries(await backend.getAuditTrail(sessionId));
    } catch (e) {
      setAuditError(`Could not load the audit trail: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAuditLoading(false);
    }
  };

  return (
    <RecentWorkflowsView
      sessions={sessions}
      loading={loading}
      error={error}
      search={search}
      onSearchChange={setSearch}
      auditSessionId={auditSessionId}
      auditEntries={auditEntries}
      auditLoading={auditLoading}
      auditError={auditError}
      onViewAudit={(id) => void onViewAudit(id)}
      onCloseAudit={() => setAuditSessionId(null)}
      // `reset` returns to Document Load with a clean session — the same thing
      // File → New Transaction does, which is what the empty state promises.
      onNewTransaction={() => reset()}
      // `openRecent` toggles, so on this screen it closes back to `prevScreen`.
      onClose={() => openRecent()}
    />
  );
}
