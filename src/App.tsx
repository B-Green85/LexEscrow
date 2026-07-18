import { useState } from "react";
import { useSession } from "./store/session";
import { Brand } from "./components/Brand";
import { Splash } from "./components/Splash";
import { WorkflowRail } from "./components/WorkflowRail";
import { DocumentLoad } from "./screens/DocumentLoad";
import { Processing } from "./screens/Processing";
import { ParsedOutputReview } from "./screens/ParsedOutputReview";
import { ConditionDefinition } from "./screens/ConditionDefinition";
import { ExecutionConfirmation } from "./screens/ExecutionConfirmation";
import { LexGuardEscalation } from "./screens/LexGuardEscalation";
import { Configuration } from "./screens/Configuration";
import { BatchProcessing } from "./screens/BatchProcessing";

const STAGE_INDEX: Record<string, number> = {
  load: 0,
  processing: 1,
  review: 2,
  escalation: 2,
  conditions: 3,
  execution: 4,
};

function BatchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
      <path d="M3 4a1 1 0 011-1h5a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM11 4a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1V4zM11 10a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1v-6zM3 12a1 1 0 011-1h5a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1v-4z" />
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
  const { screen, operator, openConfig, openBatch } = useSession();
  const [showSplash, setShowSplash] = useState(true);
  const chromeless = screen === "config" || screen === "batch";
  const chromeLabel = screen === "config" ? "Configuration" : "Batch processing";

  return (
    <div className="flex min-h-screen flex-col">
      {showSplash && <Splash onFinish={() => setShowSplash(false)} />}
      <header className="sticky top-0 z-10 border-b border-[#1A2435] bg-[#0A0F1A]/85 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
          <Brand />
          {chromeless ? (
            <div className="text-sm font-semibold text-slate-500">{chromeLabel}</div>
          ) : (
            <WorkflowRail current={STAGE_INDEX[screen]} escalated={screen === "escalation"} />
          )}
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
        {screen === "execution" && <ExecutionConfirmation />}
        {screen === "config" && <Configuration />}
        {screen === "batch" && <BatchProcessing />}
      </main>

      <footer className="border-t border-slate-200 py-3 text-center text-xs text-slate-400">
        AI parses. LexGuard validates. Humans decide. CRE executes.
      </footer>
    </div>
  );
}

export default App;
