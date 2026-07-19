const STAGES = ["Load", "Process", "Review", "Conditions", "Escrow", "Execute"];

function Check() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Top progress rail for the four main workflow stages. */
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
              ? "bg-amber-500 text-[#0A0F1A] ring-4 ring-amber-500/25"
              : "bg-brand-600 text-white ring-4 ring-brand-500/25"
            : "bg-slate-200 text-slate-400";
        const text = active
          ? reviewFlag
            ? "text-amber-600"
            : "text-[#60A5FA]"
          : done
            ? "text-slate-300"
            : "text-slate-400";
        return (
          <div key={label} className="flex items-center">
            <div className="flex items-center gap-2">
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${circle}`}
              >
                {done ? <Check /> : i + 1}
              </div>
              <span className={`text-xs font-medium ${text}`}>{label}</span>
            </div>
            {i < STAGES.length - 1 && (
              <div className={`mx-3 h-px w-8 ${i < current ? "bg-emerald-500" : "bg-slate-200"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
