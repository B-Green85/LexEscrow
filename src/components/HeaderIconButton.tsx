import type { ReactNode } from "react";

export interface HeaderIconButtonProps {
  icon: ReactNode;
  /** Shown as the hover tooltip, and as the accessible name. */
  label: string;
  onClick: () => void;
  /** True when this button's screen is the one currently open. */
  active?: boolean;
}

/**
 * An icon button in the app header, with the label as a delayed hover tooltip.
 *
 * The header has four of these in a row, so the labels cannot be permanent —
 * they would crowd out the workflow rail. But an unlabelled icon strip is a
 * guessing game, so the label appears on hover instead of never.
 *
 * The 300ms delay is the point of the tooltip, not a detail of it. These
 * buttons sit at the end of the row nearest the window controls, which is
 * exactly the path the pointer travels on its way somewhere else. Without the
 * delay, crossing the strip fires four tooltips in sequence and the header
 * flickers. `delay-300` only applies to the transition *into* the hovered
 * state — moving away clears it instantly — so a deliberate hover is
 * rewarded and a passing one costs nothing.
 *
 * `title` is deliberately omitted: it would duplicate this tooltip with the
 * OS one a second later.
 */
export function HeaderIconButton({ icon, label, onClick, active = false }: HeaderIconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`group relative cursor-pointer rounded-lg p-2 transition-all duration-150
        hover:bg-app-card hover:text-text-primary active:scale-95
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
        ${active ? "bg-app-card text-gold-light" : "text-text-muted"}`}
    >
      {icon}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5
          -translate-x-1/2 whitespace-nowrap rounded-md border border-app-border
          bg-app-card px-2 py-1 text-[11px] font-medium text-text-primary
          opacity-0 shadow-lg shadow-black/40 transition-opacity duration-150
          delay-300 group-hover:opacity-100
          before:absolute before:-top-1 before:left-1/2 before:-translate-x-1/2
          before:border-4 before:border-transparent before:border-b-app-border
          before:content-['']"
      >
        {label}
      </span>
    </button>
  );
}
