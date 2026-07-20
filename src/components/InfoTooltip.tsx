/**
 * Inline field explainer — the ⓘ next to a label.
 *
 * The blockchain step asks a solo practitioner for an RPC URL, a forwarder
 * address and a private key. Those are not hard to *type*; they are hard to
 * *believe*, because nothing on the screen says which of them are public
 * identifiers safe to paste into a support ticket and which one moves money.
 * A hint line under every field would answer that, and would also turn the step
 * into a wall of grey text nobody reads. So the explanation is here instead:
 * out of the way until asked for, and long enough to actually answer the
 * question when it is.
 *
 * The popover is deliberately click-toggled rather than hover-revealed. Hover
 * tooltips are unreachable by keyboard and touch, and this content is the sort
 * an operator wants to keep on screen while they read a value off MetaMask.
 */

import { useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/backend";

export interface InfoTooltipProps {
  title: string;
  explanation: string;
  /** Optional URL, opened in the operator's real browser rather than in-app. */
  learnMore?: string;
}

/**
 * Open a URL outside the app.
 *
 * Inside the desktop shell a bare `window.open` would either be swallowed or
 * open a webview with no chrome — an operator sent to alchemy.com to sign up
 * needs their own browser, with their password manager and their session. The
 * plugin import is dynamic because the module only resolves against a running
 * Tauri host; in a browser build (`npm run dev`, tests) the `isTauri` guard
 * takes the fallback and the import is never evaluated.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function InfoTooltip({ title, explanation, learnMore }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"top" | "bottom">("bottom");
  const rootRef = useRef<HTMLSpanElement>(null);

  const toggle = () => {
    if (!open) {
      // Cheap heuristic, chosen over a measuring library on purpose: the card
      // this sits in scrolls, and a popover that opens downward off the bottom
      // of the viewport is worse than one that occasionally opens upward with
      // room to spare.
      const rect = rootRef.current?.getBoundingClientRect();
      const midpoint = typeof window !== "undefined" ? window.innerHeight / 2 : 0;
      setPlacement(rect && rect.top > midpoint ? "top" : "bottom");
    }
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;

    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={`More information: ${title}`}
        aria-expanded={open}
        onClick={toggle}
        className="ml-1.5 inline-flex h-4 w-4 shrink-0 cursor-pointer items-center
          justify-center rounded-full border border-app-border bg-app-input text-[10px]
          font-bold text-text-muted transition-colors hover:border-brand-fg
          hover:text-brand-fg"
      >
        ⓘ
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={title}
          className={`absolute left-0 z-50 max-w-xs rounded-lg border border-app-border
            bg-app-card p-3 shadow-2xl shadow-black/50 ${
              placement === "top" ? "bottom-full mb-2" : "top-full mt-2"
            }`}
        >
          <p className="text-sm font-semibold text-text-primary">{title}</p>
          <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-text-muted">
            {explanation}
          </p>
          {learnMore && (
            <button
              type="button"
              onClick={() => void openExternal(learnMore)}
              className="mt-2 cursor-pointer text-xs text-brand-fg transition-colors hover:text-brand-fg/80 hover:underline"
            >
              Learn more →
            </button>
          )}
        </div>
      )}
    </span>
  );
}
