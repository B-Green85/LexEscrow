/**
 * anomaly-watcher — detects anomaly *suppression*: the condition where AI
 * flagged anomalies during parsing but the execution payload would proceed as
 * though they did not exist. If anomalies were raised and then either explicitly
 * suppressed or routed to direct settlement (instead of arbitration), that is a
 * suppression and must escalate.
 */

import { ExecutionPath } from "./types";

export function detectAnomalySuppression(
  anomaliesFlagged: string[],
  anomaliesSuppressed: boolean,
  recommendedPath: ExecutionPath,
): boolean {
  if (anomaliesFlagged.length === 0) return false; // nothing was flagged
  if (anomaliesSuppressed) return true; // flagged and explicitly suppressed
  // Flagged but routed to direct settlement rather than arbitration — the
  // anomalies were effectively ignored.
  if (recommendedPath === ExecutionPath.DirectSettlement) return true;
  return false;
}
