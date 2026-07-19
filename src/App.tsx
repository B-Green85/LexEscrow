import { useEffect, useState } from "react";
import { initMenuListeners, useSession, type Screen } from "./store/session";
import { Brand } from "./components/Brand";
import { Splash } from "./components/Splash";
import { WorkflowRail } from "./components/WorkflowRail";
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
  const { screen, operator, openConfig, openBatch, openAnchorReceiptConsole } = useSession();
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

  return (
    <div className="flex min-h-screen flex-col">
      {showSplash && <Splash onFinish={() => setShowSplash(false)} />}
      <header className="sticky top-0 z-10 border-b border-[#1A2435] bg-[#0A0F1A]/85 backdrop-blur">
        <div className="mx-auto grid max-w-6xl grid-cols-[auto_1fr_auto] items-center gap-4 px-6 py-3">
          <Brand />
          <div className="flex min-w-0 justify-center">
            {chromeless ? (
              <div className="text-sm font-semibold text-slate-500">{chromeLabel}</div>
            ) : (
              <WorkflowRail current={STAGE_INDEX[screen]} escalated={screen === "escalation"} />
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-[11px] text-slate-400">Operator</div>
              <div className="text-xs font-medium text-slate-600">{operator}</div>
            </div>
            <button
              onClick={() => openBatch()}
              aria-label="Batch processing"
              title="Batch processing"
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <BatchIcon />
            </button>
            <button
              onClick={() => openAnchorReceiptConsole()}
              aria-label="AnchorReceipt Console"
              title="AnchorReceipt Console"
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <AnchorReceiptIcon />
            </button>
            <button
              onClick={() => openConfig()}
              aria-label="Configuration"
              title="Configuration"
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <GearIcon />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
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
      </main>

      <footer className="border-t border-slate-200 py-3 text-center text-xs text-slate-400">
        AI parses. LexGuard validates. Humans decide. CRE executes.
      </footer>
    </div>
  );
}

export default App;
