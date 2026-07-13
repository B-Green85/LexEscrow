import { useSession } from "./store/session";
import { Brand } from "./components/Brand";
import { WorkflowRail } from "./components/WorkflowRail";
import { DocumentLoad } from "./screens/DocumentLoad";
import { Processing } from "./screens/Processing";
import { ParsedOutputReview } from "./screens/ParsedOutputReview";
import { ExecutionConfirmation } from "./screens/ExecutionConfirmation";
import { LexGuardEscalation } from "./screens/LexGuardEscalation";

const STAGE_INDEX: Record<string, number> = {
  load: 0,
  processing: 1,
  review: 2,
  escalation: 2,
  execution: 3,
};

function App() {
  const { screen, operator } = useSession();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
          <Brand />
          <WorkflowRail current={STAGE_INDEX[screen]} escalated={screen === "escalation"} />
          <div className="hidden text-right sm:block">
            <div className="text-[11px] text-slate-400">Operator</div>
            <div className="text-xs font-medium text-slate-600">{operator}</div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
        {screen === "load" && <DocumentLoad />}
        {screen === "processing" && <Processing />}
        {screen === "review" && <ParsedOutputReview />}
        {screen === "escalation" && <LexGuardEscalation />}
        {screen === "execution" && <ExecutionConfirmation />}
      </main>

      <footer className="border-t border-slate-200 py-3 text-center text-xs text-slate-400">
        AI parses. LexGuard validates. Humans decide. CRE executes.
      </footer>
    </div>
  );
}

export default App;
