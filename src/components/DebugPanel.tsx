/**
 * LexTrace — the read-only CRE debug console panel.
 *
 * A real terminal emulator rather than a scrolling `<pre>`, and for one
 * concrete reason: CRE CLI output is ANSI-coloured, and Chainlink's blue is how
 * an operator picks a workflow line out of a wall of text. Reproducing even a
 * subset of ANSI by hand would be a parser nobody asked for; xterm.js already
 * is one.
 *
 * Read only, all the way down. `disableStdin` closes the terminal to input, the
 * Rust side gives its child process no stdin at all, and the command it runs is
 * a compile-time constant. There is no path from this component to a shell —
 * the panel observes, which is the same posture the rest of LexEscrow takes
 * toward the chain.
 *
 * The panel shows the *latest* poll result rather than a transcript: each
 * response clears the terminal and rewrites it, so what is on screen is always
 * the current state of the workflow rather than a scrolling history of how it
 * got there. The history that matters is `debug_audit_trail`, which records
 * every line either way.
 *
 * The terminal instance is created once per mount and *not* rebuilt when the
 * panel changes position — an operator who moves the panel from the bottom to
 * the side to read a long line should still have the line, rather than an empty
 * screen until the next poll.
 */

import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import "@xterm/xterm/css/xterm.css";

/** How often the panel asks the backend for more output, in milliseconds. */
const POLL_MS = 3_000;

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export type DebugPanelVariant = "bottom" | "side";

/**
 * Terminal colours, taken from the app's own tokens so the panel reads as part
 * of LexEscrow rather than as a terminal someone pasted into it. The sixteen
 * ANSI slots are left at xterm's defaults on purpose — remapping them is how a
 * themed terminal quietly turns Chainlink's blue into some other colour.
 */
const THEME = {
  background: "#070b14", // --color-app-bg
  foreground: "#f3f4f6", // --color-text-primary
  cursor: "#070b14", // invisible: there is nothing to type
  cursorAccent: "#070b14",
  selectionBackground: "rgba(30, 96, 145, 0.45)", // --color-brand-glow
};

export function DebugPanel({ variant }: { variant: DebugPanelVariant }) {
  const closeDebugPanel = useSession((s) => s.closeDebugPanel);
  const operatorId = useSession((s) => s.debugOperatorId);
  const sessionId = useSession((s) => s.sessionId);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<{ fit: () => void } | null>(null);

  /**
   * The result produced before the terminal exists.
   *
   * xterm is loaded asynchronously and the first poll fires immediately, so the
   * very first CRE response routinely resolves while the import is still in
   * flight. Writing it into a null terminal would drop it silently — and the
   * first response is the one that says whether the CLI was even found.
   */
  const pendingRef = useRef<string[]>([]);

  /**
   * Replace the terminal's contents with one poll's output.
   *
   * The panel shows the latest result rather than a transcript, so each render
   * clears first. A buffered result is *replaced* rather than queued for the
   * same reason: if two polls somehow resolve before the import lands, flushing
   * both would paint a screen that never existed.
   */
  const render = (lines: string[]) => {
    const term = termRef.current;
    if (!term) {
      pendingRef.current = lines;
      return;
    }
    term.clear();
    for (const line of lines) term.writeln(line);
  };

  // `sessionId` is read through a ref rather than closed over: it changes as
  // the officer works, and re-running the poll effect on every change would
  // restart the interval and re-emit the banner mid-run.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // ── Terminal lifecycle ────────────────────────────────────────────────────
  //
  // xterm is imported dynamically because it reaches for `document` as soon as
  // a Terminal is constructed. The screen tests render through
  // `react-dom/server`, where effects never run and there is no DOM to reach
  // for — a static import would pull the whole library into that environment
  // for no reason.
  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    let observer: ResizeObserver | null = null;

    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      // The panel can be closed while those two imports are in flight.
      if (disposed || !hostRef.current) return;

      term = new XTerm({
        // The one option that makes this read-only rather than merely
        // unwired: with stdin disabled the terminal accepts no keystrokes at
        // all, so there is nothing to accidentally forward anywhere.
        disableStdin: true,
        cursorBlink: false,
        convertEol: true,
        fontSize: 12,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        // Only ever holds one poll's output, since each result clears the
        // last — but a single `cre execution list` can run past the viewport,
        // and that is what the operator scrolls.
        scrollback: 5_000,
        theme: THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      termRef.current = term;
      fitRef.current = fit;

      // Whatever the poll produced while the import was in flight. No clear
      // first — the terminal is new, so there is nothing to replace.
      for (const line of pendingRef.current) term.writeln(line);
      pendingRef.current = [];

      // The panel is a fixed size in both positions, but the *window* is not,
      // and a terminal that does not refit reflows its output at the old
      // column count.
      observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          // Fitting a detached or zero-sized element throws; there is nothing
          // to lay out in that case and nothing to report.
        }
      });
      observer.observe(hostRef.current);
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Repositioning changes the element's size without resizing the window, so
  // the observer above may not fire — refit explicitly.
  useEffect(() => {
    try {
      fitRef.current?.fit();
    } catch {
      /* see above */
    }
  }, [variant]);

  // ── Polling ───────────────────────────────────────────────────────────────
  //
  // Mounted-while-open is the whole lifecycle: this effect starts when the
  // panel appears and its cleanup stops the interval when the panel closes or
  // the app tears down, so there is no path where polling outlives the panel.
  useEffect(() => {
    let cancelled = false;
    // Guards a slow backend call against the next tick arriving first. The
    // Rust side refuses overlapping runs too; this stops them being requested.
    let inFlight = false;
    let lastError: string | null = null;

    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const output = await backend.runCreDebug(sessionIdRef.current);
        if (cancelled) return;
        // Empty means a run was already in flight backend-side. Nothing
        // happened, so nothing is redrawn — clearing here would blank the last
        // real result and leave the panel empty until the next poll lands.
        if (output.length > 0) {
          render(output.split("\n"));
          lastError = null;
        }
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        // Repainting an unchanged permanent fault — no CRE binary, no
        // credentials — would clear and rewrite the same red line every three
        // seconds, which reads as a flicker rather than as a steady state.
        if (message !== lastError) {
          render([`${RED}${message}${RESET}`]);
          lastError = message;
        }
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const shell =
    variant === "bottom"
      ? "h-[280px] w-full shrink-0 border-t"
      : "h-full w-[420px] shrink-0 border-l";

  return (
    <section
      className={`flex flex-col overflow-hidden border-app-border bg-app-bg ${shell}`}
      aria-label="LexTrace debug console"
    >
      <header className="flex h-8 shrink-0 items-center gap-3 border-b border-app-border bg-app-card px-3">
        <span className="text-xs font-semibold tracking-tight text-text-primary">LexTrace</span>

        {/* Everything from here is right-aligned. The live indicator sits with
            the operator name rather than beside the title because together they
            answer one question — who is watching, and is it still running. */}
        <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-emerald-600">
          <span className="lextrace-live-dot h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
          LIVE
        </span>

        <span className="min-w-0 truncate text-[11px] text-text-muted" data-selectable>
          Operator: {operatorId || "—"}
        </span>

        <button
          type="button"
          onClick={closeDebugPanel}
          aria-label="Close debug console"
          className="cursor-pointer rounded p-0.5 text-text-muted transition-colors
            hover:bg-app-input hover:text-text-primary focus-visible:outline-none
            focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </header>

      {/* `data-selectable` opts back into text selection, which `styles.css`
          disables globally — copying a workflow ID out of the panel is most of
          what an operator does with it. */}
      <div ref={hostRef} data-selectable className="min-h-0 flex-1 px-2 py-1" />
    </section>
  );
}
