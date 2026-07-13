import { describe, it, expect } from "vitest";
import { extractJson, coercePayload } from "./providers";
import { ExecutionPath } from "../../lexguard/types";

describe("extractJson", () => {
  it("parses a direct JSON object", () => {
    expect(extractJson('{"totalHeld":5000}').totalHeld).toBe(5000);
  });
  it("unwraps an Anthropic messages response", () => {
    const raw = JSON.stringify({ content: [{ text: '{"totalHeld":42}' }] });
    expect(extractJson(raw).totalHeld).toBe(42);
  });
  it("unwraps an OpenAI chat response", () => {
    const raw = JSON.stringify({ choices: [{ message: { content: '{"totalHeld":7}' } }] });
    expect(extractJson(raw).totalHeld).toBe(7);
  });
  it("finds a JSON block embedded in prose", () => {
    expect(extractJson('Sure! {"totalHeld": 9} — done.').totalHeld).toBe(9);
  });
  it("returns an empty object for junk", () => {
    expect(extractJson("not json at all")).toEqual({});
  });
});

describe("coercePayload", () => {
  it("coerces money strings and types into a payload", () => {
    const p = coercePayload({
      clientId: "C-1",
      totalHeld: "$5,000.00",
      earnedFees: 800,
      unearnedBalance: "4200",
      recommendedPath: "ArbitrationEscrow",
      signaturesVerified: true,
      clientName: "Jane Anderson",
      barNumberInDocument: "123456",
      anomaliesFlagged: ["ledger gap"],
    });
    expect(p.totalHeld).toBe(5000);
    expect(p.earnedFees).toBe(800);
    expect(p.unearnedBalance).toBe(4200);
    expect(p.recommendedPath).toBe(ExecutionPath.ArbitrationEscrow);
    expect(p.clientName).toBe("Jane Anderson");
    expect(p.extractedBarNumber).toBe("123456");
    expect(p.anomaliesFlagged).toEqual(["ledger gap"]);
  });

  it("defaults missing fields safely (no floats leaking as NaN)", () => {
    const p = coercePayload({});
    expect(p.totalHeld).toBe(0);
    expect(p.earnedFees).toBe(0);
    expect(p.recommendedPath).toBe(ExecutionPath.DirectSettlement);
    expect(p.clientName).toBeUndefined();
    expect(p.extractedBarNumber).toBeNull();
    expect(p.anomaliesFlagged).toEqual([]);
  });
});
