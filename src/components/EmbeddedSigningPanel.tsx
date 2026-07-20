/**
 * Embedded signing panel — the internal party's signing surface (spec §22).
 *
 * The email flow hands a document to DocuSign and waits: the signer leaves the
 * app, signs on DocuSign's site, and a 30-second poll eventually notices. That
 * is right for a client or a counterparty, and wrong for the people who work
 * here. An escrow officer signing a document they are already looking at should
 * not be emailed a link to it.
 *
 * So an embedded signer never receives an email. The ceremony opens in a
 * WebView owned by this application, DocuSign redirects it to the loopback
 * listener on completion, and `esign:embedded_complete` arrives in the main
 * window — no polling, no round trip through a mail client.
 *
 * What this component does *not* do is decide anything. It reports how the
 * ceremony ended; the completion pipeline in the session store re-derives the
 * outcome from DocuSign itself (certificate → ArtifactGuard hash →
 * AnchorReceipt registration → AnchorMatcher) exactly as it does for an email
 * signature. The two paths differ in how the signature is *collected*, never in
 * how it is *proven*.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/backend";
import { resolveESignProvider, type EmbeddedSigningResult } from "../lib/esign";

interface Props {
  envelopeId: string;
  signerEmail: string;
  signerName: string;
  clientUserId: string;
  onComplete: (event: string) => void;
  onCancel: () => void;
}

/** Tauri's `UnlistenFn`, restated so the module carries no Tauri type import. */
type Unlisten = () => void;

/** The one webview label the panel ever creates — reused across signers. */
const WEBVIEW_LABEL = "esign-panel";

const WEBVIEW_OPTIONS = {
  title: "Sign Document — LexEscrow",
  width: 900,
  height: 700,
  center: true,
  resizable: true,
} as const;

type Phase = "loading" | "waiting" | "error";

/**
 * Did this outcome collect a signature?
 *
 * Only `signing_complete` does. Every other terminal event — declined, timed
 * out, TTL expired, viewed-but-not-signed — ends the ceremony with nothing
 * signed, and all of them route to `onCancel`. An unrecognized event does too:
 * a signing condition must never be fulfilled by a value we do not understand.
 */
export function isSigningComplete(event: string): boolean {
  return event === "signing_complete";
}

/**
 * Read an outcome out of a signing URL, if it carries one.
 *
 * Demo mode's "ceremony" is the return URL itself — see
 * `MockDocuSignProvider.getEmbeddedSigningUrl`. Outside Tauri there is no
 * loopback listener to redirect into, so the outcome is taken from the URL
 * rather than lost.
 */
export function outcomeFromUrl(url: string): EmbeddedSigningResult | null {
  try {
    const parsed = new URL(url, "http://localhost");
    const event = parsed.searchParams.get("event");
    const envelopeId = parsed.searchParams.get("envelopeId");
    return event && envelopeId ? { envelopeId, event } : null;
  } catch {
    return null;
  }
}

export function EmbeddedSigningPanel({
  envelopeId,
  signerEmail,
  signerName,
  clientUserId,
  onComplete,
  onCancel,
}: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);

  // Refs, not state: these are teardown handles the effect must reach without
  // re-running, and re-rendering on their arrival would tear down the ceremony
  // it just opened.
  const webviewRef = useRef<{ close: () => Promise<void> } | null>(null);
  const unlistenRef = useRef<Unlisten | null>(null);
  const settledRef = useRef(false);
  const startedRef = useRef(false);

  /** Close the signing window. Safe to call more than once. */
  const closeWebview = useCallback(() => {
    const webview = webviewRef.current;
    webviewRef.current = null;
    // The window may already be gone — the signer closed it, or DocuSign's
    // redirect ended it. Nothing to recover from either way.
    void webview?.close().catch(() => {});
  }, []);

  /**
   * Resolve the ceremony exactly once.
   *
   * DocuSign can deliver the same outcome twice (the redirect fires and the
   * signer then closes the window), and a second `onComplete` would run the
   * certificate pipeline again against an envelope already registered.
   */
  const settle = useCallback(
    (event: string) => {
      if (settledRef.current) return;
      settledRef.current = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
      closeWebview();
      if (isSigningComplete(event)) onComplete(event);
      else onCancel();
    },
    [closeWebview, onComplete, onCancel],
  );

  useEffect(() => {
    // Guards against an effect re-entry opening a second ceremony.
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    const open = async () => {
      try {
        const provider = await resolveESignProvider();
        if (!provider.getEmbeddedSigningUrl) {
          throw new Error(
            `${provider.providerName()} does not support in-app signing — send this document by email instead.`,
          );
        }

        const signingUrl = await provider.getEmbeddedSigningUrl(
          envelopeId,
          signerEmail,
          signerName,
          clientUserId,
        );
        if (cancelled) return;

        if (isTauri()) {
          // Subscribed *before* the window opens: a ceremony that completes
          // instantly (demo mode) would otherwise redirect before anyone is
          // listening, and the panel would wait forever on an event already
          // fired.
          const { listen } = await import("@tauri-apps/api/event");
          const unlisten = await listen<EmbeddedSigningResult>(
            "esign:embedded_complete",
            ({ payload }) => {
              // Envelope-scoped: another envelope's callback must not resolve
              // this signer's panel.
              if (payload?.envelopeId === envelopeId) settle(payload.event);
            },
          );
          if (cancelled) {
            unlisten();
            return;
          }
          unlistenRef.current = unlisten;

          const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
          webviewRef.current = new WebviewWindow(WEBVIEW_LABEL, {
            url: signingUrl,
            ...WEBVIEW_OPTIONS,
          });
        } else {
          // No desktop shell: open a tab and take the outcome from the URL if
          // it carries one (demo mode), since no loopback listener is running.
          window.open(signingUrl, "_blank", "noopener,noreferrer");
          const outcome = outcomeFromUrl(signingUrl);
          if (outcome) {
            setPhase("waiting");
            settle(outcome.event);
            return;
          }
        }

        if (!cancelled) setPhase("waiting");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    };

    void open();

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
      closeWebview();
    };
    // Identity is fixed for the lifetime of a mounted panel — a different
    // signer means a different panel, not a re-run of this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envelopeId, signerEmail, signerName, clientUserId]);

  /** Officer abandons the ceremony from the main window. */
  const cancel = () => settle("cancel");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Embedded signing"
    >
      <div className="card w-full max-w-md p-6">
        {phase === "loading" && (
          <>
            <div className="text-sm font-semibold text-text-primary">Preparing signing session…</div>
            <p className="mt-1.5 text-sm text-text-muted">
              Requesting a secure signing link from DocuSign for {signerName}.
            </p>
          </>
        )}

        {phase === "waiting" && (
          <>
            <div className="text-sm font-semibold text-text-primary">
              ✍️ Signing in progress — complete the signature in the DocuSign window
            </div>
            <p className="mt-1.5 text-sm text-text-muted">
              A signing window has opened for {signerName} ({signerEmail}). This panel closes on its
              own once the signature is complete.
            </p>
            <div className="mt-3 font-mono text-[11px] text-text-muted">{envelopeId}</div>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="text-sm font-semibold text-red-700">In-app signing unavailable</div>
            <p className="mt-1.5 text-sm text-text-muted">{error}</p>
          </>
        )}

        <div className="mt-5 flex justify-end">
          <button className="btn btn-secondary" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
