// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Clio Manage intake — matter search, selection and summary.
 *
 * Stands in for the file drop zone when the officer chooses "Pull from Clio".
 * Three states in sequence: search, then a fetched summary, then Continue. The
 * summary matters — a matter pulled silently into the workflow gives the
 * officer nothing to check before an escrow is built on it, so the numbers that
 * will drive the parse are shown before they commit to them.
 *
 * The fetched payload is held in the session store for this transaction only.
 * Nothing here writes it anywhere: Clio's ToS §10(e) scopes matter data to the
 * session, and the backend command that produces it takes no database handle.
 */

import { useEffect, useRef, useState } from "react";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import {
  escrowAmountCents,
  paidTotalCents,
  type ClioMatterPayload,
  type ClioMatterSummary,
} from "../lib/clio";

/** Keystrokes settle for this long before a search leaves the machine. */
const SEARCH_DEBOUNCE_MS = 400;

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path
        fillRule="evenodd"
        d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.45 4.39l3.08 3.08a1 1 0 01-1.42 1.42l-3.08-3.08A7 7 0 012 9z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function ClioIntakePanel() {
  const clioMatter = useSession((s) => s.clioMatter);
  const setClioMatter = useSession((s) => s.setClioMatter);
  const openConfig = useSession((s) => s.openConfig);

  const [connected, setConnected] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClioMatterSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<number | null>(null);

  // Connection is checked once on mount rather than on every keystroke: the
  // answer only changes when the officer visits Configuration, and this panel
  // unmounts when they do.
  useEffect(() => {
    let cancelled = false;
    void backend.clioCheckConnection().then((s) => {
      if (!cancelled) setConnected(s.connected);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced search. The timer is cleared on every keystroke *and* on unmount,
  // so a half-typed matter name never reaches Clio and a pending search never
  // resolves into an unmounted component.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const term = query.trim();
    if (term.length < 2 || connected !== true) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    timerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const found = await backend.clioSearchMatters(term);
          if (!cancelled) setResults(found);
        } catch (e) {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : String(e));
            setResults([]);
          }
        }
        if (!cancelled) setSearching(false);
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, connected]);

  const select = async (matterId: number) => {
    setFetching(true);
    setError(null);
    setLastAttempt(matterId);
    try {
      setClioMatter(await backend.clioFetchMatter(matterId));
      setResults([]);
      setQuery("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setClioMatter(null);
    }
    setFetching(false);
  };

  // ── Not connected ─────────────────────────────────────────────────────────

  if (connected === false) {
    return (
      <div
        className="rounded-xl border border-app-border bg-app-input p-6 text-center"
        role="status"
      >
        <p className="text-sm text-text-primary">
          Connect your Clio account in Settings → Configuration to use this feature.
        </p>
        <button className="btn btn-secondary mt-3" onClick={() => openConfig()}>
          Open Configuration
        </button>
      </div>
    );
  }

  if (connected === null) {
    return (
      <div className="rounded-xl border border-app-border bg-app-input p-6 text-center text-sm text-text-muted">
        Checking your Clio connection…
      </div>
    );
  }

  // ── A matter is selected ──────────────────────────────────────────────────

  if (clioMatter) {
    return <ClioMatterSummaryCard payload={clioMatter} onClear={() => setClioMatter(null)} />;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  return (
    <div className="rounded-xl border border-app-border bg-app-input p-4">
      <label className="label" htmlFor="clio-matter-search">
        Search open matters
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
          <SearchIcon />
        </span>
        <input
          id="clio-matter-search"
          className="input pl-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="matter number, client name or description"
          autoComplete="off"
          disabled={fetching}
        />
      </div>

      {fetching && (
        <div className="mt-3 text-sm text-text-muted" role="status">
          Fetching matter from Clio…
        </div>
      )}

      {!fetching && searching && (
        <div className="mt-3 text-sm text-text-muted" role="status">
          Searching…
        </div>
      )}

      {!fetching && !searching && query.trim().length >= 2 && results.length === 0 && !error && (
        <div className="mt-3 text-sm text-text-muted">No open matters match that search.</div>
      )}

      {results.length > 0 && (
        <ul className="mt-3 divide-y divide-app-border overflow-hidden rounded-lg border border-app-border">
          {results.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="w-full cursor-pointer px-3 py-2.5 text-left transition-colors hover:bg-app-card"
                onClick={() => void select(m.id)}
                disabled={fetching}
              >
                <div className="text-sm font-medium text-text-primary">{m.displayNumber}</div>
                <div className="truncate text-xs text-text-muted">{m.description}</div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="mt-3 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-400" role="alert">
          {error}
          {lastAttempt !== null && (
            <button
              type="button"
              className="ml-2 underline underline-offset-2"
              onClick={() => void select(lastAttempt)}
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What the officer checks before an escrow is built on this matter.
 *
 * The escrow amount is stated first and labelled with where it came from. Clio
 * distinguishes "no trust accounting on this matter" from "a zero trust
 * balance", and those mean very different things for a retainer release — so
 * the card says which one it is rather than showing $0.00 either way.
 */
function ClioMatterSummaryCard({
  payload,
  onClear,
}: {
  payload: ClioMatterPayload;
  onClear: () => void;
}) {
  const fromTrust = payload.trustBalanceCents !== null;
  return (
    <div className="rounded-xl border border-app-border bg-app-input p-4" aria-label="Clio matter summary">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">{payload.displayNumber}</div>
          <div className="truncate text-xs text-text-muted">{payload.description}</div>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm shrink-0"
          onClick={onClear}
        >
          Change
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-text-muted">Client</dt>
        <dd className="text-right text-text-primary">{payload.clientName}</dd>

        <dt className="text-text-muted">{fromTrust ? "Trust balance" : "Billed total"}</dt>
        <dd className="text-right font-medium text-text-primary">
          {money(escrowAmountCents(payload))}
        </dd>

        <dt className="text-text-muted">Earned fees</dt>
        <dd className="text-right text-text-primary">{money(paidTotalCents(payload))}</dd>

        <dt className="text-text-muted">Bills</dt>
        <dd className="text-right text-text-primary">{payload.bills.length}</dd>

        <dt className="text-text-muted">Parties</dt>
        <dd className="text-right text-text-primary">{payload.parties.length}</dd>
      </dl>

      {!fromTrust && (
        <p className="mt-3 text-xs text-amber-600">
          This matter has no trust balance in Clio. The billed total is used instead — confirm it is
          the amount actually held.
        </p>
      )}

      <p className="mt-3 border-t border-app-border pt-3 text-[11px] text-text-muted">
        Held for this transaction only. Clio matter data is never written to disk.
      </p>
    </div>
  );
}
