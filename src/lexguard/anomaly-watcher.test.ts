import { describe, it, expect } from "vitest";
import { detectAnomalySuppression } from "./anomaly-watcher";
import { ExecutionPath } from "./types";

describe("detectAnomalySuppression", () => {
  it("returns false when nothing was flagged", () => {
    expect(detectAnomalySuppression([], false, ExecutionPath.DirectSettlement)).toBe(false);
  });

  it("escalates when anomalies were flagged and explicitly suppressed", () => {
    expect(detectAnomalySuppression(["ledger gap"], true, ExecutionPath.ArbitrationEscrow)).toBe(true);
  });

  it("escalates when anomalies were flagged but routed to direct settlement", () => {
    expect(detectAnomalySuppression(["ledger gap"], false, ExecutionPath.DirectSettlement)).toBe(true);
  });

  it("passes when anomalies were flagged and routed to arbitration", () => {
    expect(detectAnomalySuppression(["ledger gap"], false, ExecutionPath.ArbitrationEscrow)).toBe(false);
  });
});
