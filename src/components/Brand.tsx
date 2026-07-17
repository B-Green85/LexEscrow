import emblem from "../assets/lexescrow-emblem.png";

export function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <img
        src={emblem}
        alt=""
        width={36}
        height={36}
        className="h-9 w-9 rounded-lg ring-1 ring-[#2D3A4A]"
        draggable={false}
      />
      <div className="leading-tight">
        <div className="text-sm font-bold tracking-tight">
          <span className="text-[#B45309]">Lex</span>
          <span className="text-[#2563EB]">Escrow</span>
        </div>
        <div className="text-[11px] text-slate-400">AI-Governed Retainer Release</div>
      </div>
    </div>
  );
}
