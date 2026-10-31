// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

import { useEffect, useState } from "react";
import { initMenuListeners, useSession, type Screen } from "./store/session";
import emblem from "./assets/lexescrow-emblem.png";
import { Splash } from "./components/Splash";
import { Toaster } from "./components/Toast";
import { VaultUnlockGate } from "./components/VaultUnlockGate";
import { CredentialStoreSelector } from "./components/CredentialStoreSelector";
import { WorkflowRail } from "./components/WorkflowRail";
import { HeaderIconButton } from "./components/HeaderIconButton";
import { DebugPanel } from "./components/DebugPanel";
import { DebugPasswordPrompt } from "./components/DebugPasswordPrompt";
import { DocumentLoad } from "./screens/DocumentLoad";
import { Processing } from "./screens/Processing";
import { ParsedOutputReview } from "./screens/ParsedOutputReview";
import { ConditionDefinition } from "./screens/ConditionDefinition";
import { EscrowMonitor } from "./screens/EscrowMonitor";
import { ExecutionConfirmation } from "./screens/ExecutionConfirmation";
import { LexGuardEscalation } from "./screens/LexGuardEscalation";
import { Configuration } from "./screens/Configuration";
import { BatchProcessing } from "./screens/BatchProcessing";
import { AnchorReceiptConsole } from "./screens/AnchorReceiptConsole";
import { RecentWorkflows } from "./screens/RecentWorkflows";
import { SetupWizard } from "./screens/SetupWizard";

/**
 * Screens that replace the workflow rail with their own title — they sit
 * outside the six-stage workflow, so a progress rail would misreport where the
 * officer is. Membership and label are one lookup so the two cannot disagree.
 */
const CHROMELESS_LABELS: Partial<Record<Screen, string>> = {
  config: "Configuration",
  batch: "Batch processing",
  "anchor-receipt": "AnchorReceipt Console",
  recent: "Recent Workflows",
};

const STAGE_INDEX: Record<string, number> = {
  load: 0,
  processing: 1,
  review: 2,
  escalation: 2,
  conditions: 3,
  "escrow-monitor": 4,
  execution: 5,
};

/**
 * Screens whose content is a wide table or console rather than a form. They
 * get a roomier column than the workflow screens, which read better narrow.
 */
const WIDE_SCREENS: Partial<Record<Screen, true>> = {
  batch: true,
  "anchor-receipt": true,
  recent: true,
};

/** Clock-with-arrow — history, for Recent Workflows. */
function HistoryIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
      <path d="M10 5a1 1 0 011 1v3.6l2.5 1.44a1 1 0 11-1 1.73l-3-1.73A1 1 0 019 10.2V6a1 1 0 011-1z" />
      <path
        fillRule="evenodd"
        d="M2.05 9.1a8 8 0 112.35 6.2 1 1 0 011.4-1.42A6 6 0 104.02 8.6l1.03-.5a1 1 0 01.87 1.8l-3 1.46a1 1 0 01-1.4-.62L.62 7.5a1 1 0 011.93-.52l.3 1.12z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function BatchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
      <path d="M3 4a1 1 0 011-1h5a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM11 4a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1V4zM11 10a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1v-6zM3 12a1 1 0 011-1h5a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1v-4z" />
    </svg>
  );
}

/** Seal / receipt mark — a stamped ribbon rosette, for AnchorReceipt. */
function AnchorReceiptIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
      <path
        fillRule="evenodd"
        d="M10 1.5a5.75 5.75 0 013.03 10.63l1.6 5.06a.6.6 0 01-.84.71L10 16.1l-3.79 1.8a.6.6 0 01-.84-.71l1.6-5.06A5.75 5.75 0 0110 1.5zm0 2a3.75 3.75 0 100 7.5 3.75 3.75 0 000-7.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Terminal chevron and prompt line — the console mark, for LexTrace. */
function TerminalIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
      <path
        fillRule="evenodd"
        d="M3 3.5A1.5 1.5 0 014.5 2h11A1.5 1.5 0 0117 3.5v13a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 013 16.5v-13zm3.22 3.22a.75.75 0 011.06 0l2.5 2.5a.75.75 0 010 1.06l-2.5 2.5a.75.75 0 11-1.06-1.06L8.19 9.75 6.22 7.78a.75.75 0 010-1.06zM10.75 12a.75.75 0 000 1.5h3a.75.75 0 000-1.5h-3z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
      <path
        fillRule="evenodd"
        d="M8.34 1.8a1.5 1.5 0 013.32 0l.13.68a1.5 1.5 0 002.05 1.18l.65-.26a1.5 1.5 0 011.9 2.06l-.32.62a1.5 1.5 0 00.79 2.14l.66.24a1.5 1.5 0 010 2.84l-.66.24a1.5 1.5 0 00-.79 2.14l.32.62a1.5 1.5 0 01-1.9 2.06l-.65-.26a1.5 1.5 0 00-2.05 1.18l-.13.68a1.5 1.5 0 01-3.32 0l-.13-.68a1.5 1.5 0 00-2.05-1.18l-.65.26a1.5 1.5 0 01-1.9-2.06l.32-.62a1.5 1.5 0 00-.79-2.14l-.66-.24a1.5 1.5 0 010-2.84l.66-.24a1.5 1.5 0 00.79-2.14l-.32-.62a1.5 1.5 0 011.9-2.06l.65.26A1.5 1.5 0 008.21 2.48l.13-.68zM10 13a3 3 0 100-6 3 3 0 000 6z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function App() {
  const {
    screen,
    operator,
    openConfig,
    openBatch,
    openAnchorReceiptConsole,
    openRecent,
    showWizard,
    checkWizard,
    storeBackend,
    storeBackendChecked,
    checkStoreBackend,
    setStoreBackendLocal,
    credentialPromptOpen,
    resolveCredentialPrompt,
    debugPanel,
    debugPromptOpen,
    cycleDebugPanel,
  } = useSession();
  const [showSplash, setShowSplash] = useState(true);
  const chromeLabel = CHROMELESS_LABELS[screen];
  const chromeless = chromeLabel !== undefined;

  // Native File-menu items (New Transaction, Recent Workflows) drive the store
  // through Tauri events. Bound once here and released on unmount — StrictMode
  // mounts effects twice in development, and a duplicate listener would toggle
  // Recent Workflows open and shut in the same click.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void initMenuListeners().then((off) => {
      if (cancelled) off();
      else dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // Cmd+Shift+D (macOS) / Ctrl+Shift+D elsewhere — the same cycle the header
  // icon runs, so the two can never disagree about which position is next.
  //
  // Both modifiers are accepted on every platform rather than branching on the
  // OS: Ctrl+Shift+D is not bound to anything here, and an operator on a
  // remote-desktop or non-Apple keyboard should not have to find a Cmd key.
  // `e.code` rather than `e.key` because Shift changes `key` to "D" and some
  // layouts change it further; the physical key is what the shortcut names.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.code !== "KeyD") return;
      e.preventDefault();
      void cycleDebugPanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleDebugPanel]);

  // Which credential backend is active. Read before first-run detection,
  // because the answer changes what "first run" means: under the OS keychain an
  // install with no vault file may still be fully configured.
  useEffect(() => {
    void checkStoreBackend();
  }, [checkStoreBackend]);

  // First-run detection. Runs once the backend is known, so it asks the right
  // store. Settles well before the splash finishes, and the wizard never
  // flashes in behind it.
  useEffect(() => {
    if (!storeBackendChecked || storeBackend === null) return;
    void checkWizard();
  }, [checkWizard, storeBackendChecked, storeBackend]);

  // No backend chosen yet — first launch. This *replaces* the app rather than
  // covering it: an overlay would leave every screen mounted underneath, firing
  // effects and holding its place in the tab order, which is a gate in
  // appearance only. Nothing past this point renders, and nothing behind it
  // would work anyway — there is no store to read a credential from.
  //
  // Rendered only once the check has actually completed, so a slow IPC round
  // trip does not flash the selector at an install that chose a backend months
  // ago.
  if (storeBackendChecked && storeBackend === null) {
    return (
      <div className="flex min-h-screen flex-col">
        {showSplash && <Splash onFinish={() => setShowSplash(false)} />}
        <CredentialStoreSelector
          onSelected={(chosen) => {
            // Recorded locally first so the gate lifts immediately, then the
            // normal first-run check runs against the store just selected.
            setStoreBackendLocal(chosen);
            void checkWizard();
          }}
        />
        <Toaster />
      </div>
    );
  }

  // The debug panel bounds the layout while it is open, and only then. Closed,
  // every class below is exactly what it was before LexTrace existed — the page
  // grows past the viewport and the window scrolls, which is what all eleven
  // screens were laid out against. Open, the shell is pinned to the viewport and
  // the main column scrolls inside it, because a fixed-height panel docked to a
  // page that scrolls as a whole would slide off the bottom of it.
  const debugOpen = debugPanel !== 0;

  return (
    <div className={`flex flex-col ${debugOpen ? "h-screen" : "min-h-screen"}`}>
      {showSplash && <Splash onFinish={() => setShowSplash(false)} />}
      {/* Sequenced after the splash rather than stacked above it — both are
          full-window overlays at the same depth, and an onboarding flow that
          appears mid-fade reads as a rendering fault. */}
      {!showSplash && showWizard && <SetupWizard />}
      {/* `data-tauri-drag-region` makes the whole bar a window handle, which is
          what the native title bar used to be before `titleBarStyle: Overlay`
          removed it. Interactive children opt back out by being buttons. */}
      <header
        data-tauri-drag-region
        className="sticky top-0 z-10 select-none border-b border-app-border
          bg-app-bg/90 backdrop-blur-sm"
      >
        {/* The attribute has to repeat on the inner rows: Tauri tests the
            element actually under the cursor, so tagging only the <header>
            would leave the bar draggable by its 1px edge and nowhere else. */}
        <div data-tauri-drag-region className="flex h-12 items-center justify-between px-6">
          {/* The left inset clears the macOS traffic lights, which `Overlay`
              floats on top of the web content. */}
          <div data-tauri-drag-region className="flex shrink-0 items-center gap-2 pl-[72px]">
            <img src={emblem} alt="" width={24} height={24} className="h-6 w-6" draggable={false} />
            <span className="text-sm font-semibold tracking-tight text-text-primary">LexEscrow</span>
          </div>

          <div className="flex min-w-0 flex-1 justify-center">
            {chromeless ? (
              <div className="truncate text-sm font-semibold text-text-muted">{chromeLabel}</div>
            ) : (
              <WorkflowRail current={STAGE_INDEX[screen]} escalated={screen === "escalation"} />
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <span className="mr-3 hidden text-xs text-text-muted sm:block">{operator}</span>
            <HeaderIconButton
              icon={<HistoryIcon />}
              label="Recent Workflows"
              onClick={() => openRecent()}
              active={screen === "recent"}
            />
            <HeaderIconButton
              icon={<BatchIcon />}
              label="Batch Processing"
              onClick={() => openBatch()}
              active={screen === "batch"}
            />
            <HeaderIconButton
              icon={<AnchorReceiptIcon />}
              label="AnchorReceipt Console"
              onClick={() => openAnchorReceiptConsole()}
              active={screen === "anchor-receipt"}
            />
            <HeaderIconButton
              icon={<TerminalIcon />}
              label="LexTrace Debug Console"
              onClick={() => void cycleDebugPanel()}
              active={debugPanel !== 0}
            />
            <HeaderIconButton
              icon={<GearIcon />}
              label="Configuration"
              onClick={() => openConfig()}
              active={screen === "config"}
            />
          </div>
        </div>
      </header>

      {/* The content area. Both docked positions are the *same* flex container
          with a different axis — column puts the panel under the main column
          (full window width, above the status bar), row puts it beside it —
          which keeps the panel at one place in the tree. That is not a
          stylistic preference: rendering it in two places would unmount and
          remount the terminal on every reposition, and scrollback is the whole
          reason to have a console. A plain wrapper when nothing is open, so the
          closed case is the layout that shipped. */}
      <div
        className={`flex ${debugPanel === 1 ? "flex-col" : ""} ${
          debugOpen ? "min-h-0 flex-1" : "flex-1"
        }`}
      >
        <main className={`min-w-0 flex-1 bg-app-bg ${debugOpen ? "min-h-0 overflow-y-auto" : ""}`}>
          <div className={`mx-auto w-full px-6 py-8 ${WIDE_SCREENS[screen] ? "max-w-6xl" : "max-w-4xl"}`}>
            {screen === "load" && <DocumentLoad />}
            {screen === "processing" && <Processing />}
            {screen === "review" && <ParsedOutputReview />}
            {screen === "escalation" && <LexGuardEscalation />}
            {screen === "conditions" && <ConditionDefinition />}
            {screen === "escrow-monitor" && <EscrowMonitor />}
            {screen === "execution" && <ExecutionConfirmation />}
            {screen === "config" && <Configuration />}
            {screen === "batch" && <BatchProcessing />}
            {screen === "anchor-receipt" && <AnchorReceiptConsole />}
            {screen === "recent" && <RecentWorkflows />}
          </div>
        </main>

        {debugOpen && <DebugPanel variant={debugPanel === 1 ? "bottom" : "side"} />}
      </div>

      <footer className="shrink-0 border-t border-app-border py-3 text-center">
        <span className="text-[11px] text-text-muted">
          AI parses. LexGuard validates. Humans decide. CRE executes.
        </span>
      </footer>

      {/* The lazy unlock prompt. Unlike the first-launch selector this overlays
          the app instead of replacing it — the operator has work on screen
          behind it and is being asked about one action, not shut out. */}
      {credentialPromptOpen && <VaultUnlockGate onCancel={() => resolveCredentialPrompt(false)} />}

      {/* The debug gate. Can follow the vault prompt immediately — opening the
          console needs the vault readable *and* the debug password — and stays
          a separate dialog because they authorise different things. */}
      {debugPromptOpen && <DebugPasswordPrompt />}

      {/* Last child, outside every screen: a toast outlives the click that
          raised it and must not unmount when a screen swaps. */}
      <Toaster />
    </div>
  );
}

export default App;
