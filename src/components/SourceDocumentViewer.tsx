/**
 * <SourceDocumentViewer /> — spec §29, "View Source Document".
 *
 * Shows the artifact's normalized text so the officer can check a disputed
 * value against the document itself before attesting to a correction. Dollar
 * amounts are highlighted in amber: the officer is nearly always hunting for a
 * money figure, and scanning raw contract text for one is the slow step.
 *
 * The escalation dialog stays mounted behind this overlay — dismissing the
 * viewer returns the officer to their in-progress corrections, not to a reset
 * form.
 */

import { type ReactNode } from "react";

export interface SourceDocumentViewerProps {
  text: string;
  onClose: () => void;
}

/** Any `$1,234` or `$1,234.56` run — the figures an escrow dispute turns on. */
const MONEY_PATTERN = /\$[\d,]+(\.\d{2})?/g;

/**
 * Split text into plain and highlighted segments. Returns nodes rather than
 * HTML so the document text is never interpolated as markup — a loaded artifact
 * is untrusted input.
 */
export function highlightAmounts(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(MONEY_PATTERN.source, "g");

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(
      <mark key={`${match.index}`} className="rounded bg-amber-50 px-1 font-semibold text-amber-700">
        {match[0]}
      </mark>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function SourceDocumentViewer({ text, onClose }: SourceDocumentViewerProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Source Document"
      data-testid="source-document-viewer"
    >
      <div className="card flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-app-border bg-app-input px-5 py-3">
          <div>
            <div className="text-sm font-bold text-text-primary">Source Document</div>
            <div className="text-xs text-text-muted">
              Normalized text as hashed by ArtifactGuard — dollar amounts highlighted.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close source document"
            className="rounded-lg px-2 py-1 text-xl leading-none text-text-muted transition-colors
              hover:bg-white/5 hover:text-text-primary"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4" data-selectable>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-text-muted">
            {highlightAmounts(text)}
          </pre>
        </div>
      </div>
    </div>
  );
}
