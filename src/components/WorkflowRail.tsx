const STAGES = ["Load", "Process", "Review", "Conditions", "Escrow", "Execute"];

function Check() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Top progress rail for the six main workflow stages. */
export function WorkflowRail({ current, escalated }: { current: number; escalated?: boolean }) {
  return (
    <div className="flex items-center">
      {STAGES.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const reviewFlag = escalated && i === 2;
        const circle = done
          ? "bg-emerald-500 text-white"
          : active
            ? reviewFlag
              ? "bg-amber-500 text-app-bg ring-2 ring-amber-500/25"
              : "bg-brand text-white ring-2 ring-brand/30"
            : "border border-app-border bg-app-input text-text-muted";
        const text = active
          ? reviewFlag
            ? "text-amber-600"
            : "text-brand-fg"
          : "text-text-muted";
        return (
          <div key={label} className="flex items-center">
            <div className="flex items-center gap-1.5">
              <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${circle}`}>
                {done ? <Check /> : i + 1}
              </div>
              <span className={`hidden text-[10px] font-medium sm:block ${text}`}>{label}</span>
            </div>
            {i < STAGES.length - 1 && (
              <div className={`mx-2 h-px w-5 shrink-0 ${i < current ? "bg-emerald-500" : "bg-app-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}